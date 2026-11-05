export type TaskDropSide = 'before' | 'after';

export interface TaskDropPosition {
  listId: string;
  previousTaskId: string | null;
  beforeTaskId: string | null;
}

export function orderForPresentation<T extends { id: string }>(
  tasks: readonly T[],
  orderedTaskIds: readonly string[] | undefined,
): T[] {
  if (!orderedTaskIds) return [...tasks];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of orderedTaskIds) {
    const task = byId.get(id);
    if (task && !seen.has(id)) {
      ordered.push(task);
      seen.add(id);
    }
  }
  return [...ordered, ...tasks.filter((task) => !seen.has(task.id))];
}

export function resolveTaskDrop(input: {
  taskId: string;
  sourceListId: string;
  destinationListId: string;
  sourceTaskIds: readonly string[];
  destinationTaskIds: readonly string[];
  targetTaskId: string | null;
  side: TaskDropSide;
}): TaskDropPosition | null {
  if (!input.sourceTaskIds.includes(input.taskId) || input.targetTaskId === input.taskId)
    return null;
  const siblings = [...new Set(input.destinationTaskIds)].filter((id) => id !== input.taskId);
  const target = input.targetTaskId === null ? -1 : siblings.indexOf(input.targetTaskId);
  if (input.targetTaskId !== null && target < 0) return null;
  const index =
    input.targetTaskId === null
      ? input.side === 'before'
        ? 0
        : siblings.length
      : target + (input.side === 'after' ? 1 : 0);
  const previousTaskId = siblings[index - 1] ?? null;
  if (input.sourceListId === input.destinationListId) {
    const originalIndex = input.sourceTaskIds.indexOf(input.taskId);
    if (previousTaskId === (input.sourceTaskIds[originalIndex - 1] ?? null)) return null;
  }
  return { listId: input.destinationListId, previousTaskId, beforeTaskId: siblings[index] ?? null };
}
