import type { PendingTaskCreation } from './useTaskCreations';
import '../items/TaskCard.css';
import './TaskCreationPreview.css';

export function TaskCreationPreview({ creation }: { creation: PendingTaskCreation }) {
  return (
    <div
      className="task-card task-creation-preview"
      role="group"
      aria-label={creation.input.title}
      aria-busy="true"
    >
      <div className="task-card__main">
        <div className="task-card__top">
          <button
            className="task-card__check"
            type="button"
            role="checkbox"
            aria-checked="false"
            aria-label={`complete ${creation.input.title}`}
            disabled
          />
          <span className="task-card__title">{creation.input.title}</span>
        </div>
        {creation.input.notes && <p className="task-card__notes">{creation.input.notes}</p>}
      </div>
    </div>
  );
}
