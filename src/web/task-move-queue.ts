import type { BoardColumn, TaskMoveIntent } from '../modules/boards/components/BoardSurface';
import type { Task } from '../modules/tasks/contracts';
import { sortTasks } from '../modules/tasks/model';

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

export function openTaskOrder(column: BoardColumn): string[] {
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
export function projectTaskMoves(
  columns: readonly BoardColumn[],
  moves: readonly QueuedTaskMove[],
): BoardColumn[] {
  const snapshots = latestTasks(columns.flatMap((column) => column.tasks));
  let projected = columns.map((column) => ({
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
  columns: readonly BoardColumn[],
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

export function createTaskMoveQueue(
  save: (move: QueuedTaskMove) => Promise<boolean>,
  changed: (moves: readonly QueuedTaskMove[]) => void,
  failed: (error: unknown) => void,
) {
  let moves: QueuedTaskMove[] = [];
  let draining = false;
  let disposed = false;
  const publish = () => {
    if (!disposed) changed([...moves]);
  };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (; !disposed;) {
        const next = moves.find((move) => !move.confirmed);
        if (!next) break;
        try {
          if (!(await save(next))) {
            moves = moves.filter((move) => move.confirmed);
            publish();
            break;
          }
          next.confirmed = true;
          publish();
        } catch (error) {
          // Later unsent positions may depend on this one. Keep only confirmed work.
          moves = moves.filter((move) => move.confirmed);
          publish();
          failed(error);
          break;
        }
      }
    } finally {
      draining = false;
      publish();
    }
  }
  return {
    enqueue(move: QueuedTaskMove) {
      if (disposed) return;
      moves.push(move);
      publish();
      void drain();
    },
    reconcile(columns: readonly BoardColumn[], scope: string) {
      const retained = moves.filter(
        (move) => !move.confirmed || (move.scope === scope && !movesAcknowledged(columns, [move])),
      );
      if (retained.length !== moves.length) {
        moves = retained;
        publish();
      }
    },
    dispose() {
      disposed = true;
      moves = [];
    },
  };
}
