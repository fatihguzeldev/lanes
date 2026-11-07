import { useRef } from 'react';
import type { Task } from '../../contracts/task';

export type ToggleTaskField = (task: Task, value: boolean) => Promise<boolean> | void;

/** The account's task projection owns the value, even when this control remounts. */
export function useTaskToggle(
  task: Task,
  field: 'starred' | 'completed',
  disabled: boolean,
  onToggle: ToggleTaskField,
) {
  const next = useRef(task[field]);
  next.current = task[field];
  return {
    value: task[field],
    toggle() {
      if (disabled) return;
      const value = !next.current;
      next.current = value;
      // The action owns rollback and its notice; a button has no separate save lifetime.
      void Promise.resolve(onToggle(task, value)).catch(() => {});
    },
  };
}
