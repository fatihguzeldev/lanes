import type { PendingTaskCreation } from './creation-model';
import '../items/TaskCard.css';
import './TaskCreationPreview.css';
import '../items/TaskStarButton.css';
import { Icon } from '../../../../shared/ui/icon/Icon';

export function TaskCreationPreview({
  creation,
  child = false,
  parentTitle,
}: {
  creation: PendingTaskCreation;
  child?: boolean;
  parentTitle?: string | undefined;
}) {
  if (creation.deleted) return null;
  const controls = creation.controls;
  const completed = !!creation.completed;
  const recovery = creation.failure && (
    <div className="task-creation-preview__recovery">
      <span role="alert">{creation.failure.message}</span>
      <button
        type="button"
        aria-label={`${creation.failure.actionLabel ?? 'edit'} ${creation.input.title}`}
        onClick={creation.failure.onEdit}
      >
        {creation.failure.actionLabel ?? 'edit'}
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
      className={`task-card__check${completed ? ' task-card__check--completed' : ''}`}
      type="button"
      role="checkbox"
      aria-checked={completed}
      aria-label={`${completed ? 'reopen' : 'complete'} ${creation.input.title}`}
      disabled={!controls || controls.disabled}
      onClick={() => controls?.onComplete(!completed)}
    >
      {completed && <Icon name="check" size={11} />}
    </button>
  );
  const actions = controls && (
    <div className="task-card__actions">
      <button
        type="button"
        className="task-star-button"
        aria-label={`${creation.input.starred ? 'unstar' : 'star'} ${creation.input.title}`}
        aria-pressed={creation.input.starred}
        disabled={controls.disabled}
        onClick={() => controls.onStar(!creation.input.starred)}
      >
        <Icon name="star" size={14} />
      </button>
      <button
        type="button"
        className="task-card__menu"
        aria-label={`delete ${creation.input.title}`}
        disabled={controls.disabled}
        onClick={controls.onDelete}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
  const title = (className: string) =>
    controls ? (
      <button
        type="button"
        className={className}
        disabled={controls.disabled}
        onClick={controls.onEdit}
      >
        {creation.input.title}
      </button>
    ) : (
      <span className={className}>{creation.input.title}</span>
    );
  if (child)
    return (
      <li className="task-card__child task-creation-preview">
        {completion}
        <div className="task-card__child-content">
          {title('task-card__child-title')}
          {recovery}
        </div>
        {actions}
      </li>
    );
  return (
    <div
      className={`task-card task-creation-preview${completed ? ' task-card--completed' : ''}`}
      role="group"
      aria-label={creation.input.title}
    >
      <div className="task-card__main">
        {parentTitle && <p className="task-card__parent">in {parentTitle}</p>}
        <div className="task-card__top">
          {completion}
          {title('task-card__title')}
          {actions}
        </div>
        {creation.input.notes && <p className="task-card__notes">{creation.input.notes}</p>}
        {recovery}
      </div>
    </div>
  );
}
