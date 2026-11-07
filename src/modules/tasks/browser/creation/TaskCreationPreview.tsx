import type { PendingTaskCreation } from './useTaskCreations';
import '../items/TaskCard.css';
import './TaskCreationPreview.css';

export function TaskCreationPreview({
  creation,
  child = false,
  parentTitle,
}: {
  creation: PendingTaskCreation;
  child?: boolean;
  parentTitle?: string | undefined;
}) {
  const recovery = creation.failure && (
    <div className="task-creation-preview__recovery">
      <span role="alert">{creation.failure.message}</span>
      <button
        type="button"
        aria-label={`edit ${creation.input.title}`}
        onClick={creation.failure.onEdit}
      >
        edit
      </button>
      <button
        type="button"
        aria-label={`discard ${creation.input.title}`}
        onClick={creation.failure.onDiscard}
      >
        discard
      </button>
    </div>
  );
  const completion = (
    <button
      className="task-card__check"
      type="button"
      role="checkbox"
      aria-checked="false"
      aria-label={`complete ${creation.input.title}`}
      disabled
    />
  );
  if (child)
    return (
      <li
        className="task-card__child task-creation-preview"
        aria-busy={creation.failure ? undefined : true}
      >
        {completion}
        <div className="task-card__child-content">
          <span className="task-card__child-title">{creation.input.title}</span>
          {recovery}
        </div>
      </li>
    );
  return (
    <div
      className="task-card task-creation-preview"
      role="group"
      aria-label={creation.input.title}
      aria-busy={creation.failure ? undefined : true}
    >
      <div className="task-card__main">
        {parentTitle && <p className="task-card__parent">in {parentTitle}</p>}
        <div className="task-card__top">
          {completion}
          <span className="task-card__title">{creation.input.title}</span>
        </div>
        {creation.input.notes && <p className="task-card__notes">{creation.input.notes}</p>}
        {recovery}
      </div>
    </div>
  );
}
