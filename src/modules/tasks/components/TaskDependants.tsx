import type { TaskDependant } from '../query-contract';
import { Icon } from '../../../ui/Icon';

export interface TaskDependantsProps {
  accountId: string;
  completed: boolean;
  items: readonly TaskDependant[];
  loading: boolean;
  loaded: boolean;
  error: string;
  nextCursor: string | null;
  stale: boolean;
  pending: boolean;
  onRetry(): void;
  onMore(): void;
  onOpenTask(taskId: string): void;
}

export function TaskDependants(props: TaskDependantsProps) {
  const items = props.items.filter((item) => item.accountId === props.accountId);
  return (
    <section className="task-editor__dependants" aria-label="tasks that depend on this task">
      <h4>
        used as a blocker by{' '}
        <span>
          {items.length}
          {props.nextCursor ? ' loaded' : ''}
        </span>
      </h4>
      {props.completed && items.length > 0 && (
        <p className="task-editor__hint">
          this completed task does not currently block them. reopening it makes the saved dependency
          active again.
        </p>
      )}
      {items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <Icon
                name={item.providerMissing ? 'warning' : item.completed ? 'check' : 'link'}
                size={13}
              />
              <button
                type="button"
                disabled={props.pending}
                onClick={() => props.onOpenTask(item.id)}
              >
                <span>{item.title || 'untitled task'}</span>
                <small>
                  {item.parentId ? `${item.parentTitle || 'parent not loaded'} · ` : ''}
                  {item.listTitle || 'untitled list'} ·{' '}
                  {item.providerMissing ? 'status unknown' : item.completed ? 'completed' : 'open'}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {props.loading && (
        <p className="task-editor__hint" role="status">
          loading dependent tasks…
        </p>
      )}
      {props.error && (
        <div role="alert">
          <p className="task-editor__field-error">{props.error}</p>
          <button
            type="button"
            className="task-editor__text-button"
            disabled={props.loading}
            onClick={props.onRetry}
          >
            refresh dependent tasks
          </button>
        </div>
      )}
      {props.loaded && !props.loading && !props.error && !items.length && (
        <p className="task-editor__hint">no saved task depends on this task.</p>
      )}
      {props.nextCursor && (
        <button
          type="button"
          className="task-editor__text-button"
          disabled={props.loading}
          onClick={props.onMore}
        >
          more dependent tasks
          <Icon name="down" size={12} />
        </button>
      )}
      {props.stale && items.length > 0 && (
        <p className="task-editor__hint">
          saved dependencies · provider completion states may need a refresh.
        </p>
      )}
    </section>
  );
}
