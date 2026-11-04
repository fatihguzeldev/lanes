import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { assertLocalWritable } from '../../modules/accounts/server/connections/access';
import { AccountsPortability } from '../../modules/accounts/server/connections/portability';
import { BoardService } from '../../modules/boards/server/boards/service';
import { HistoryService } from '../../modules/history/server/events/event-store';
import type { OperationStore } from '../../modules/operations/server/journal/store';
import type { TaskCommandService } from '../../modules/tasks/server/commands/service';
import { TaskMetadataService } from '../../modules/tasks/server/metadata/tasks';
import { readActiveLists } from '../../modules/tasks/server/queries/lists';
import { TaskSnapshotReader } from '../../modules/tasks/server/queries/snapshot-reader';
import type { TaskQueries } from '../../modules/tasks/server/queries/tasks';
import { TemplateDocumentStore } from '../../modules/tasks/server/templates/documents';
import { AccountTransferService } from '../../modules/transfer/server/account-copy/account-transfer';
import { ArchiveSnapshotCopyService } from '../../modules/transfer/server/archives/archive-copy';
import { ArchiveExportService } from '../../modules/transfer/server/archives/archive-export';
import { ArchiveRestoreService } from '../../modules/transfer/server/archives/archive-restore';
import { WorkspaceArchiveStore } from '../../modules/transfer/server/archives/archive-store';
import { TaskCsvExportService } from '../../modules/transfer/server/exports/csv-export';
import { TransferImportService } from '../../modules/transfer/server/imports/imports';
import { TransferRetention } from '../../modules/transfer/server/lifecycle/retention';
import type { GoogleSheetsClient } from '../../modules/transfer/server/sheets/sheets';
import { SheetsExportService } from '../../modules/transfer/server/sheets/sheets-export';
import { AppError } from '../../shared/contracts/errors';
import { createTemplateOwners, type TemplateOwners } from './template-services';
interface Dependencies {
  boards: BoardService;
  commands: TaskCommandService;
  operations: OperationStore;
  queries: TaskQueries;
  history: HistoryService;
  templates: TemplateOwners;
  graphRevision: (accountId: string) => Promise<number>;
  ownerSubjectFor: () => Promise<string>;
  sheetsClientFor: (accountId: string) => Promise<GoogleSheetsClient>;
  refreshRejectedToken: (accountId: string, client: GoogleSheetsClient) => Promise<void>;
  remainingProviderRequests: () => number;
}
export function createTransferOwners(db: D1Database, dependencies: Dependencies) {
  const portableAccounts = new AccountsPortability(db),
    snapshotReader = new TaskSnapshotReader(db);
  const imports = new TransferImportService(db, {
    commands: dependencies.commands,
    operations: dependencies.operations,
    prepareSourceCaptureGuards: (manifest) =>
      manifest.source.kind === 'account'
        ? snapshotReader.prepareCaptureGuards(manifest.source.snapshotId, manifest.source.accountId)
        : Promise.resolve([]),
  });
  const accountTransfers = new AccountTransferService(db, {
    snapshots: snapshotReader,
    imports,
    destinationMainBoard: (account) => dependencies.boards.queries.getMainBoard(account),
    labelsByNames: (account, names) =>
      dependencies.queries.labels.readLabelsByNames(account, names),
  });
  const rowOptions = {
    queries: dependencies.queries,
    readLists: (account: string, ids: readonly string[]) => readActiveLists(db, account, ids),
  };
  const csv = new TaskCsvExportService(rowOptions);
  const sheetsExports = new SheetsExportService(db, {
    ...rowOptions,
    operations: dependencies.operations,
    clientFor: dependencies.sheetsClientFor,
    refreshRejectedToken: dependencies.refreshRejectedToken,
    remainingProviderRequests: dependencies.remainingProviderRequests,
  });
  const archives = new WorkspaceArchiveStore(db, {
    identity: (account) => portableAccounts.identity(account),
  });
  const ownerFactory = (commitWrites: (writes: D1PreparedStatement[]) => Promise<D1Result[]>) => {
    let templates: TemplateOwners;
    const boards = new BoardService(db, {
      assertLocalWritable: (account) => assertLocalWritable(db, account),
      commitWrites,
      onDeleteWrites: (account, board) => templates.schedules.pauseBoardWrites(account, board),
    });
    templates = createTemplateOwners(
      db,
      {
        boards,
        commands: dependencies.commands,
        operations: dependencies.operations,
        ownerSubjectFor: dependencies.ownerSubjectFor,
      },
      commitWrites,
    );
    return {
      boards,
      metadata: new TaskMetadataService(db, { history: dependencies.history, commitWrites }),
      documents: new TemplateDocumentStore(db, { snapshots: templates.snapshots, commitWrites }),
      listTemplates: templates.listTemplates,
      boardTemplates: templates.boardTemplates,
      schedules: templates.schedules,
    };
  };
  const restore = new ArchiveRestoreService(db, {
    store: archives,
    accounts: portableAccounts,
    queries: dependencies.queries,
    snapshotReader,
    commands: dependencies.commands,
    operations: dependencies.operations,
    boards: dependencies.boards,
    history: dependencies.history,
    ownerFactory,
  });
  const archiveCopy = new ArchiveSnapshotCopyService(db, { store: archives, imports });
  const archiveExports = new ArchiveExportService(db, {
    identity: portableAccounts.identity.bind(portableAccounts),
    boardQueries: dependencies.boards.queries,
    queries: dependencies.queries,
    references: snapshotReader,
    graphRevision: dependencies.graphRevision,
    listTemplates: dependencies.templates.listTemplates,
    boardTemplates: dependencies.templates.boardTemplates,
    snapshots: dependencies.templates.snapshots,
    schedules: dependencies.templates.schedules,
    history: dependencies.history,
  });
  const documents = new TemplateDocumentStore(db, {
    snapshots: dependencies.templates.snapshots,
    commitWrites: async () => {
      throw new AppError('conflict', 'document changes require their captured operation.', 409);
    },
  });
  const retention = new TransferRetention(db, {
    operationQueries: dependencies.operations.queries,
    snapshots: snapshotReader,
    documents,
    sheets: sheetsExports,
    archiveExports,
  });
  return {
    imports,
    accountTransfers,
    csv,
    sheetsExports,
    archives,
    restore,
    archiveCopy,
    archiveExports,
    snapshotReader,
    portableAccounts,
    documents,
    retention,
  };
}
export type TransferOwners = ReturnType<typeof createTransferOwners>;
