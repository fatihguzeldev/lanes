import type { TaskMoveIntent } from '../../../tasks/contracts/task';
import {
  latestTasks,
  openTaskOrder,
  type TaskMoveList,
} from '../../../tasks/browser/movement/task-move-model';
import { resolveTaskDrop } from './drag-model';

export type DraggedTask = Pick<
  TaskMoveIntent,
  'accountId' | 'taskId' | 'revision' | 'sourceListId'
>;

interface TaskDragContext {
  accountId: string;
  columns: readonly TaskMoveList[];
  pendingTaskIds?: ReadonlySet<string> | undefined;
}

export function captureTaskDrag(input: TaskDragContext & { taskId: string }): DraggedTask | null {
  if (input.pendingTaskIds?.has(input.taskId)) return null;
  const task = latestTasks(input.columns.flatMap((column) => column.tasks)).find(
    (item) => item.accountId === input.accountId && item.id === input.taskId,
  );
  if (
    !task ||
    task.parentId !== null ||
    task.completed ||
    !task.capabilities.canMove ||
    task.unsupportedHierarchy
  )
    return null;
  const source = input.columns.find(
    (column) => column.list.accountId === input.accountId && column.list.id === task.listId,
  );
  if (!source) return null;
  if (!openTaskOrder(source).includes(task.id)) return null;
  return {
    accountId: input.accountId,
    taskId: task.id,
    revision: task.revision,
    sourceListId: task.listId,
  };
}

export function resolveTaskDragIntent(
  input: TaskDragContext & {
    dragged: DraggedTask;
    destinationListId: string;
    index: number;
  },
): TaskMoveIntent | null {
  const { dragged } = input;
  if (dragged.accountId !== input.accountId || !Number.isInteger(input.index)) return null;
  const current = captureTaskDrag({ ...input, taskId: dragged.taskId });
  if (
    !current ||
    current.revision !== dragged.revision ||
    current.sourceListId !== dragged.sourceListId
  )
    return null;
  const source = input.columns.find(
    (column) =>
      column.list.accountId === input.accountId && column.list.id === dragged.sourceListId,
  )!;
  const destination = input.columns.find(
    (column) =>
      column.list.accountId === input.accountId && column.list.id === input.destinationListId,
  );
  if (!destination) return null;
  if (
    destination.list.id !== source.list.id &&
    (!(source.orderReady ?? source.coverage.complete) ||
      !(destination.orderReady ?? destination.coverage.complete))
  )
    return null;
  const destinationTaskIds = openTaskOrder(destination);
  const siblings = destinationTaskIds.filter((id) => id !== dragged.taskId);
  if (input.index < 0 || input.index > siblings.length) return null;
  const targetTaskId = siblings[input.index] ?? null;
  const position = resolveTaskDrop({
    taskId: dragged.taskId,
    sourceListId: dragged.sourceListId,
    destinationListId: destination.list.id,
    sourceTaskIds: openTaskOrder(source),
    destinationTaskIds,
    targetTaskId,
    side: targetTaskId === null ? 'after' : 'before',
  });
  return position
    ? {
        ...dragged,
        destinationListId: destination.list.id,
        parentId: null,
        previousTaskId: position.previousTaskId,
      }
    : null;
}
