import { useState, type ComponentProps } from 'react';
import type { Task } from '../../contracts/task';
import { TaskOptions } from './TaskOptions';

export function useTaskMenu() {
  const [task, setTask] = useState<Task | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    task,
    anchor,
    open(task: Task, anchor: HTMLElement) {
      setAnchor(anchor);
      setTask(task);
    },
    close() {
      setTask(null);
    },
  };
}
type Props = Omit<ComponentProps<typeof TaskOptions>, 'task' | 'anchor' | 'onClose'> & {
  controller: ReturnType<typeof useTaskMenu>;
};
export function TaskMenu({ controller, ...props }: Props) {
  if (!controller.task || !controller.anchor) return null;
  return (
    <TaskOptions
      {...props}
      task={controller.task}
      anchor={controller.anchor}
      onClose={controller.close}
      onHistory={(task) => {
        props.onHistory(task);
        controller.close();
      }}
      onOpen={(task) => {
        props.onOpen(task);
        controller.close();
      }}
      onDuplicate={(task) => {
        props.onDuplicate(task);
        controller.close();
      }}
      onMove={(task) => {
        props.onMove(task);
        controller.close();
      }}
      onToggleComplete={(task) => {
        props.onToggleComplete(task);
        controller.close();
      }}
    />
  );
}
