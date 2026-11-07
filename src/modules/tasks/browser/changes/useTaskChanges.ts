import { useCallback, useRef, useState } from 'react';
import { projectMovedTasks, type QueuedTaskMove } from '../movement/task-move-model';
import type { Task, TaskPatch } from '../../contracts/task';

export type TaskChangeId = string | number;
export type TaskPresentationPatch = TaskPatch &
  Partial<Pick<Task, 'completed' | 'completedAt'>> & { removed?: boolean };
export interface TaskChangeInput {
  accountId: string;
  taskId: string;
  listId: string;
  expectedRevision: number;
  patch: TaskPresentationPatch;
}
export interface PendingTaskChange {
  id: TaskChangeId;
  task: Task;
  input: TaskChangeInput;
  confirmedAfter: number | null;
}

export function taskChangeAcknowledged(change: PendingTaskChange, readVersion?: number) {
  return change.confirmedAfter !== null && (readVersion ?? -1) > change.confirmedAfter;
}

function visiblePatch(patch: TaskPresentationPatch) {
  const { removed: _removed, ...fields } = patch;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function projectTaskChanges(
  task: Task,
  changes: readonly PendingTaskChange[],
  readVersion?: number,
): Task {
  return changes.reduce<Task>((current, change) => {
    if (
      change.input.accountId !== current.accountId ||
      change.input.taskId !== current.id ||
      taskChangeAcknowledged(change, readVersion)
    )
      return current;
    return Object.assign({}, current, visiblePatch(change.input.patch));
  }, task);
}

/** Include captured tasks that a stale filtered query has not returned yet. */
export function projectTaskCollection(
  tasks: readonly Task[],
  changes: readonly PendingTaskChange[],
  readVersion?: number,
  accepts: (task: Task) => boolean = () => true,
  moves: readonly QueuedTaskMove[] = [],
): Task[] {
  const items = new Map(tasks.filter(accepts).map((task) => [task.id, task]));
  const active = changes.filter((change) => !taskChangeAcknowledged(change, readVersion));
  for (const change of active)
    if (accepts(change.task) && !items.has(change.task.id)) items.set(change.task.id, change.task);
  const removed = new Set<string>();
  for (const change of active) {
    const task = items.get(change.input.taskId);
    if (!task || task.accountId !== change.input.accountId) continue;
    const { removed: deleting, ...patch } = change.input.patch;
    items.set(task.id, Object.assign({}, task, visiblePatch(patch)));
    if (deleting) {
      removed.add(task.id);
      for (const child of items.values()) if (child.parentId === task.id) removed.add(child.id);
    }
    if (patch.completed === true && !task.parentId)
      for (const child of items.values())
        if (child.parentId === task.id) items.set(child.id, { ...child, completed: true });
    if (patch.completed === false && task.parentId) {
      const parent = items.get(task.parentId);
      if (parent) items.set(parent.id, { ...parent, completed: false, completedAt: null });
    }
  }
  const projected = projectMovedTasks([...items.values()], moves);
  // Movement may carry a task captured before a later delete; it cannot resurrect that task.
  return projected.filter(
    (task) =>
      !removed.has(task.id) && (!task.parentId || !removed.has(task.parentId)) && accepts(task),
  );
}

/** One account owns submitted intent, independently of the currently presented view. */
export function useTaskChanges(accountId: string, version: number) {
  const [items, setItems] = useState<PendingTaskChange[]>([]);
  const currentItems = useRef(items);
  currentItems.current = items;
  const currentVersion = useRef(version);
  currentVersion.current = version;
  const tails = useRef(new Map<string, Promise<boolean>>());
  const replace = useCallback((next: PendingTaskChange[]) => {
    currentItems.current = next;
    setItems(next);
  }, []);
  const start = useCallback(
    (id: TaskChangeId, task: Task, input: TaskChangeInput) => {
      if (input.accountId !== accountId || task.accountId !== accountId || input.taskId !== task.id)
        return;
      replace([
        ...currentItems.current.filter((item) => item.id !== id),
        {
          id,
          task: structuredClone(task),
          input: structuredClone(input),
          confirmedAfter: null,
        },
      ]);
    },
    [accountId, replace],
  );
  const confirm = useCallback(
    (id: TaskChangeId) => {
      replace(
        currentItems.current.map((item) =>
          item.id === id && item.confirmedAfter === null
            ? { ...item, confirmedAfter: currentVersion.current }
            : item,
        ),
      );
    },
    [replace],
  );
  const remove = useCallback(
    (id: TaskChangeId) => {
      replace(currentItems.current.filter((item) => item.id !== id));
    },
    [replace],
  );
  const run = useCallback((taskId: string, job: (queued: boolean) => Promise<boolean>) => {
    const previous = tails.current.get(taskId);
    const waitingForRead =
      currentItems.current.filter((item) => item.input.taskId === taskId).length > 1;
    const work = previous
      ? previous.then(
          (saved) => (saved ? job(true) : false),
          () => false,
        )
      : Promise.resolve().then(() => job(waitingForRead));
    tails.current.set(taskId, work);
    const clear = () => {
      if (tails.current.get(taskId) === work) tails.current.delete(taskId);
    };
    void work.then(clear, clear);
    return work;
  }, []);
  return { items, start, confirm, remove, run };
}
export type TaskChangeController = ReturnType<typeof useTaskChanges>;
