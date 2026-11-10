import { useEffect, useRef, useState } from 'react';
import type { Task, TaskMoveIntent } from '../../contracts/task';
import type { TaskMoveChoice, TaskMoveList } from './task-move-model';
import { createTaskMoveQueue } from './task-move-queue';
import { latestTasks, projectTaskMoves, type QueuedTaskMove } from './task-move-model';
import { saveTaskMove } from './save-task-move';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { TaskPageSchema } from '../../contracts/query';
import { request, RequestError } from '../../../../shared/browser/http/http';

async function readOrderProof(
  accountId: string,
  listIds: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const page = await request(
      `/api/accounts/${encodeURIComponent(accountId)}/tasks/query`,
      TaskPageSchema,
      {
        method: 'POST',
        body: { listIds, limit: 2, filter: { completion: 'all' } },
        signal,
      },
    );
    return page.orderReadyListIds ?? [];
  } catch (error) {
    if (signal.aborted || !(error instanceof RequestError) || error.code !== 'not_found') return [];
    if (listIds.length === 1) return [...listIds];
    const ready: string[] = [];
    for (const id of listIds) {
      if (signal.aborted) break;
      ready.push(...(await readOrderProof(accountId, [id], signal)));
    }
    return ready;
  }
}

export function useTaskMoveQueue(
  accountId: string,
  options: {
    version: number;
    clockOffset: number;
    onRefresh: () => void;
    onError: (error: unknown) => void;
    confirmChildren: (title: string, count: number) => Promise<boolean>;
    runTask?: (taskId: string, work: () => Promise<boolean>) => Promise<boolean>;
    resumeOrder?: () => Promise<void>;
    active?: boolean;
  },
) {
  const [moves, setMoves] = useState<readonly QueuedTaskMove[]>([]);
  const current = useRef(moves);
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
        if (live.current) {
          current.current = next;
          setMoves(next);
        }
      },
      (error) => {
        if (live.current) {
          latest.current.onError(error);
          latest.current.onRefresh();
        }
      },
      options.runTask ? (taskId, work) => latest.current.runTask!(taskId, work) : undefined,
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
  const proofKey = JSON.stringify(
    moves
      .filter((move) => move.confirmed && move.verifiedAfter === undefined)
      .map((move) => move.id),
  );
  useEffect(() => {
    if (options.active === false || proofKey === '[]') return;
    void latest.current.resumeOrder?.().catch(() => {});
  }, [proofKey, options.active]);
  useEffect(() => {
    if (options.active === false || proofKey === '[]') return;
    const controller = new AbortController();
    const pending = current.current.filter(
      (move) => move.confirmed && move.verifiedAfter === undefined,
    );
    const ids = [
      ...new Set(
        pending.flatMap((move) => [move.intent.sourceListId, move.intent.destinationListId]),
      ),
    ];
    void (async () => {
      const ready = new Set<string>();
      for (let offset = 0; offset < ids.length && !controller.signal.aborted; offset += 100)
        for (const id of await readOrderProof(
          accountId,
          ids.slice(offset, offset + 100),
          controller.signal,
        ))
          ready.add(id);
      if (controller.signal.aborted || !live.current) return;
      const verified = pending
        .filter((move) =>
          [move.intent.sourceListId, move.intent.destinationListId].every((id) => ready.has(id)),
        )
        .map((move) => move.id);
      if (queue.current!.verifyOrder(verified, latest.current.version)) latest.current.onRefresh();
    })();
    return () => controller.abort();
  }, [accountId, proofKey, options.version, options.active]);
  return {
    moves,
    busy: moves.some((move) => !move.confirmed),
    observeRead(readVersion?: number) {
      queue.current!.observeRead(readVersion);
    },
    reconcile(columns: readonly TaskMoveList[], scope: string) {
      queue.current!.reconcile(columns, scope);
    },
    enqueue(intent: TaskMoveIntent, columns: readonly TaskMoveList[], scope: string) {
      if (intent.accountId !== accountId) return false;
      const projected = projectTaskMoves(columns, current.current);
      const entries = latestTasks(projected.flatMap((column) => column.tasks));
      const task = entries.find(
        (task) => task.accountId === accountId && task.id === intent.taskId,
      );
      if (!task) return false;
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
      return true;
    },
    enqueuePlacement(
      task: Task,
      choice: TaskMoveChoice,
      columns: readonly TaskMoveList[] = [],
      scope = 'account',
    ) {
      const parent = choice.parent ?? null;
      const previous = choice.previous ?? null;
      const relativeOrder =
        choice.list.id === task.listId &&
        (parent?.id ?? null) === task.parentId &&
        choice.position !== 'last';
      if (
        task.accountId !== accountId ||
        choice.list.accountId !== accountId ||
        !task.capabilities.canMove ||
        task.unsupportedHierarchy
      )
        return false;
      if (
        parent &&
        (parent.accountId !== accountId ||
          parent.listId !== choice.list.id ||
          parent.id === task.id ||
          parent.parentId ||
          !parent.capabilities.canHaveChildren ||
          parent.unsupportedHierarchy ||
          (!relativeOrder && (!task.capabilities.canNest || task.repeatRule)))
      )
        return false;
      if (
        choice.position === 'after' &&
        (!previous ||
          previous.accountId !== accountId ||
          previous.listId !== choice.list.id ||
          previous.parentId !== (parent?.id ?? null) ||
          previous.id === task.id)
      )
        return false;
      const projected = projectTaskMoves(columns, current.current);
      const entries = latestTasks(projected.flatMap((column) => column.tasks));
      queue.current!.enqueue({
        id: newOperationId(latest.current.clockOffset),
        intent: {
          accountId,
          taskId: task.id,
          revision: task.revision,
          sourceListId: task.listId,
          sourceParentId: task.parentId,
          destinationListId: choice.list.id,
          parentId: parent?.id ?? null,
          previousTaskId: previous?.id ?? null,
          position: choice.position,
          allowCompleted: true,
        },
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
      return true;
    },
  };
}

export type TaskMoveQueue = ReturnType<typeof useTaskMoveQueue>;
