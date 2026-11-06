import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';
import './TaskStarButton.css';

export type ToggleTaskStar = (task: Task, starred: boolean) => Promise<boolean>;
export function TaskStarButton({
  task,
  disabled,
  onToggle,
}: {
  task: Task;
  disabled: boolean;
  onToggle: ToggleTaskStar;
}) {
  const [change, setChange] = useState<{
    value: boolean;
    revision: number;
    confirmed: boolean;
  } | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    if (change?.confirmed && task.revision > change.revision) {
      locked.current = false;
      setChange(null);
    }
  }, [change, task.revision]);
  const starred = change?.value ?? task.starred;
  const label = `${starred ? 'unstar' : 'star'} ${task.title.trim() || 'untitled task'}`;
  async function toggle() {
    if (disabled || locked.current) return;
    locked.current = true;
    const next = !task.starred;
    setChange({ value: next, revision: task.revision, confirmed: false });
    try {
      if (await onToggle(task, next)) {
        setChange((current) => (current ? { ...current, confirmed: true } : null));
        return;
      }
    } catch {
      // The action owns the error notice; restore this local preview.
    }
    locked.current = false;
    setChange(null);
  }
  return (
    <button
      type="button"
      className="task-star-button"
      aria-label={label}
      aria-pressed={starred}
      disabled={disabled || change !== null}
      onClick={() => void toggle()}
    >
      <Icon name="star" size={14} />
    </button>
  );
}
