import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../contracts/task';
import { TaskSchema } from '../../contracts/task';
import { request } from '../../../../shared/browser/http/http';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { createTaskActions, type TaskActionContext } from './task-actions';
import { createTaskActionQueue } from './task-action-queue';

export function useTaskActions(context: TaskActionContext, clockOffset: number) {
  const [busy, setBusy] = useState(false);
  const commands = useCommands(context.accountId, clockOffset, context.onChanged);
  const latest = useRef({ context, commands, clockOffset });
  latest.current = { context, commands, clockOffset };
  const abort = useRef(new AbortController());
  const queue = useRef<ReturnType<typeof createTaskActionQueue> | null>(null);
  const createQueue = () =>
    createTaskActionQueue(
      async ({ task: selected, field, value }) => {
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
            const result = await commands.submit(command, category, identity);
            if (signal.aborted) return false;
            if (result?.state === 'succeeded') return true;
            current.onNotice(
              result?.error?.message ??
                'couldn’t confirm this change. check its save before trying again.',
              identity,
            );
            current.onChanged();
            return false;
          },
        });
        const saved = await (field === 'starred'
          ? actions.toggleStar(task, value)
          : actions.toggleComplete(task, value));
        if (saved && !submitted && !signal.aborted) current.onChanged();
        return saved;
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
  const enqueue = (task: Task, field: 'starred' | 'completed', value: boolean) =>
    task.accountId === context.accountId
      ? queue.current!.enqueue({ task, field, value })
      : Promise.resolve(false);
  return {
    ...createTaskActions(context),
    busy,
    toggleStar: (task: Task, starred: boolean) => enqueue(task, 'starred', starred),
    toggleComplete: (task: Task, completed: boolean) => enqueue(task, 'completed', completed),
  };
}
