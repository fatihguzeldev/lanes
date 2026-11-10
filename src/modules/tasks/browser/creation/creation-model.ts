import type { CreateTask, TaskPatch } from '../../contracts/task';

export interface CreationIntent {
  patch: TaskPatch;
  baselineBlockedBy?: readonly string[];
  expectedGraphRevision?: number;
  completed?: boolean;
  deleted?: boolean;
}
export type CreationResult =
  | boolean
  | 'cancelled'
  | { saved: true; operationId?: string }
  | {
      saved: false;
      message: string;
      operationId?: string;
      rejected?: boolean;
    };
export interface PendingTaskCreation {
  id: number;
  input: CreateTask;
  confirmedAfter: number | null;
  completed?: boolean;
  deleted?: boolean;
  resolvedTaskId?: string;
  editing?: boolean;
  controls?: {
    disabled?: boolean;
    onEdit(): void;
    onStar(starred: boolean): void;
    onComplete(completed: boolean): void;
    onDelete(): void;
  };
  failure?: { message: string; onEdit(): void; onDiscard(): void; actionLabel?: string };
}
export function creationAcknowledged(
  creation: PendingTaskCreation,
  readVersion?: number,
  orderReadyTaskIds: readonly string[] = [],
  orderReadyListIds: readonly string[] = [],
) {
  return (
    creation.confirmedAfter !== null &&
    !creation.editing &&
    (readVersion ?? -1) > creation.confirmedAfter &&
    !!creation.resolvedTaskId &&
    (orderReadyTaskIds.includes(creation.resolvedTaskId) ||
      orderReadyListIds.includes(creation.input.listId))
  );
}
