import { useEffect, useRef, useState } from 'react';
import type { CreationIntent, CreationResult } from '../creation/useTaskCreations';
import type { TaskPresentationPatch } from '../changes/useTaskChanges';
import type { Task } from '../../contracts/task';
import { TaskSchema } from '../../contracts/task';
import { request, type RequestError } from '../../../../shared/browser/http/http';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { createTaskActions, type TaskActionContext } from './task-actions';
import { createTaskActionQueue } from './task-action-queue';

export function useTaskActions(context: TaskActionContext, clockOffset: number) {
  const [busy, setBusy] = useState(false);
  const commands = useCommands(context.accountId, clockOffset, context.onChanged, {
    independent: true,
  });
  const latest = useRef({ context, commands, clockOffset });
  latest.current = { context, commands, clockOffset };
  const abort = useRef(new AbortController());
  const queue = useRef<ReturnType<typeof createTaskActionQueue> | null>(null);
  const createQueue = () =>
    createTaskActionQueue(
      async ({ task: selected, field, value, changeId }) => {
        const save = async () => {
          const { context: current, commands, clockOffset } = latest.current;
          const signal = abort.current.signal;
          const task = await request(
            `/api/accounts/${encodeURIComponent(current.accountId)}/tasks/${encodeURIComponent(selected.id)}`,
            TaskSchema,
            { signal },
          );
          if (signal.aborted) return false;
          if (task.accountId !== current.accountId || task.id !== selected.id)
            throw new Error('this task is no longer available in this account.');
          let submitted = false;
          const actions = createTaskActions({
            ...current,
            submit: async (command, category, identity = newOperationId(clockOffset)) => {
              submitted = true;
              if (field === 'scheduledDay' && value === null && changeId)
                current.changes?.start(changeId, task, {
                  accountId: task.accountId,
                  taskId: task.id,
                  listId: task.listId,
                  expectedRevision: task.revision,
                  patch: {
                    scheduledDay: null,
                    scheduledTime: null,
                    timeZone: null,
                    repeatRule: null,
                  },
                });
              const failure: { details?: RequestError } = {};
              const result = await commands.submit(command, category, identity, (details) => {
                failure.details = details;
              });
              if (signal.aborted) return false;
              if (result?.state === 'succeeded') return true;
              current.onNotice(
                result?.error?.message ??
                  failure.details?.message ??
                  'couldn’t confirm this change. check its save before trying again.',
                result?.id ?? failure.details?.operationId ?? null,
              );
              current.onChanged();
              return false;
            },
          });
          const saved = await (field === 'scheduledDay'
            ? actions.reschedule(
                {
                  accountId: task.accountId,
                  taskId: task.id,
                  revision: task.revision,
                  scheduledDay: value,
                },
                task,
              )
            : field === 'starred'
              ? actions.toggleStar(task, value)
              : actions.toggleComplete(task, value));
          if (saved && !submitted && !signal.aborted) current.onChanged();
          return saved;
        };
        return save();
      },
      setBusy,
      (error) => {
        latest.current.context.onNotice(
          error instanceof Error ? error.message : 'couldn’t save this change.',
        );
        latest.current.context.onChanged();
      },
    );
  if (!queue.current) queue.current = createQueue();
  useEffect(() => {
    if (abort.current.signal.aborted) {
      abort.current = new AbortController();
      queue.current = createQueue();
    }
    return () => {
      queue.current!.dispose();
      abort.current.abort();
    };
  }, [context.accountId]);
  const sequence = useRef(0);
  const enqueue = (task: Task, field: 'starred' | 'completed', value: boolean) => {
    if (task.accountId !== context.accountId) return Promise.resolve(false);
    const id = `quick:${++sequence.current}`;
    const changes = context.changes;
    changes?.start(id, task, {
      accountId: task.accountId,
      taskId: task.id,
      listId: task.listId,
      expectedRevision: task.revision,
      patch: {
        [field]: value,
        ...(field === 'completed' ? { completedAt: value ? new Date().toISOString() : null } : {}),
      },
    });
    const save = () => queue.current!.enqueue({ task, field, value, changeId: id });
    const result = changes ? changes.run(task.id, save) : save();
    return result.then((saved) => {
      if (saved) changes?.confirm(id);
      else changes?.remove(id);
      return saved;
    });
  };
  const deleteQueuedTask = (
    selected: Task,
    callbacks: { onCancel?(): void; onFailure?(error: RequestError): void } = {},
  ) => {
    if (selected.accountId !== context.accountId) return Promise.resolve(false);
    const current = latest.current.context;
    const work = async () => {
      const task = await request(
        `/api/accounts/${encodeURIComponent(current.accountId)}/tasks/${encodeURIComponent(selected.id)}`,
        TaskSchema,
      );
      if (task.accountId !== current.accountId || task.id !== selected.id) return false;
      return createTaskActions({
        ...current,
        onTaskDeleted: (task) => latest.current.context.onTaskDeleted(task),
        submit: async (command, category, identity = newOperationId(clockOffset)) => {
          const id = `delete:${++sequence.current}`;
          current.changes?.start(id, task, {
            accountId: task.accountId,
            taskId: task.id,
            listId: task.listId,
            expectedRevision: task.revision,
            patch: { removed: true },
          });
          try {
            const saved = callbacks.onFailure
              ? (
                  await latest.current.commands.submit(
                    command,
                    category,
                    identity,
                    callbacks.onFailure,
                  )
                )?.state === 'succeeded'
              : await current.submit(command, category, identity);
            if (saved) current.changes?.confirm(id);
            else current.changes?.remove(id);
            return saved;
          } catch (error) {
            current.changes?.remove(id);
            throw error;
          }
        },
      }).deleteTask(task, callbacks.onCancel);
    };
    return (current.changes ? current.changes.run(selected.id, work) : work()).catch((error) => {
      current.onNotice(error instanceof Error ? error.message : 'couldn’t delete this task.');
      return false;
    });
  };
  const applyCreation = async (original: Task, intent: CreationIntent): Promise<CreationResult> => {
    let task = original;
    const current = latest.current.context;
    if (Object.keys(intent.patch).length) {
      const id = `creation-edit:${++sequence.current}`;
      current.changes?.start(id, task, {
        accountId: task.accountId,
        taskId: task.id,
        listId: task.listId,
        expectedRevision: task.revision,
        patch: intent.patch,
      });
      const save = async () => {
        const fresh = await request(
          `/api/accounts/${encodeURIComponent(current.accountId)}/tasks/${encodeURIComponent(task.id)}`,
          TaskSchema,
        );
        return current.submit(
          { kind: 'task.edit', taskId: task.id, revision: fresh.revision, patch: intent.patch },
          'provider',
        );
      };
      const saved = await (current.changes ? current.changes.run(task.id, save) : save());
      if (!saved) {
        current.changes?.remove(id);
        return false;
      }
      current.changes?.confirm(id);
      task = await request(
        `/api/accounts/${encodeURIComponent(current.accountId)}/tasks/${encodeURIComponent(task.id)}`,
        TaskSchema,
      );
    }
    if (intent.completed !== undefined && !(await enqueue(task, 'completed', intent.completed)))
      return false;
    if (intent.deleted) {
      task = await request(
        `/api/accounts/${encodeURIComponent(current.accountId)}/tasks/${encodeURIComponent(task.id)}`,
        TaskSchema,
      );
      let cancelled = false;
      const failure: { details?: RequestError } = {};
      const saved = await deleteQueuedTask(task, {
        onCancel: () => {
          cancelled = true;
        },
        onFailure: (details) => {
          failure.details = details;
        },
      });
      if (cancelled) return 'cancelled';
      if (!saved && failure.details) throw failure.details;
      return saved;
    }
    return true;
  };
  return {
    ...createTaskActions(context),
    busy: busy || commands.busy,
    applyCreation,
    deleteTask: deleteQueuedTask,
    toggleStar: (task: Task, starred: boolean) => enqueue(task, 'starred', starred),
    toggleComplete: (task: Task, completed: boolean) => enqueue(task, 'completed', completed),
    reschedule: (
      intent: {
        accountId: string;
        taskId: string;
        revision: number;
        scheduledDay: string | null;
      },
      selected?: Task,
    ) => {
      if (
        intent.accountId !== context.accountId ||
        (selected && (selected.accountId !== context.accountId || selected.id !== intent.taskId))
      )
        return Promise.resolve(false);
      if (selected?.scheduledDay === intent.scheduledDay) return Promise.resolve(true);
      const id = `date:${++sequence.current}`;
      const changes = context.changes;
      const patch: TaskPresentationPatch = { scheduledDay: intent.scheduledDay };
      const task = selected;
      const needsConfirmation =
        task && intent.scheduledDay === null && (task.scheduledTime || task.repeatRule);
      if (task && !needsConfirmation)
        changes?.start(id, task, {
          accountId: task.accountId,
          taskId: task.id,
          listId: task.listId,
          expectedRevision: task.revision,
          patch,
        });
      const save = () =>
        queue.current!.enqueue({
          task: { id: intent.taskId, accountId: intent.accountId },
          field: 'scheduledDay',
          value: intent.scheduledDay,
          changeId: id,
        });
      const result = changes ? changes.run(intent.taskId, save) : save();
      return result.then((saved) => {
        if (saved) changes?.confirm(id);
        else changes?.remove(id);
        return saved;
      });
    },
  };
}
