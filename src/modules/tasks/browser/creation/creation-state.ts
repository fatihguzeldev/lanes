import type { CreateTask, Task, TaskPatch } from '../../contracts/task';
import type { CreationIntent, PendingTaskCreation } from './creation-model';

export interface CreationRecord extends PendingTaskCreation {
  submittedInput: CreateTask;
  appliedInput: CreateTask;
  appliedCompleted?: boolean;
  confirmedFollowup?: { operationId?: string };
  onEdit?(input: CreateTask): void;
  operationId?: string;
  expectedGraphRevision?: number;
  blockedFollowup?: {
    intent: CreationIntent;
    input: CreateTask;
    task: Task;
    expectedGraphRevision?: number;
    operationId?: string;
    rejected?: boolean;
  };
}

export const editableFields = [
  'title',
  'notes',
  'scheduledDay',
  'scheduledTime',
  'timeZone',
  'repeatRule',
  'labelIds',
  'priority',
  'starred',
  'blockedBy',
] as const;
export function sameField(field: string, left: unknown, right: unknown) {
  const normalize = (value: unknown) =>
    (field === 'labelIds' || field === 'blockedBy') && Array.isArray(value)
      ? [...value].sort()
      : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
export function intentConfirmed(task: Task, intent: CreationIntent) {
  return (
    Object.entries(intent.patch).every(([field, value]) =>
      sameField(field, task[field as keyof Task], value),
    ) &&
    (intent.completed === undefined || task.completed === intent.completed)
  );
}
export function intentFor(task: Task, creation: CreationRecord): CreationIntent {
  const patch: TaskPatch = {};
  for (const field of editableFields) {
    if (
      creation.input[field] !== undefined &&
      !sameField(field, creation.input[field], creation.appliedInput[field]) &&
      !sameField(field, creation.input[field], task[field])
    )
      Object.assign(patch, { [field]: structuredClone(creation.input[field]) });
  }
  // Each receipt confirms one phase; later intent stays unsent until that phase is known.
  if (Object.keys(patch).length)
    return {
      patch,
      ...(patch.blockedBy === undefined
        ? {}
        : { baselineBlockedBy: [...creation.appliedInput.blockedBy] }),
      ...(patch.blockedBy !== undefined && creation.expectedGraphRevision !== undefined
        ? { expectedGraphRevision: creation.expectedGraphRevision }
        : {}),
    };
  if (
    creation.completed !== undefined &&
    creation.completed !== creation.appliedCompleted &&
    creation.completed !== task.completed
  )
    return { patch: {}, completed: creation.completed };
  return { patch: {}, ...(creation.deleted ? { deleted: true } : {}) };
}
export function applyConfirmedPhase(
  creation: CreationRecord,
  input: CreateTask,
  intent: CreationIntent,
  operationId?: string,
): CreationRecord {
  const { blockedFollowup: _blocked, failure: _failure, ...saved } = creation;
  return {
    ...saved,
    appliedInput: structuredClone(input),
    ...(intent.completed === undefined ? {} : { appliedCompleted: intent.completed }),
    confirmedFollowup: operationId ? { operationId } : {},
  };
}
