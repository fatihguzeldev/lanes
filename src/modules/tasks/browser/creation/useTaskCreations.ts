import { useCallback, useRef, useState } from 'react';
import type { CreateTask, Task } from '../../contracts/task';
import { readCreatedTask } from './creation-receipt';
import { readTask } from '../queries/references';
import { RequestError } from '../../../../shared/browser/http/http';
import type { OperationSummary } from '../../../operations/contracts/receipt';
import { createCreationSubmissionQueue } from './creation-submission-queue';
import type { CreationIntent, CreationResult, PendingTaskCreation } from './creation-model';
import { intentFor, applyConfirmedPhase, type CreationRecord } from './creation-state';
import { recoverCreationFollowup } from './creation-recovery';

interface CreationOptions {
  editable?: boolean;
  onReady?(task: Task, intent: CreationIntent): Promise<CreationResult>;
  onChanged?(): void;
  onOrderRefresh?(): void;
  onError?(message: string, operationId?: string): void;
  onInspect?(operationId: string): void;
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
  const editors = useRef(new Map<number, Set<symbol>>());
  const submissions = useRef<{
    accountId: string;
    queue: ReturnType<typeof createCreationSubmissionQueue>;
  } | null>(null);
  if (submissions.current?.accountId !== accountId)
    submissions.current = {
      accountId,
      queue: createCreationSubmissionQueue(accountId, () => currentAccount.current === accountId),
    };
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
    (id: number, input: CreateTask, expectedGraphRevision?: number) => {
      const captured = current.current.find((item) => item.id === id);
      if (
        listeners.current.editable === false ||
        !captured ||
        input.accountId !== accountId ||
        input.listId !== captured.submittedInput.listId ||
        input.parentId !== captured.submittedInput.parentId
      )
        return false;
      change((items) =>
        items.map((item) =>
          item.id === id &&
          input.accountId === accountId &&
          input.listId === item.submittedInput.listId &&
          input.parentId === item.submittedInput.parentId
            ? {
                ...item,
                input: structuredClone(input),
                ...(expectedGraphRevision === undefined ? {} : { expectedGraphRevision }),
                confirmedAfter: null,
              }
            : item,
        ),
      );
      const creation = current.current.find((item) => item.id === id);
      if (creation?.operationId) void restart.current(id, creation.operationId);
      return true;
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
    (id: number, operationId: string, inspectBlocked = false): Promise<void> => {
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
          submissions.current?.queue.confirm(id, captured.input.listId);
          change((items) =>
            items.map((item) => (item.id === id ? { ...item, resolvedTaskId: task.id } : item)),
          );
          while (true) {
            const creation = current.current.find((item) => item.id === id);
            if (!creation || currentAccount.current !== accountId) return;
            if (creation.blockedFollowup) {
              const recovered = await recoverCreationFollowup(accountId, task, {
                current: () =>
                  currentAccount.current === accountId
                    ? current.current.find((item) => item.id === id)
                    : undefined,
                update: (transform) => {
                  if (currentAccount.current !== accountId) return;
                  change((items) => items.map((item) => (item.id === id ? transform(item) : item)));
                },
              });
              if (!recovered) return;
              task = recovered;
              continue;
            }
            const phase = creation;
            const intent = intentFor(task, phase);
            const hasChange =
              Object.keys(intent.patch).length > 0 ||
              intent.completed !== undefined ||
              intent.deleted;
            if (!hasChange) {
              change((items) =>
                items.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        appliedInput: structuredClone(phase.input),
                        ...(phase.completed === undefined
                          ? {}
                          : { appliedCompleted: phase.completed }),
                      }
                    : item,
                ),
              );
              break;
            }
            let result: CreationResult = false;
            try {
              result = (await listeners.current.onReady?.(task, intent)) ?? false;
              if (result === false || (typeof result === 'object' && !result.saved))
                throw new RequestError(
                  'creation_followup',
                  typeof result === 'object'
                    ? result.message
                    : 'a change to this new task could not be confirmed. check its save before continuing.',
                  undefined,
                  typeof result === 'object' ? result.operationId : undefined,
                );
            } catch (error) {
              change((items) =>
                items.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        blockedFollowup: {
                          intent: structuredClone(intent),
                          input: structuredClone(phase.input),
                          task: structuredClone(task),
                          ...(typeof result === 'object' &&
                          !result.saved &&
                          result.rejected &&
                          !result.operationId
                            ? { rejected: true }
                            : {}),
                          ...(phase.expectedGraphRevision === undefined
                            ? {}
                            : { expectedGraphRevision: phase.expectedGraphRevision }),
                          ...(error instanceof RequestError && error.operationId
                            ? { operationId: error.operationId }
                            : {}),
                        },
                      }
                    : item,
                ),
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
            if (intent.deleted) {
              remove(id);
              listeners.current.onChanged?.();
              return;
            }
            change((items) =>
              items.map((item) =>
                item.id === id
                  ? applyConfirmedPhase(
                      item,
                      phase.input,
                      intent,
                      typeof result === 'object' ? result.operationId : undefined,
                    )
                  : item,
              ),
            );
            task = await readTask(accountId, task.id);
            if (task.accountId !== accountId || task.listId !== captured.input.listId)
              throw new Error('the saved task moved before its queued changes finished.');
          }
          change((items) =>
            items.map((item) => {
              if (item.id !== id) return item;
              const { failure: _failure, blockedFollowup: _blocked, ...saved } = item;
              return saved;
            }),
          );
          confirm(id);
          listeners.current.onChanged?.();
          listeners.current.onOrderRefresh?.();
        } catch (error) {
          if (currentAccount.current !== accountId) return;
          const message =
            error instanceof Error ? error.message : 'the new task’s save needs checking.';
          const failedCreation = current.current.find((item) => item.id === id);
          const failedOperationId =
            (error instanceof RequestError ? error.operationId : undefined) ??
            failedCreation?.blockedFollowup?.operationId;
          const failedDeletion = failedCreation?.blockedFollowup?.intent.deleted;
          change((items) =>
            items.map((item) =>
              item.id === id
                ? {
                    ...item,
                    ...(item.deleted ? { deleted: false } : {}),
                    failure: {
                      message,
                      actionLabel:
                        failedDeletion && !failedOperationId
                          ? 'show task'
                          : failedCreation?.blockedFollowup?.rejected && failedCreation.onEdit
                            ? 'edit'
                            : 'check save',
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
                        : failedCreation?.blockedFollowup?.rejected && failedCreation.onEdit
                          ? () => {
                              if (listeners.current.editable === false) return;
                              const latest = current.current.find((item) => item.id === id);
                              if (latest) latest.onEdit?.(structuredClone(latest.input));
                            }
                          : () => void finish(id, operationId, true),
                      onDiscard: () => {
                        remove(id);
                        listeners.current.onChanged?.();
                        listeners.current.onOrderRefresh?.();
                      },
                    },
                  }
                : item,
            ),
          );
          const receiptId = failedCreation?.blockedFollowup
            ? failedOperationId
            : failedCreation?.confirmedFollowup
              ? failedCreation.confirmedFollowup.operationId
              : operationId;
          listeners.current.onError?.(message, receiptId);
          if (inspectBlocked && receiptId) listeners.current.onInspect?.(receiptId);
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
                onDiscard: () => {
                  remove(id);
                  listeners.current.onChanged?.();
                  listeners.current.onOrderRefresh?.();
                },
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
      !editors.current.has(id) &&
      creation.confirmedAfter !== null &&
      !creation.failure &&
      creation.confirmedAfter === observed.confirmedAfter &&
      creation.input === observed.input &&
      creation.completed === observed.completed &&
      creation.deleted === observed.deleted
    )
      remove(id);
  };
  const retainEditor = (id: number) => {
    if (!current.current.some((item) => item.id === id)) return () => {};
    const token = Symbol();
    const leases = editors.current.get(id) ?? new Set<symbol>();
    leases.add(token);
    editors.current.set(id, leases);
    change((items) => items.map((item) => (item.id === id ? { ...item, editing: true } : item)));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      leases.delete(token);
      if (leases.size) return;
      editors.current.delete(id);
      change((items) => items.map((item) => (item.id === id ? { ...item, editing: false } : item)));
      const creation = current.current.find((item) => item.id === id);
      if (creation && creation.confirmedAfter !== null) listeners.current.onChanged?.();
    };
  };
  const run = (
    id: number,
    submit: () => Promise<OperationSummary | null>,
    error?: () => RequestError | null,
  ): Promise<boolean> => {
    const creation = current.current.find((item) => item.id === id);
    if (!creation || creation.input.accountId !== accountId)
      return Promise.reject(new Error('this new task’s draft is no longer available.'));
    return submissions.current!.queue.run(id, creation.input.listId, submit, error);
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
    retainEditor,
    run,
    busy: records.some((item) => item.confirmedAfter === null && !item.failure),
    hasDrafts: records.some((item) => !!item.failure),
    discardDrafts: () => change((items) => items.filter((item) => !item.failure)),
  };
}
export type TaskCreationController = ReturnType<typeof useTaskCreations>;
