import type { Task } from '../../contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { useTaskToggle } from './useTaskToggle';
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
  const { value: starred, toggle } = useTaskToggle(task, 'starred', disabled, onToggle);
  const label = `${starred ? 'unstar' : 'star'} ${task.title.trim() || 'untitled task'}`;
  return (
    <button
      type="button"
      className="task-star-button"
      aria-label={label}
      aria-pressed={starred}
      disabled={disabled}
      onClick={() => void toggle()}
    >
      <Icon name="star" size={14} />
    </button>
  );
}
