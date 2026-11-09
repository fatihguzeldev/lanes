import type { Coverage } from '../../../../shared/contracts/http';
import type { TaskList, TaskMoveIntent } from '../../contracts/task';
import type { SubtaskSummary } from '../../contracts/query';

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
  subtaskSummaries?: Record<string, SubtaskSummary> | undefined;
}
import type { Task } from '../../contracts/task';
import { sortTasks } from '../../model/task';

export interface TaskMoveChoice {
  list: TaskList;
  parent?: Task | null;
  previous?: Task | null;
  position: 'first' | 'last' | 'after';
}

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
    if (destination && destination.list.accountId !== intent.accountId) continue;
    const parentId = intent.parentId;
    const siblings = destination
      ? sortTasks(
          latestTasks(destination.tasks).filter(
            (task) => task.accountId === intent.accountId && task.parentId === parentId,
          ),
          'manual',
        ).map((task) => task.id)
      : [];
    const preferred = (destination?.orderedTaskIds ?? []).filter((id) => siblings.includes(id));
    const siblingOrder = [...preferred, ...siblings.filter((id) => !preferred.includes(id))];
    const order = (
      parentId === null && destination ? openTaskOrder(destination) : siblingOrder
    ).filter((id) => id !== intent.taskId);
    if (
      destination &&
      intent.position !== 'last' &&
      intent.previousTaskId !== null &&
      !order.includes(intent.previousTaskId)
    )
      continue;
    const entries = latestTasks(projected.flatMap((column) => column.tasks));
    const task =
      entries.find((task) => task.accountId === intent.accountId && task.id === intent.taskId) ??
      move.task;
    if (task.accountId !== intent.accountId) continue;
    const summary =
      projected.find(
        (column) => column.list.accountId === intent.accountId && column.list.id === task.listId,
      )?.subtaskSummaries?.[task.id] ??
      projected.find(
        (column) =>
          column.list.accountId === intent.accountId && column.subtaskSummaries?.[task.id],
      )?.subtaskSummaries?.[task.id];
    const children = new Map(
      move.children
        .filter((child) => child.accountId === intent.accountId)
        .map((child) => [child.id, child]),
    );
    for (const child of entries)
      if (child.accountId === intent.accountId && child.parentId === task.id)
        children.set(child.id, child);
    const moving = new Set([task.id, ...children.keys()]);
    const childOrder = [
      ...new Set(
        projected.flatMap((column) => column.orderedTaskIds ?? []).filter((id) => children.has(id)),
      ),
    ];
    order.splice(
      intent.position === 'last'
        ? order.length
        : intent.previousTaskId === null
          ? 0
          : Math.max(0, order.indexOf(intent.previousTaskId) + 1),
      0,
      task.id,
    );
    projected = projected.map((column) => {
      if (column.list.accountId !== intent.accountId) return column;
      const remaining = latestTasks(column.tasks).filter((task) => !moving.has(task.id));
      const target = column.list.id === intent.destinationListId;
      const roots =
        parentId === null ? order : openTaskOrder(column).filter((id) => !moving.has(id));
      const otherOrder = (column.orderedTaskIds ?? []).filter(
        (id) => !moving.has(id) && !roots.includes(id) && !order.includes(id),
      );
      let subtaskSummaries = column.subtaskSummaries;
      if (subtaskSummaries?.[task.id] || (target && summary)) {
        subtaskSummaries = { ...subtaskSummaries };
        delete subtaskSummaries[task.id];
        if (target && summary) subtaskSummaries[task.id] = summary;
      }
      return {
        ...column,
        ...(subtaskSummaries ? { subtaskSummaries } : {}),
        tasks: target
          ? [
              ...remaining,
              { ...task, listId: intent.destinationListId, parentId },
              ...[...children.values()].map((child) => ({
                ...child,
                listId: intent.destinationListId,
              })),
            ]
          : remaining,
        orderedTaskIds: target
          ? [...roots, ...otherOrder, ...(parentId === null ? [] : order), ...childOrder]
          : (column.orderedTaskIds ?? openTaskOrder(column)).filter((id) => !moving.has(id)),
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

/** Project account-owned moves before a consumer applies its list or query scope. */
export function projectMovedTasks(
  tasks: readonly Task[],
  moves: readonly QueuedTaskMove[],
): Task[] {
  let shown = latestTasks(tasks);
  for (const move of moves) {
    const { intent } = move;
    const task =
      shown.find((item) => item.accountId === intent.accountId && item.id === intent.taskId) ??
      move.task;
    if (task.accountId !== intent.accountId) continue;
    const children = latestTasks([
      ...move.children,
      ...shown.filter((item) => item.accountId === intent.accountId && item.parentId === task.id),
    ]);
    const moving = new Set([task.id, ...children.map((item) => item.id)]);
    const remaining = shown.filter(
      (item) => item.accountId !== intent.accountId || !moving.has(item.id),
    );
    const siblings = remaining.filter(
      (item) =>
        item.accountId === intent.accountId &&
        item.listId === intent.destinationListId &&
        item.parentId === intent.parentId,
    );
    const previous =
      intent.position === 'last'
        ? siblings.at(-1)
        : intent.previousTaskId
          ? siblings.find((item) => item.id === intent.previousTaskId)
          : null;
    const insertion = previous
      ? remaining.indexOf(previous) + 1
      : siblings[0]
        ? remaining.indexOf(siblings[0])
        : remaining.length;
    remaining.splice(
      insertion,
      0,
      { ...task, listId: intent.destinationListId, parentId: intent.parentId },
      ...children.map((child) => ({ ...child, listId: intent.destinationListId })),
    );
    shown = remaining;
  }
  return shown;
}
