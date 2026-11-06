import type { CompletedGroup } from '../../../history/model/completion/types';
import type { Task } from '../../../tasks/contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';

interface Props {
  groups: readonly CompletedGroup[];
  timeZone: string;
  listName(id: string): string;
  onOpenTask(task: Task): void;
  onTaskMenu?: (task: Task, anchor: HTMLButtonElement) => void;
}
const groupNames = {
  today: 'today',
  yesterday: 'yesterday',
  this_week: 'this week',
  earlier: 'earlier',
  unknown_time: 'completion time unavailable',
  future: 'future completion dates',
};
export function CompletedTaskGroups({ groups, timeZone, listName, onOpenTask, onTaskMenu }: Props) {
  const completionTime = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return groups.map((group) => (
    <section className="completed-workspace__group" key={group.key}>
      <h3>{groupNames[group.key]}</h3>
      <ul>
        {group.items.map(({ task, parent }) => (
          <li key={task.id}>
            <Icon name="check" size={14} />
            <div>
              <button
                className="completed-workspace__task"
                type="button"
                onClick={() => onOpenTask(task)}
              >
                {task.title.trim() || 'untitled task'}
              </button>
              <p>
                {task.parentId ? `${parent?.title.trim() || 'parent not loaded'} · ` : ''}
                {listName(task.listId)}
                {task.completedAt && (
                  <>
                    {' '}
                    ·{' '}
                    <time dateTime={task.completedAt}>
                      {completionTime.format(new Date(task.completedAt)).toLowerCase()}
                    </time>
                  </>
                )}
              </p>
            </div>
            {onTaskMenu && (
              <button
                className="completed-workspace__menu"
                type="button"
                aria-label={`options for ${task.title.trim() || 'untitled task'}`}
                onClick={(event) => onTaskMenu(task, event.currentTarget)}
              >
                <Icon name="more" size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  ));
}
