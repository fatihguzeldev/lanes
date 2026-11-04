import { Skeleton } from '../../../ui/Skeleton';
import './BoardSurface.css';

export function ColumnSkeleton() {
  return (
    <div className="board-column__skeleton" aria-hidden="true">
      {[0, 1, 2].map((id) => (
        <div className="board-column__skeleton-row" key={id}>
          <Skeleton className="board-skeleton__check" />
          <Skeleton className="board-skeleton__task-title" />
        </div>
      ))}
    </div>
  );
}

export function BoardSkeleton() {
  return (
    <div className="board-surface__grid" role="status">
      <span className="board-surface__sr-only">loading your lists…</span>
      {[0, 1, 2, 3].map((id) => (
        <div className="board-column board-column--skeleton" key={id} aria-hidden="true">
          <div className="board-column__header">
            <Skeleton className="board-skeleton__symbol" />
            <Skeleton className="board-skeleton__list-title" />
            <Skeleton className="board-skeleton__count" />
            <Skeleton className="board-skeleton__menu" />
          </div>
          <div className="board-column__skeleton-add">
            <Skeleton className="board-skeleton__add-symbol" />
            <Skeleton className="board-skeleton__add-title" />
          </div>
          <ColumnSkeleton />
        </div>
      ))}
    </div>
  );
}
