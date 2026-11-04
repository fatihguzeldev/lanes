import type { Task } from '../../contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';

interface Props {
  blockedBy: readonly string[];
  related: readonly Task[];
  listId: string;
  localEnabled: boolean;
  query: string;
  onQuery(value: string): void;
  onToggle(id: string): void;
  scope: 'board' | 'account' | undefined;
  loading: boolean | undefined;
  error: string | null | undefined;
  hasMore: boolean | undefined;
  onLoadMore: (() => void) | undefined;
  remoteSearch: boolean;
}
const title = (task: Task) => task.title.trim() || 'untitled task';

export function TaskDependencies({
  blockedBy,
  related,
  listId,
  localEnabled,
  query,
  onQuery,
  onToggle,
  scope,
  loading,
  error,
  hasMore,
  onLoadMore,
  remoteSearch,
}: Props) {
  return (
    <details
      className="task-editor__disclosure task-editor__dependencies"
      open={blockedBy.length > 0 || undefined}
    >
      <summary>
        <Icon name="link" size={13} />
        blocked by{' '}
        {blockedBy.length ? <span>{blockedBy.length}/50</span> : <span>add a dependency</span>}
        <Icon name="down" size={12} />
      </summary>
      {blockedBy.length > 0 && (
        <ul className="task-editor__blockers">
          {blockedBy.map((id) => {
            const blocker = related.find((item) => item.id === id);
            return (
              <li key={id}>
                <Icon
                  name={
                    blocker && !blocker.provider.missing
                      ? blocker.completed
                        ? 'check'
                        : 'link'
                      : 'warning'
                  }
                  size={13}
                />
                <span>
                  {blocker ? title(blocker) : 'blocker not loaded'}
                  <small>
                    {blocker && !blocker.provider.missing
                      ? blocker.completed
                        ? 'completed · no longer blocks'
                        : 'open'
                      : 'status unknown · retained'}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={!localEnabled}
                  onClick={() => onToggle(id)}
                  aria-label={`remove ${blocker ? title(blocker) : 'unloaded blocker'}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label className="task-editor__dependency-search">
        search {scope === 'account' ? 'this account' : 'this board'}
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          disabled={!localEnabled}
          placeholder="find a task…"
        />
      </label>
      {loading && (
        <p className="task-editor__hint" role="status">
          looking for tasks…
        </p>
      )}
      {error && (
        <p className="task-editor__field-error" role="alert">
          {error}
        </p>
      )}
      <div className="task-editor__dependency-results" aria-label="tasks to add as blockers">
        {related
          .filter(
            (item) =>
              !blockedBy.includes(item.id) &&
              (!query ||
                remoteSearch ||
                title(item).toLocaleLowerCase().includes(query.toLocaleLowerCase())),
          )
          .map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={!localEnabled || blockedBy.length >= 50}
              onClick={() => onToggle(item.id)}
            >
              <Icon name="plus" size={13} />
              <span>{title(item)}</span>
              <small>
                {item.provider.missing
                  ? 'status unknown'
                  : item.completed
                    ? 'completed'
                    : item.listId === listId
                      ? 'same list'
                      : 'another list'}
              </small>
            </button>
          ))}
      </div>
      {hasMore && onLoadMore && (
        <button
          className="task-editor__text-button"
          type="button"
          onClick={onLoadMore}
          disabled={loading}
        >
          load more tasks
          <Icon name="down" size={12} />
        </button>
      )}
      {!related.length && !loading && !error && (
        <p className="task-editor__hint">
          no loaded matches. existing blockers keep their identity until they can be checked.
        </p>
      )}
    </details>
  );
}
