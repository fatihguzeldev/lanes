import type { Task } from '../../contracts/task';
import type { TaskEditorProps } from './editor-contract';
import { Icon } from '../../../../shared/ui/icon/Icon';

interface Props extends Pick<
  TaskEditorProps,
  | 'onToggleComplete'
  | 'providerWritesEnabled'
  | 'onOpenTask'
  | 'subtasks'
  | 'onLoadMoreSubtasks'
  | 'onCreateSubtask'
> {
  task: Task;
  children: readonly Task[];
  providerEnabled: boolean;
  pending: boolean;
  inputId(field: string): string;
}
const title = (task: Task) => task.title.trim() || 'untitled task';

export function TaskChecklist({
  task,
  children,
  providerEnabled,
  pending,
  inputId,
  onToggleComplete,
  providerWritesEnabled,
  onOpenTask,
  subtasks,
  onLoadMoreSubtasks,
  onCreateSubtask,
}: Props) {
  return (
    <section
      className="task-editor__section task-editor__subtasks"
      aria-labelledby={inputId('subtasks-heading')}
    >
      <h3 id={inputId('subtasks-heading')}>
        <Icon name="subtasks" size={14} />
        subtasks{' '}
        <span>
          {children.length}
          {subtasks?.coverage.complete && !subtasks.nextCursor ? '' : ' loaded'}
        </span>
      </h3>
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <li key={child.id}>
              <button
                className="task-editor__complete"
                type="button"
                role="checkbox"
                aria-checked={child.completed}
                aria-label={`${child.completed ? 'reopen' : 'complete'} ${title(child)}`}
                disabled={
                  !onToggleComplete ||
                  !providerWritesEnabled ||
                  pending ||
                  !child.capabilities.canEdit ||
                  child.unsupportedHierarchy
                }
                onClick={() => onToggleComplete?.(child, !child.completed)}
              >
                {child.completed && <Icon name="check" size={10} />}
              </button>
              <button
                type="button"
                className={child.completed ? 'is-completed' : ''}
                onClick={() => onOpenTask?.(child)}
                disabled={!onOpenTask || pending}
              >
                {title(child)}
              </button>
              {child.scheduledDay && <small>{child.scheduledDay}</small>}
            </li>
          ))}
        </ul>
      )}
      {subtasks?.pending && (
        <p className="task-editor__hint" role="status">
          loading subtasks…
        </p>
      )}
      {!children.length && subtasks?.coverage.complete && (
        <p className="task-editor__hint">no subtasks.</p>
      )}
      {!subtasks?.coverage.complete && !subtasks?.pending && (
        <p className="task-editor__hint">
          subtask coverage is incomplete; loaded work stays visible.
        </p>
      )}
      <div className="task-editor__subtask-actions">
        {subtasks?.nextCursor && onLoadMoreSubtasks && (
          <button
            className="task-editor__text-button"
            type="button"
            onClick={onLoadMoreSubtasks}
            disabled={subtasks.pending}
          >
            load more
            <Icon name="down" size={12} />
          </button>
        )}
        {onCreateSubtask && (
          <button
            className="task-editor__text-button"
            type="button"
            disabled={!providerEnabled || !task.capabilities.canHaveChildren}
            onClick={() => onCreateSubtask?.(task)}
          >
            <Icon name="plus" size={13} />
            add subtask
          </button>
        )}
      </div>
    </section>
  );
}
