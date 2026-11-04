import type { Coverage } from '../../../shared/contracts/http';
import type { TaskList, TaskMoveIntent } from '../contracts';

export interface TaskMoveList {
  list: TaskList;
  tasks: readonly Task[];
  coverage: Coverage;
  nextCursor: string | null;
  status: 'loading' | 'ready' | 'error';
  orderedTaskIds?: readonly string[] | undefined;
  orderReady?: boolean | undefined;
  readVersion?: number | undefined;
  providerComplete?: boolean | undefined;
}
import type { Task } from '../contracts';
import { sortTasks } from '../model';

export interface QueuedTaskMove {
  id: string;
  intent: TaskMoveIntent;
  task: Task;
  children: readonly Task[];
  readyListIds: readonly string[];
  scope: string;
  confirmed: boolean;
  confirmedAfter?: number;
}

export function latestTasks(tasks: readonly Task[]): Task[] {
  const latest = new Map<string, Task>();
  for (const task of tasks) {
    const key = `${task.accountId}:${task.id}`;
    const prior = latest.get(key);
    if (!prior || task.revision > prior.revision) latest.set(key, task);
  }
  return [...latest.values()];
}

export function openTaskOrder(column: TaskMoveList): string[] {
  const tasks = sortTasks(
    latestTasks(column.tasks).filter(
      (task) =>
        task.accountId === column.list.accountId &&
        task.listId === column.list.id &&
        !task.completed &&
        !task.parentId,
    ),
    'manual',
  );
  const available = new Set(tasks.map((task) => task.id));
  const preferred = (column.orderedTaskIds ?? []).filter((id) => available.has(id));
  const known = new Set(preferred);
  return [...preferred, ...tasks.filter((task) => !known.has(task.id)).map((task) => task.id)];
}

/** Presentation order is independent of Google's position strings and confirmed projection. */
export function projectTaskMoves<T extends TaskMoveList>(
  columns: readonly T[],
  moves: readonly QueuedTaskMove[],
): T[] {
  const snapshots = latestTasks(columns.flatMap((column) => column.tasks));
  let projected: T[] = columns.map((column) => ({
    ...column,
    tasks: snapshots.filter(
      (task) => task.accountId === column.list.accountId && task.listId === column.list.id,
    ),
  }));
  for (const move of moves) {
    const { intent } = move;
    const destination = projected.find((column) => column.list.id === intent.destinationListId);
    if (!destination || destination.list.accountId !== intent.accountId) continue;
    const order = openTaskOrder(destination).filter((id) => id !== intent.taskId);
    if (intent.previousTaskId !== null && !order.includes(intent.previousTaskId)) continue;
    const entries = latestTasks(projected.flatMap((column) => column.tasks));
    const task =
      entries.find((task) => task.accountId === intent.accountId && task.id === intent.taskId) ??
      move.task;
    if (task.accountId !== intent.accountId) continue;
    const children = new Map(
      move.children
        .filter((child) => child.accountId === intent.accountId)
        .map((child) => [child.id, child]),
    );
    for (const child of entries)
      if (child.accountId === intent.accountId && child.parentId === task.id)
        children.set(child.id, child);
    const moving = new Set([task.id, ...children.keys()]);
    order.splice(
      intent.previousTaskId === null ? 0 : order.indexOf(intent.previousTaskId) + 1,
      0,
      task.id,
    );
    projected = projected.map((column) => {
      if (column.list.accountId !== intent.accountId) return column;
      const remaining = latestTasks(column.tasks).filter((task) => !moving.has(task.id));
      const target = column.list.id === destination.list.id;
      return {
        ...column,
        tasks: target
          ? [
              ...remaining,
              { ...task, listId: destination.list.id, parentId: null },
              ...[...children.values()].map((child) => ({ ...child, listId: destination.list.id })),
            ]
          : remaining,
        orderedTaskIds: target ? order : openTaskOrder(column).filter((id) => !moving.has(id)),
        orderReady:
          column.orderReady ||
          column.coverage.complete ||
          move.readyListIds.includes(column.list.id),
      };
    });
  }
  return projected;
}

export function movesAcknowledged(
  columns: readonly TaskMoveList[],
  moves: readonly QueuedTaskMove[],
): boolean {
  return moves.every((move) =>
    [move.intent.sourceListId, move.intent.destinationListId].every((id) => {
      const column = columns.find((column) => column.list.id === id);
      return (
        column?.status === 'ready' &&
        column.providerComplete === true &&
        (column.readVersion ?? -1) > (move.confirmedAfter ?? -1)
      );
    }),
  );
}
