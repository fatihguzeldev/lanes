import { Icon } from '../../../../shared/ui/icon/Icon';
import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';
import { TaskCardSkeleton } from '../../../tasks/browser/items/TaskCardSkeleton';
import { InlineTaskCreatePlaceholder } from '../../../tasks/browser/creation/InlineTaskCreatePlaceholder';
import './BoardSurface.css';

export function ColumnSkeleton() {
  return (
    <div className="board-column__skeleton" aria-hidden="true">
      {[0, 1, 2].map((id) => (
        <TaskCardSkeleton key={id} />
      ))}
    </div>
  );
}

export function BoardSkeleton({
  showAddList = false,
  showCounts = true,
}: {
  showAddList?: boolean;
  showCounts?: boolean;
}) {
  return (
    <div className="board-surface__grid" role="status">
      <span className="board-surface__sr-only">loading your lists…</span>
      {[0, 1, 2, 3].map((id) => (
        <div className="board-column board-column--skeleton" key={id} aria-hidden="true">
          <div className="board-column__header">
            <span className="board-column__symbol">
              <Icon name="list" size={16} />
            </span>
            <Skeleton className="board-skeleton__list-title" />
            {showCounts && <Skeleton className="board-skeleton__count" />}
            <span className="board-column__menu">
              <Icon name="more" size={16} />
            </span>
          </div>
          <InlineTaskCreatePlaceholder />
          <ColumnSkeleton />
        </div>
      ))}
      {showAddList && (
        <button
          type="button"
          tabIndex={-1}
          className="board-surface__add-list board-skeleton__add-list"
          aria-hidden="true"
        >
          <Icon name="plus" size={14} />
          new list
        </button>
      )}
    </div>
  );
}
