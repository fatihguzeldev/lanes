import { useCallback, useRef, useState } from 'react';
import type { CreateTask, Task, TaskPatch } from '../../contracts/task';
import { readCreatedTask } from './creation-receipt';
import { readTask } from '../queries/references';
import { RequestError } from '../../../../shared/browser/http/http';

export interface CreationIntent {
  patch: TaskPatch;
  completed?: boolean;
  deleted?: boolean;
}
export type CreationResult = boolean | 'cancelled';
export interface PendingTaskCreation {
  id: number;
  input: CreateTask;
  confirmedAfter: number | null;
  completed?: boolean;
  deleted?: boolean;
  resolvedTaskId?: string;
  controls?: {
    disabled?: boolean;
    onEdit(): void;
    onStar(starred: boolean): void;
    onComplete(completed: boolean): void;
    onDelete(): void;
  };
  failure?: { message: string; onEdit(): void; onDiscard(): void; actionLabel?: string };
}
interface CreationOptions {
  editable?: boolean;
  onReady?(task: Task, intent: CreationIntent): Promise<CreationResult>;
  onChanged?(): void;
  onError?(message: string, operationId?: string): void;
  onInspect?(operationId: string): void;
}
interface CreationRecord extends PendingTaskCreation {
  submittedInput: CreateTask;
  appliedInput: CreateTask;
  onEdit?(input: CreateTask): void;
  operationId?: string;
  replayBlocked?: boolean;
}

export function creationAcknowledged(creation: PendingTaskCreation, readVersion?: number) {
  return creation.confirmedAfter !== null && (readVersion ?? -1) > creation.confirmedAfter;
}
const editableFields = [
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
function intentFor(task: Task, creation: CreationRecord): CreationIntent {
  const patch: TaskPatch = {};
  for (const field of editableFields) {
    if (
      creation.input[field] !== undefined &&
      JSON.stringify(creation.input[field]) !== JSON.stringify(creation.appliedInput[field]) &&
      JSON.stringify(creation.input[field]) !== JSON.stringify(task[field])
    )
      Object.assign(patch, { [field]: structuredClone(creation.input[field]) });
  }
  return {
    patch,
    ...(creation.completed !== undefined && creation.completed !== task.completed
      ? { completed: creation.completed }
      : {}),
    ...(creation.deleted ? { deleted: true } : {}),
  };
}

/** The immutable create owns admission; later local intent waits for its confirmed task identity. */
export function useTaskCreations(
  accountId: string,
  version: number,
  options: CreationOptions = {},
) {
  const [records, setRecords] = useState<CreationRecord[]>([]);
  const current = useRef(records);
  const currentVersion = useRef(version);
  const currentAccount = useRef(accountId);
  const listeners = useRef(options);
  const flights = useRef(new Map<number, Promise<void>>());
  const restart = useRef<(id: number, operationId: string) => Promise<void>>(async () => {});
  currentVersion.current = version;
  currentAccount.current = accountId;
  listeners.current = options;
  const change = useCallback((update: (items: CreationRecord[]) => CreationRecord[]) => {
    current.current = update(current.current);
    setRecords(current.current);
  }, []);
  const remove = useCallback(
    (id: number) => {
      change((items) => items.filter((item) => item.id !== id));
    },
    [change],
  );
  const confirm = useCallback(
    (id: number) => {
      change((items) =>
        items.map((item) =>
          item.id === id && item.confirmedAfter === null
            ? { ...item, confirmedAfter: currentVersion.current }
            : item,
        ),
      );
    },
    [change],
  );
  const start = useCallback(
    (id: number, input: CreateTask, onEdit?: (input: CreateTask) => void) => {
      if (input.accountId !== accountId) return;
      const captured = structuredClone(input);
      change((items) => [
        {
          id,
          input: captured,
          submittedInput: structuredClone(captured),
          appliedInput: structuredClone(captured),
          confirmedAfter: null,
          ...(onEdit ? { onEdit } : {}),
        },
        ...items.filter((item) => item.id !== id),
      ]);
    },
    [accountId, change],
  );
  const update = useCallback(
    (id: number, input: CreateTask) => {
      if (listeners.current.editable === false) return;
      change((items) =>
        items.map((item) =>
          item.id === id &&
          input.accountId === accountId &&
          input.listId === item.submittedInput.listId &&
          input.parentId === item.submittedInput.parentId
            ? { ...item, input: structuredClone(input), confirmedAfter: null }
            : item,
        ),
      );
      const creation = current.current.find((item) => item.id === id);
      if (creation?.operationId) void restart.current(id, creation.operationId);
    },
    [accountId, change],
  );
  const fail = useCallback(
    (id: number, message: string, onEdit: () => void) => {
      change((items) =>
        items.map((item) =>
          item.id === id
            ? { ...item, failure: { message, onEdit, onDiscard: () => remove(id) } }
            : item,
        ),
      );
    },
    [change, remove],
  );
  const finish = useCallback(
    (id: number, operationId: string): Promise<void> => {
      const running = flights.current.get(id);
      if (running) return running;
      const work = (async () => {
        const captured = current.current.find((item) => item.id === id);
        if (!captured || captured.input.accountId !== accountId) return;
        change((items) => items.map((item) => (item.id === id ? { ...item, operationId } : item)));
        try {
          let task = await readCreatedTask(
            accountId,
            operationId,
            captured.submittedInput,
            (taskId) => {
              if (currentAccount.current !== accountId) return;
              change((items) =>
                items.map((item) => (item.id === id ? { ...item, resolvedTaskId: taskId } : item)),
              );
            },
          );
          if (currentAccount.current !== accountId) return;
          change((items) =>
            items.map((item) => (item.id === id ? { ...item, resolvedTaskId: task.id } : item)),
          );
          while (true) {
            const creation = current.current.find((item) => item.id === id);
            if (!creation || currentAccount.current !== accountId) return;
            if (creation.replayBlocked)
              throw new Error('this new task still has a change that needs checking.');
            const intent = intentFor(task, creation);
            const hasChange =
              Object.keys(intent.patch).length > 0 ||
              intent.completed !== undefined ||
              intent.deleted;
            if (!hasChange) break;
            let result: CreationResult;
            try {
              result = (await listeners.current.onReady?.(task, intent)) ?? false;
            } catch (error) {
              change((items) =>
                items.map((item) => (item.id === id ? { ...item, replayBlocked: true } : item)),
              );
              throw error;
            }
            if (result === 'cancelled' && intent.deleted) {
              change((items) =>
                items.map((item) => (item.id === id ? { ...item, deleted: false } : item)),
              );
              task = await readTask(accountId, task.id);
              if (task.accountId !== accountId || task.listId !== captured.input.listId)
                throw new Error('the saved task moved before its queued changes finished.');
              continue;
            }
            if (!result) {
              change((items) =>
                items.map((item) => (item.id === id ? { ...item, replayBlocked: true } : item)),
              );
              throw new Error(
                'a change to this new task could not be confirmed. check its save before continuing.',
              );
            }
            if (intent.deleted) {
              remove(id);
              listeners.current.onChanged?.();
              return;
            }
            task = await readTask(accountId, task.id);
            if (task.accountId !== accountId || task.listId !== captured.input.listId)
              throw new Error('the saved task moved before its queued changes finished.');
            if (
              Object.entries(intent.patch).some(
                ([field, value]) =>
                  JSON.stringify(task[field as keyof Task]) !== JSON.stringify(value),
              ) ||
              (intent.completed !== undefined && task.completed !== intent.completed)
            ) {
              change((items) =>
                items.map((item) => (item.id === id ? { ...item, replayBlocked: true } : item)),
              );
              throw new Error('the new task’s latest values do not confirm its queued change yet.');
            }
            change((items) =>
              items.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      appliedInput: structuredClone(creation.input),
                    }
                  : item,
              ),
            );
          }
          change((items) =>
            items.map((item) => {
              if (item.id !== id) return item;
              const { failure: _failure, replayBlocked: _blocked, ...saved } = item;
              return saved;
            }),
          );
          confirm(id);
          listeners.current.onChanged?.();
        } catch (error) {
          if (currentAccount.current !== accountId) return;
          const message =
            error instanceof Error ? error.message : 'the new task’s save needs checking.';
          const failedOperationId = error instanceof RequestError ? error.operationId : undefined;
          const failedCreation = current.current.find((item) => item.id === id);
          const failedDeletion = failedCreation?.replayBlocked && failedCreation.deleted;
          change((items) =>
            items.map((item) =>
              item.id === id
                ? {
                    ...item,
                    ...(item.deleted ? { deleted: false } : {}),
                    failure: {
                      message,
                      actionLabel:
                        failedDeletion && !failedOperationId ? 'show task' : 'check save',
                      onEdit: failedDeletion
                        ? failedOperationId
                          ? () => {
                              if (listeners.current.onInspect)
                                listeners.current.onInspect(failedOperationId);
                              else listeners.current.onError?.(message, failedOperationId);
                            }
                          : () => {
                              remove(id);
                              listeners.current.onChanged?.();
                            }
                        : () => void finish(id, operationId),
                      onDiscard: () => {
                        remove(id);
                        if (failedDeletion) listeners.current.onChanged?.();
                      },
                    },
                  }
                : item,
            ),
          );
          listeners.current.onError?.(message, failedDeletion ? failedOperationId : operationId);
        }
      })();
      flights.current.set(id, work);
      void work.finally(() => {
        if (flights.current.get(id) !== work) return;
        flights.current.delete(id);
        const latest = current.current.find((item) => item.id === id);
        if (
          currentAccount.current === accountId &&
          latest?.confirmedAfter === null &&
          !latest.failure &&
          latest.operationId
        )
          void restart.current(id, latest.operationId);
      });
      return work;
    },
    [accountId, change, confirm, remove],
  );
  restart.current = finish;
  const hold = (id: number, operationId: string, message: string) => {
    change((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              operationId,
              failure: {
                message,
                actionLabel: 'check save',
                onEdit: () => void finish(id, operationId),
                onDiscard: () => remove(id),
              },
            }
          : item,
      ),
    );
  };
  const acknowledge = (id: number) => {
    const creation = current.current.find((item) => item.id === id);
    const observed = records.find((item) => item.id === id);
    if (
      creation &&
      observed &&
      creation.confirmedAfter !== null &&
      !creation.failure &&
      creation.confirmedAfter === observed.confirmedAfter &&
      creation.input === observed.input &&
      creation.completed === observed.completed &&
      creation.deleted === observed.deleted
    )
      remove(id);
  };
  const modify = (id: number, update: (item: CreationRecord) => CreationRecord) => {
    if (listeners.current.editable === false) return;
    change((items) => items.map((item) => (item.id === id ? update(item) : item)));
    const creation = current.current.find((item) => item.id === id);
    if (creation?.operationId) void finish(id, creation.operationId);
  };
  const items: PendingTaskCreation[] = records.map((creation) => ({
    ...creation,
    ...(creation.failure
      ? {}
      : {
          controls: {
            disabled: options.editable === false,
            onEdit: () => {
              if (listeners.current.editable === false) return;
              creation.onEdit?.(
                structuredClone(
                  current.current.find((item) => item.id === creation.id)?.input ?? creation.input,
                ),
              );
            },
            onStar: (starred: boolean) =>
              modify(creation.id, (item) => ({
                ...item,
                input: { ...item.input, starred },
                confirmedAfter: null,
              })),
            onComplete: (completed: boolean) =>
              modify(creation.id, (item) => ({ ...item, completed, confirmedAfter: null })),
            onDelete: () =>
              modify(creation.id, (item) => ({ ...item, deleted: true, confirmedAfter: null })),
          },
        }),
  }));
  return {
    items,
    start,
    update,
    confirm,
    remove,
    fail,
    finish,
    hold,
    acknowledge,
    busy: records.some((item) => item.confirmedAfter === null && !item.failure),
    hasDrafts: records.some((item) => !!item.failure),
    discardDrafts: () => change((items) => items.filter((item) => !item.failure)),
  };
}
export type TaskCreationController = ReturnType<typeof useTaskCreations>;
