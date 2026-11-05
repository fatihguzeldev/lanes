import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';
import './TaskCard.css';

export function TaskCardSkeleton() {
  return (
    <div className="task-card" aria-hidden="true">
      <div className="task-card__main">
        <div className="task-card__top">
          <span className="task-card__check" />
          <span className="task-card__title task-card__skeleton-title">
            &nbsp;
            <Skeleton />
          </span>
        </div>
      </div>
    </div>
  );
}
