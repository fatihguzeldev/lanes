import type { Task, TaskList } from '../../../tasks/contracts/task';

/** A paged list inventory cannot exclude a task returned by a board-scoped query. */
export function taskBelongsToBoard(
  task: Task,
  boardId: string,
  lists: readonly TaskList[],
  contexts: readonly { listId: string; boardId: string }[],
  serverTasks: readonly Task[],
) {
  if (lists.some((list) => list.accountId === task.accountId && list.id === task.listId))
    return true;
  const context = contexts.find((item) => item.listId === task.listId);
  if (context) return context.boardId === boardId;
  return serverTasks.some(
    (item) =>
      item.accountId === task.accountId && item.id === task.id && item.listId === task.listId,
  );
}
