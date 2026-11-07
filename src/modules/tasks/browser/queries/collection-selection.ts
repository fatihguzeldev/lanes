import type { Task, TaskSelection, TaskSelectionOptions } from '../../contracts/task';
import {
  matchesTaskFilter,
  normalizeTaskSearchText,
  selectTasksWithContext,
} from '../../model/task';
import { taskChangeAcknowledged, type PendingTaskChange } from '../changes/useTaskChanges';
import type { PendingTaskCreation } from '../creation/useTaskCreations';

export function collectionCreationMatches(
  creation: PendingTaskCreation,
  options: TaskSelectionOptions,
  tasks: readonly Task[] = [],
) {
  const input = creation.input;
  if (
    creation.deleted ||
    input.accountId !== options.accountId ||
    (options.listIds && !options.listIds.includes(input.listId))
  )
    return false;
  if (
    !matchesTaskFilter(
      { ...input, completed: !!creation.completed },
      options.filter ?? {},
      options.today,
      tasks,
    )
  )
    return false;
  const query = normalizeTaskSearchText(options.query ?? '').trim();
  if (!query) return true;
  const list = options.lists?.find(
    (list) => list.accountId === input.accountId && list.id === input.listId,
  );
  const parent = input.parentId
    ? tasks.find(
        (task) =>
          task.accountId === input.accountId &&
          task.id === input.parentId &&
          task.listId === input.listId,
      )
    : undefined;
  const labels =
    options.labels?.filter(
      (label) => label.accountId === input.accountId && input.labelIds.includes(label.id),
    ) ?? [];
  return normalizeTaskSearchText(
    [
      input.title,
      input.notes,
      list?.title ?? '',
      parent?.title ?? '',
      ...labels.map((label) => label.name),
    ].join('\n'),
  ).includes(query);
}

/** Server text matches remain valid while their list names are still being resolved. */
export function selectCollectionTasks(
  tasks: readonly Task[],
  options: TaskSelectionOptions,
  serverMatchedIds: readonly string[],
  changes: readonly PendingTaskChange[],
  readVersion?: number,
  movedTaskIds: ReadonlySet<string> = new Set(),
): TaskSelection {
  const selection = selectTasksWithContext(tasks, options);
  if (!options.query?.trim()) return selection;
  const changedText = new Set(movedTaskIds);
  for (const change of changes) {
    if (change.input.accountId !== options.accountId || taskChangeAcknowledged(change, readVersion))
      continue;
    if (
      ['title', 'notes', 'labelIds', 'listId', 'parentId'].some((field) =>
        Object.hasOwn(change.input.patch, field),
      )
    )
      changedText.add(change.input.taskId);
  }
  const serverMatched = new Set(serverMatchedIds);
  const filterOnly = selectTasksWithContext(tasks, { ...options, query: '' });
  const eligible = new Set(filterOnly.matchedTaskIds);
  const matched = new Set(selection.matchedTaskIds);
  for (const task of tasks) {
    if (
      serverMatched.has(task.id) &&
      eligible.has(task.id) &&
      !changedText.has(task.id) &&
      (!task.parentId || !changedText.has(task.parentId))
    )
      matched.add(task.id);
  }
  const context = new Set(selection.contextTaskIds);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    if (
      matched.has(task.id) &&
      parent?.accountId === options.accountId &&
      parent.listId === task.listId
    )
      context.add(parent.id);
  }
  for (const id of matched) context.delete(id);
  return {
    tasks: tasks.filter(
      (task) =>
        task.accountId === options.accountId && (matched.has(task.id) || context.has(task.id)),
    ),
    matchedTaskIds: [...matched],
    contextTaskIds: [...context],
  };
}
