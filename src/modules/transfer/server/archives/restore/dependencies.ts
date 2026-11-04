import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { AccountsPortability } from '../../../../accounts/server/connections/portability';
import type { BoardService } from '../../../../boards/server/boards/service';
import type { BoardTemplateService } from '../../../../boards/server/templates/definitions';
import type { TemplateScheduleService } from '../../../../boards/server/templates/schedules';
import type { HistoryService } from '../../../../history/server/events/event-store';
import type { OperationStore } from '../../../../operations/server/journal/store';
import type { TaskCommandService } from '../../../../tasks/server/commands/service';
import type { TaskMetadataService } from '../../../../tasks/server/metadata/tasks';
import type { TaskSnapshotReader } from '../../../../tasks/server/queries/snapshot-reader';
import type { TaskQueries } from '../../../../tasks/server/queries/tasks';
import type { TemplateDocumentStore } from '../../../../tasks/server/templates/documents';
import type { ListTemplateService } from '../../../../tasks/server/templates/definitions';
import { WorkspaceArchiveStore } from '../import/store';

export interface RestoreOwners {
  boards: BoardService;
  metadata: TaskMetadataService;
  documents?: TemplateDocumentStore;
  listTemplates?: ListTemplateService;
  boardTemplates?: BoardTemplateService;
  schedules?: TemplateScheduleService;
}

export interface ArchiveRestoreOptions {
  store: WorkspaceArchiveStore;
  accounts: AccountsPortability;
  queries: TaskQueries;
  snapshotReader: TaskSnapshotReader;
  commands: TaskCommandService;
  operations: OperationStore;
  boards: BoardService;
  history: HistoryService;
  ownerFactory: (
    commitWrites: (writes: D1PreparedStatement[]) => Promise<D1Result[]>,
  ) => RestoreOwners;
  now?: () => number;
}
