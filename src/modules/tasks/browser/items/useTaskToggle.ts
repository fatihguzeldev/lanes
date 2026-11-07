import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../contracts/task';

export type ToggleTaskField = (task: Task, value: boolean) => Promise<boolean> | void;

export function useTaskToggle(
  task: Task,
  field: 'starred' | 'completed',
  disabled: boolean,
  onToggle: ToggleTaskField,
) {
  const [change, setChange] = useState<{
    value: boolean;
    revision: number;
    confirmed: boolean;
  } | null>(null);
  const sequence = useRef(0);
  const latest = useRef(task);
  latest.current = task;
  const preview = useRef(task[field]);
  if (!change) preview.current = task[field];
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  useEffect(() => {
    if (change?.confirmed && (task[field] === change.value || task.revision > change.revision)) {
      preview.current = task[field];
      setChange(null);
    }
  }, [change, task.revision, task[field]]);
  return {
    value: change?.value ?? task[field],
    async toggle() {
      if (disabled) return;
      const current = ++sequence.current;
      const value = !preview.current;
      preview.current = value;
      setChange({ value, revision: task.revision, confirmed: false });
      let saved = false;
      try {
        saved = (await onToggle(task, value)) === true;
      } catch {
        // The action owns the notice and refresh; only restore this preview.
      }
      if (sequence.current !== current) return;
      if (saved) setChange({ value, revision: latest.current.revision, confirmed: true });
      else {
        preview.current = latest.current[field];
        setChange(null);
      }
    },
  };
}
