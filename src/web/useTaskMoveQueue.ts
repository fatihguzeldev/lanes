import { useEffect, useRef, useState } from 'react';
import type { BoardColumn, TaskMoveIntent } from '../modules/boards/components/BoardSurface';
import {
  createTaskMoveQueue,
  latestTasks,
  projectTaskMoves,
  type QueuedTaskMove,
} from './task-move-queue';
import { saveTaskMove } from './save-task-move';
import { newOperationId } from '../client/operation-identity';

export function useTaskMoveQueue(
  accountId: string,
  options: {
    version: number;
    clockOffset: number;
    onRefresh: () => void;
    onError: (error: unknown) => void;
    confirmChildren: (title: string, count: number) => Promise<boolean>;
  },
) {
  const [moves, setMoves] = useState<readonly QueuedTaskMove[]>([]);
  const live = useRef(true);
  const latest = useRef(options);
  latest.current = options;
  const abort = useRef(new AbortController());
  const queue = useRef<ReturnType<typeof createTaskMoveQueue> | null>(null);
  const createQueue = () =>
    createTaskMoveQueue(
      async (move) => {
        const saved = await saveTaskMove(
          move.intent,
          move.id,
          latest.current.confirmChildren,
          abort.current.signal,
          latest.current.clockOffset,
        );
        move.confirmedAfter = latest.current.version;
        if (live.current) latest.current.onRefresh();
        return saved;
      },
      (next) => {
        if (live.current) setMoves(next);
      },
      (error) => {
        if (live.current) {
          latest.current.onError(error);
          latest.current.onRefresh();
        }
      },
    );
  if (!queue.current) queue.current = createQueue();
  useEffect(() => {
    live.current = true;
    if (abort.current.signal.aborted) {
      abort.current = new AbortController();
      queue.current = createQueue();
    }
    return () => {
      live.current = false;
      queue.current!.dispose();
      abort.current.abort();
    };
  }, []);
  return {
    moves,
    busy: moves.some((move) => !move.confirmed),
    reconcile(columns: readonly BoardColumn[], scope: string) {
      queue.current!.reconcile(columns, scope);
    },
    enqueue(intent: TaskMoveIntent, columns: readonly BoardColumn[], scope: string) {
      if (intent.accountId !== accountId) return;
      const projected = projectTaskMoves(
        columns,
        moves.filter((move) => move.scope === scope),
      );
      const entries = latestTasks(projected.flatMap((column) => column.tasks));
      const task = entries.find(
        (task) => task.accountId === accountId && task.id === intent.taskId,
      );
      if (!task) return;
      queue.current!.enqueue({
        id: newOperationId(options.clockOffset),
        intent,
        task,
        scope,
        confirmed: false,
        children: entries.filter(
          (child) => child.accountId === accountId && child.parentId === task.id,
        ),
        readyListIds: projected
          .filter((column) => column.orderReady || column.coverage.complete)
          .map((column) => column.list.id),
      });
    },
  };
}

export type TaskMoveQueue = ReturnType<typeof useTaskMoveQueue>;
