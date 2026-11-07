import type { Task } from '../../contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { Popover } from '../../../../shared/ui/popover/Popover';
import { Tooltip } from '../../../../shared/ui/tooltip/Tooltip';
import './TaskPriorityPicker.css';

export function TaskPriorityPicker({
  value,
  disabled,
  onChange,
}: {
  value: Task['priority'];
  disabled: boolean;
  onChange(value: Task['priority']): void;
}) {
  return (
    <Tooltip label={value === 'none' ? 'priority' : `${value} priority`}>
      <Popover
        label="priority"
        disabled={disabled}
        trigger={
          <Icon
            name="flag"
            size={16}
            className={value === 'none' ? '' : 'task-priority-picker__assigned'}
          />
        }
        className="task-priority-picker"
      >
        {(close) => (
          <div className="popover__menu" role="group" aria-label="task priority">
            {(['none', 'low', 'medium', 'high'] as const).map((priority) => (
              <button
                key={priority}
                type="button"
                className="popover__item"
                aria-pressed={priority === value}
                onClick={() => {
                  onChange(priority);
                  close();
                }}
              >
                <Icon name="flag" size={14} />
                <span>{priority === 'none' ? 'no priority' : priority}</span>
                {priority === value && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </Tooltip>
  );
}
