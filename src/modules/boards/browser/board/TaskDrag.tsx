import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { OptimisticSortingPlugin } from '@dnd-kit/dom/sortable';
import {
  Feedback,
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
} from '@dnd-kit/dom';
import type { Task } from '../../../tasks/contracts/task';
import { taskCollision } from './drag-collision';
import './TaskDrag.css';

export interface TaskDragData {
  kind: 'task';
  accountId: string;
  taskId: string;
  listId: string;
  revision: number;
}

export const taskDragSensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 4 })],
    preventActivation: (event) => {
      if (!(event.target instanceof Element)) return true;
      const control = event.target.closest(
        'button, input, textarea, select, a, [contenteditable="true"], [role="button"], [role="checkbox"], [role="switch"]',
      );
      return Boolean(control && !control.matches('.task-card__title'));
    },
  }),
  KeyboardSensor,
];

const transition = { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
const feedback = Feedback.configure({
  feedback: 'clone',
  dropAnimation: transition,
  keyboardTransition: transition,
});

export function SortableTask({
  task,
  index,
  listId,
  draggable,
  droppable,
  children,
}: {
  task: Task;
  index: number;
  listId: string;
  draggable: boolean;
  droppable: boolean;
  children: ReactNode;
}) {
  const { ref, isDragSource, isDragging } = useSortable<TaskDragData>({
    id: task.id,
    group: listId,
    index,
    type: 'task',
    accept: 'task',
    collisionDetector: taskCollision,
    data: {
      kind: 'task',
      accountId: task.accountId,
      taskId: task.id,
      listId,
      revision: task.revision,
    },
    disabled: { draggable: !draggable, droppable: !droppable },
    sensors: taskDragSensors,
    transition,
    plugins: (defaults) => [
      ...defaults.filter((plugin) => plugin !== OptimisticSortingPlugin),
      feedback,
    ],
  });
  return (
    <div
      ref={ref}
      className="board-sortable-task"
      role="group"
      aria-label={`reorder ${task.title.trim() || 'untitled task'}`}
      tabIndex={draggable ? 0 : undefined}
      data-sortable-task-id={task.id}
      data-drag-source={isDragSource || undefined}
      data-dragging={isDragging || undefined}
      data-draggable={draggable || undefined}
    >
      {children}
    </div>
  );
}

export function TaskDropZone({
  listId,
  disabled,
  children,
  label,
  hasItems = false,
}: {
  listId: string;
  disabled: boolean;
  children: ReactNode;
  label?: string | undefined;
  hasItems?: boolean | undefined;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `task-list:${listId}`,
    accept: 'task',
    collisionDetector: taskCollision,
    data: { kind: 'task-list', listId },
    disabled,
    collisionPriority: 0,
  });
  return (
    <div
      ref={ref}
      className={`board-column__tasks${isDropTarget ? ' board-column__tasks--drop-target' : ''}`}
      role={hasItems ? 'list' : undefined}
      aria-label={hasItems ? label : undefined}
      data-task-drop-zone={listId}
    >
      {children}
    </div>
  );
}
