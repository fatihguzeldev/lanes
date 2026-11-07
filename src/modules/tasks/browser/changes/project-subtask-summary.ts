import type { Task } from '../../contracts/task';
import type { SubtaskSummary } from '../../contracts/query';
import { taskChangeAcknowledged, type PendingTaskChange } from './useTaskChanges';

/** The server aggregate includes children that the current task page has not loaded. */
export function projectSubtaskSummary(
  parent: Task,
  summary: SubtaskSummary | undefined,
  confirmedTasks: readonly Task[],
  projectedTasks: readonly Task[],
  changes: readonly PendingTaskChange[],
  readVersion?: number,
): SubtaskSummary | undefined {
  if (!summary) return undefined;
  const belongs = (task: Task) =>
    task.accountId === parent.accountId && task.parentId === parent.id;
  const known = new Map(confirmedTasks.filter(belongs).map((task) => [task.id, task]));
  const confirmed = new Map(
    confirmedTasks
      .filter((task) => task.accountId === parent.accountId)
      .map((task) => [task.id, task]),
  );
  const active = changes.filter(
    (change) =>
      change.input.accountId === parent.accountId && !taskChangeAcknowledged(change, readVersion),
  );
  // A captured child may be outside this page but is already counted by the aggregate.
  for (const change of active)
    if (belongs(change.task) && !known.has(change.task.id) && !confirmed.has(change.task.id))
      known.set(change.task.id, change.task);
  let total = summary.total;
  let open = summary.open;
  let completedTree = false;
  const removed = new Set<string>();
  for (const change of active) {
    const patch = change.input.patch;
    if (change.input.taskId === parent.id && patch.completed === true) {
      completedTree = true;
      open = 0;
      for (const [id, child] of known) known.set(id, { ...child, completed: true });
      continue;
    }
    const child = known.get(change.input.taskId);
    if (!child || removed.has(child.id)) continue;
    if (patch.removed) {
      removed.add(child.id);
      total--;
      if (!child.completed) open--;
      known.delete(child.id);
    } else if (patch.completed !== undefined && patch.completed !== child.completed) {
      open += patch.completed ? -1 : 1;
      known.set(child.id, { ...child, completed: patch.completed });
    }
  }
  const projected = new Map(projectedTasks.filter(belongs).map((task) => [task.id, task]));
  for (const child of known.values()) {
    const next = projected.get(child.id);
    if (!next) {
      total--;
      if (!child.completed) open--;
    } else if (next.completed !== child.completed) open += next.completed ? -1 : 1;
  }
  for (const child of projected.values()) {
    if (known.has(child.id) || removed.has(child.id)) continue;
    total++;
    if (!child.completed) open++;
  }
  // Parent completion has already covered unknown children; later explicit child reopening
  // adjusts only that child's contribution above.
  if (completedTree && open < 0) open = 0;
  total = Math.max(0, total);
  return { ...summary, total, open: Math.max(0, Math.min(total, open)) };
}
