import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { HistoryService } from '../../../history/server/events/event-store';
import type { OperationRecord } from '../../../operations/server/journal/context';
import { OperationStore } from '../../../operations/server/journal/store';
import type { TaskList } from '../../contracts/task';
import type { TaskMetadataService } from '../metadata/tasks';
import type { TaskProjectionStore } from '../projection/store';
import type { GoogleTasksClient } from '../provider/google-tasks';
import { TaskQueries } from '../queries/tasks';
export interface TaskCommandOptions {
  operations: OperationStore;
  projection: TaskProjectionStore;
  history: HistoryService;
  metadata?: TaskMetadataService;
  queries?: TaskQueries;
  clientFor(accountId: string): Promise<GoogleTasksClient>;
  remainingProviderRequests?(): number;
  providerOrderRefreshWrites?(accountId: string, listIds: readonly string[]): D1PreparedStatement[];
  refreshRejectedToken?(accountId: string, client: GoogleTasksClient): Promise<void>;
  validateBoardTarget?(
    accountId: string,
    boardId: string,
    revision?: number,
    operationId?: string,
  ): Promise<void>;
  placementWrites?(
    list: TaskList,
    boardId: string,
    appearance?: { color?: string },
  ): D1PreparedStatement[];
  copyBeginWrites?(accountId: string, operationId: string): Promise<D1PreparedStatement[]>;
  confirmedTaskDeletionWrites?(
    accountId: string,
    operationId: string,
    taskId: string,
  ): D1PreparedStatement[];
  taskDeletionDispatchGuards?(
    accountId: string,
    operationId: string,
    taskId: string,
  ): D1PreparedStatement[];
  listAppearanceSnapshot?(accountId: string, listId: string): Promise<{ color: string }>;
  listRemovalWrites?(accountId: string, listId: string): D1PreparedStatement[];
  boardTargetGuard?(accountId: string, boardId: string, revision?: number): D1PreparedStatement;
  placementResult?(
    accountId: string,
    listId: string,
    requestedBoardId: string,
  ): Promise<{ boardId: string; fellBack: boolean }>;
  placementSettlementWrites?(
    accountId: string,
    listId: string,
    requestedBoardId: string,
    operationId: string,
  ): D1PreparedStatement[];
  now?: () => number;
  id?: () => string;
}

export interface CommandAdvance {
  operation: OperationRecord;
  advanced: boolean;
}
