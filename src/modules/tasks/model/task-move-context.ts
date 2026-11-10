import type { Task } from '../contracts/task';

/** Metadata and provider resequencing do not change the meaning of a captured placement. */
export function sameTaskMoveContext(before: Task, after: Task): boolean {
  const context = (task: Task) => [
    task.accountId,
    task.id,
    task.listId,
    task.parentId,
    task.title,
    task.notes,
    task.completed,
    task.completedAt,
    task.scheduledDay,
    task.scheduledTime,
    task.timeZone,
    task.repeatRule,
    task.seriesId,
    task.occurrenceId,
    task.unsupportedHierarchy,
    task.provider.id,
    task.provider.listId,
    Boolean(task.provider.missing),
    ...Object.entries(task.capabilities).sort(([left], [right]) => left.localeCompare(right)),
  ];
  return JSON.stringify(context(before)) === JSON.stringify(context(after));
}
