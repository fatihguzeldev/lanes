import { assertLocalWritable } from '../../modules/accounts/server/connections/access';
import { createAccountServices } from '../../modules/accounts/server/create-services';
import { ProviderAccess } from '../../modules/accounts/server/credentials/provider-access';
import { AccountLifecycle } from '../../modules/accounts/server/lifecycle/coordinator';
import { BoardProjection } from '../../modules/boards/server/boards/projection';
import { BoardService } from '../../modules/boards/server/boards/service';
import { BoardLifecycle } from '../../modules/boards/server/lifecycle/account';
import { HistoryService } from '../../modules/history/server/events/event-store';
import { TaskCommandService } from '../../modules/tasks/server/commands/service';
import { CompletedTaskDeletionService } from '../../modules/tasks/server/completed-deletion/service';
import { TasksLifecycle } from '../../modules/tasks/server/lifecycle/account';
import { LabelDeletionWork } from '../../modules/tasks/server/metadata/label-work';
import { TaskMetadataService } from '../../modules/tasks/server/metadata/tasks';
import { TaskProjectionStore } from '../../modules/tasks/server/projection/store';
import { GoogleTasksClient } from '../../modules/tasks/server/provider/google-tasks';
import { TaskQueries } from '../../modules/tasks/server/queries/tasks';
import { RecurrenceService } from '../../modules/tasks/server/recurrence/service';
import { TaskSyncService } from '../../modules/tasks/server/sync/service';
import { TransferLifecycle } from '../../modules/transfer/server/lifecycle/lifecycle';
import {
  GOOGLE_SHEETS_EXPORT_SCOPE,
  GoogleSheetsClient,
} from '../../modules/transfer/server/sheets/provider';
import { AppError } from '../../shared/contracts/errors';
import type { Configuration, Env } from '../configuration/env';
import { googleTransport } from '../transport/google-transport';
import { createOperationStore } from './operation-store';
import {
  createTemplateOwners,
  type CommitTemplateWrites,
  type TemplateOwners,
} from './template-services';
import { createTransferOwners } from './transfer-services';

/** Invocation-local composition. Durable owners hold every execution claim. */
export function createServices(
  env: Env,
  config: Configuration,
  providerRequestLimit: 4 | 10 = 4,
  databaseQueries?: () => number,
) {
  const budget = googleTransport(providerRequestLimit);
  const accounts = createAccountServices(env.DB, config, { fetch: budget.fetch });
  let templates: TemplateOwners;
  let completedDeletion: CompletedTaskDeletionService;
  const boards = new BoardService(env.DB, {
    assertLocalWritable: (id) => assertLocalWritable(env.DB, id),
    onDeleteWrites: (account, board) => templates.schedules.pauseBoardWrites(account, board),
  });
  const boardProjection = new BoardProjection(env.DB, boards);
  const boardListSelection = (accountId: string, boardId: string) =>
    boardProjection.listSelection(accountId, boardId);
  const history = new HistoryService(env.DB, { boardListSelection });
  const operations = createOperationStore(env.DB);
  let taskLifecycle: TasksLifecycle, transferLifecycle: TransferLifecycle;
  const access = new ProviderAccess(env.DB, config, {
    fetch: budget.fetch,
    pendingProviderWork: async (accountId) => {
      if (await transferLifecycle.pendingProviderWork(accountId)) return true;
      return taskLifecycle.pendingProviderWork(accountId);
    },
  });
  const observedTokens = new WeakMap<object, { accountId: string; revision: number }>();
  const clientFor = async (accountId: string) => {
    const token = await access.getAccessToken(accountId);
    const client = new GoogleTasksClient({ accessToken: token.accessToken, fetch: budget.fetch });
    observedTokens.set(client, { accountId, revision: token.tokenRevision });
    return client;
  };
  const refreshRejectedToken = async (accountId: string, client: object) => {
    const observed = observedTokens.get(client);
    if (!observed || observed.accountId !== accountId)
      throw new AppError('conflict', 'this access token belongs to a different request.', 409);
    await access.getAccessToken(accountId, {
      forceRefresh: true,
      observedTokenRevision: observed.revision,
    });
  };
  const sheetsClientFor = async (accountId: string, scope = GOOGLE_SHEETS_EXPORT_SCOPE) => {
    const token = await access.getAccessToken(accountId, { requiredScopes: [scope] });
    const client = new GoogleSheetsClient({ accessToken: token.accessToken, fetch: budget.fetch });
    observedTokens.set(client, { accountId, revision: token.tokenRevision });
    return client;
  };
  const placementWrites = boardProjection.placementWrites.bind(boardProjection);
  const removalWrites = boardProjection.removalWrites.bind(boardProjection);
  const queries = new TaskQueries(env.DB, { boardListSelection });
  const projection = new TaskProjectionStore(env.DB, { history });
  const metadata = new TaskMetadataService(env.DB, {
    history,
    commitWrites: async () => {
      throw new AppError('conflict', 'metadata writes require a captured operation.', 409);
    },
  });
  const labelWork = new LabelDeletionWork(env.DB, history);
  const sync = new TaskSyncService(env.DB, {
    clientFor,
    history,
    placementWrites,
    removalWrites,
    refreshRejectedToken,
    ...(databaseQueries ? { databaseQueries } : {}),
    providerRequests: () => budget.used,
  });
  const commands = new TaskCommandService(env.DB, {
    operations,
    projection,
    metadata,
    history,
    queries,
    clientFor,
    refreshRejectedToken,
    remainingProviderRequests: () => Math.max(0, 4 - budget.used),
    providerOrderRefreshWrites: sync.providerOrderRefreshWrites.bind(sync),
    validateBoardTarget: async (accountId, boardId, revision, operationId) => {
      let board;
      try {
        board = await boards.queries.getBoard(accountId, boardId);
      } catch (error) {
        if (error instanceof AppError && error.code === 'not_found' && operationId)
          return templates.applications.validatePendingBoardTarget(
            accountId,
            boardId,
            revision,
            operationId,
          );
        throw error;
      }
      if (revision !== undefined && board.revision !== revision)
        throw new AppError(
          'conflict',
          'this destination board changed. choose its destination again.',
          409,
        );
    },
    placementWrites: boardProjection.creationWrites.bind(boardProjection),
    listRemovalWrites: removalWrites,
    boardTargetGuard: boardProjection.targetGuard.bind(boardProjection),
    placementResult: boardProjection.placementResult.bind(boardProjection),
    listAppearanceSnapshot: boardProjection.appearanceSnapshot.bind(boardProjection),
    placementSettlementWrites: (accountId, _listId, requestedBoardId, operationId) =>
      operations.prepareStopRemainingWrites(
        operationId,
        boardProjection.targetMissingPredicate(accountId, requestedBoardId),
      ),
    taskDeletionDispatchGuards: (accountId, operationId, taskId) =>
      completedDeletion.prepareDispatchGuards(accountId, operationId, taskId),
    confirmedTaskDeletionWrites: (accountId, operationId, taskId) =>
      completedDeletion.prepareConfirmedDeletionWrites(accountId, operationId, taskId),
    copyBeginWrites: (accountId, operationId) =>
      templates.applications.prepareBeginWrites(accountId, operationId),
  });
  const templateOwners = (commitWrites?: CommitTemplateWrites) =>
    createTemplateOwners(
      env.DB,
      {
        boards,
        commands,
        operations,
        ownerSubjectFor: () => accounts.sessions.requireInstallationOwnerSubject(),
      },
      commitWrites,
    );
  templates = templateOwners();
  const recurrence = new RecurrenceService(env.DB, {
    commands,
    operations,
    ownerSubjectFor: () => accounts.sessions.requireInstallationOwnerSubject(),
    requestTaskCheck: sync.requestTaskCheck.bind(sync),
  });
  const transfer = createTransferOwners(env.DB, {
    boards,
    commands,
    operations,
    queries,
    history,
    templates,
    graphRevision: (accountId) => metadata.getGraphRevision(accountId),
    ownerSubjectFor: () => accounts.sessions.requireInstallationOwnerSubject(),
    sheetsClientFor,
    refreshRejectedToken,
    remainingProviderRequests: () => Math.max(0, 4 - budget.used),
  });
  completedDeletion = new CompletedTaskDeletionService(env.DB, { commands, operations });
  taskLifecycle = new TasksLifecycle(env.DB, { operations, commands, completedDeletion });
  transferLifecycle = new TransferLifecycle(env.DB, {
    operations,
    snapshots: transfer.snapshotReader,
    sheets: transfer.sheetsExports,
    archiveExports: transfer.archiveExports,
    documents: transfer.documents,
  });
  const lifecycle = new AccountLifecycle(env.DB, {
    access,
    owners: [
      transferLifecycle,
      new BoardLifecycle(env.DB, templates.snapshots),
      taskLifecycle,
      {
        name: 'history',
        pause: async () => ({ done: true, pending: false }),
        hasUnresolved: async () => false,
        remove: history.cleanupAccountSlice.bind(history),
      },
    ],
  });
  return {
    accounts,
    boards,
    boardProjection,
    history,
    operations,
    access,
    queries,
    projection,
    metadata,
    sync,
    commands,
    recurrence,
    clientFor,
    sheetsClientFor,
    refreshRejectedToken,
    budget,
    templates,
    templateOwners,
    transfer,
    lifecycle,
    labelWork,
    completedDeletion,
  };
}

export type Services = ReturnType<typeof createServices>;
