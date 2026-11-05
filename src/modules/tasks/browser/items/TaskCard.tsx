import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Icon } from '../../../../shared/ui/icon/Icon';
import type { BlockingState, Label, Task } from '../../contracts/task';
import { countOpenTasks, getBlockingState } from '../../model/task';
import { addCalendarDays } from '../../model/planning';
import './TaskCard.css';
import type { SubtaskSummary } from '../../contracts/query';

export interface TaskCardProps {
  task: Task;
  subtasks: readonly Task[];
  subtaskSummary?: SubtaskSummary | undefined;
  blockingState?: BlockingState | undefined;
  relatedTasks: readonly Task[];
  labels: readonly Label[];
  today: string;
  accountTimeZone: string;
  pending?: boolean;
  pendingTaskIds?: ReadonlySet<string>;
  providerActionsEnabled?: boolean;
  contextOnly?: boolean;
  parentTitle?: string;
  initiallyExpanded?: boolean;
  expanded?: boolean | undefined;
  onExpandedChange?: ((expanded: boolean) => void) | undefined;
  showNotes?: boolean;
  layout?: 'column' | 'row';
  onOpen: (task: Task) => void;
  onToggleComplete: (task: Task, completed: boolean) => void;
  onMenu?: (task: Task, anchor: HTMLButtonElement) => void;
}

const shortDay = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const taskTitle = (task: Task): string => (task.title.trim() ? task.title : 'untitled task');

function scheduledText(day: string, today: string): string {
  if (day === today) return 'today';
  if (day === addCalendarDays(today, 1)) return 'tomorrow';
  return shortDay.format(new Date(`${day}T12:00:00Z`)).toLowerCase();
}

function DueDate({
  task,
  today,
  accountTimeZone,
}: Pick<TaskCardProps, 'task' | 'today' | 'accountTimeZone'>) {
  if (!task.scheduledDay) return null;
  const overdue = !task.completed && task.scheduledDay < today;
  const zone = task.timeZone && task.timeZone !== accountTimeZone ? task.timeZone : null;
  return (
    <span
      className={`task-card__date${overdue ? ' task-card__date--overdue' : ''}${task.scheduledDay === today ? ' task-card__date--today' : ''}`}
      title={[task.scheduledDay, task.scheduledTime, task.timeZone].filter(Boolean).join(' · ')}
    >
      <Icon name={task.scheduledDay === today ? 'sun' : 'calendar'} size={12} />
      <span>
        {scheduledText(task.scheduledDay, today)}
        {task.scheduledTime ? ` · ${task.scheduledTime}` : ''}
        {zone ? ` · ${zone}` : ''}
      </span>
      {overdue && <span className="task-card__sr-only">overdue</span>}
    </span>
  );
}

function CompletionButton({
  task,
  disabled,
  onToggle,
}: {
  task: Task;
  disabled: boolean;
  onToggle: TaskCardProps['onToggleComplete'];
}) {
  return (
    <button
      className={`task-card__check${task.completed ? ' task-card__check--completed' : ''}`}
      type="button"
      role="checkbox"
      aria-checked={task.completed}
      aria-label={`${task.completed ? 'reopen' : 'complete'} ${taskTitle(task)}`}
      title={disabled ? 'completion is unavailable; open the task for details' : undefined}
      disabled={disabled}
      onClick={() => onToggle(task, !task.completed)}
    >
      {task.completed && <Icon name="check" size={11} />}
    </button>
  );
}

export function TaskCard({
  task,
  subtasks,
  subtaskSummary,
  blockingState,
  relatedTasks,
  labels,
  today,
  accountTimeZone,
  pending = false,
  pendingTaskIds,
  providerActionsEnabled = true,
  contextOnly = false,
  parentTitle,
  initiallyExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  showNotes = true,
  layout = 'column',
  onOpen,
  onToggleComplete,
  onMenu,
}: TaskCardProps) {
  const [localExpanded, setLocalExpanded] = useState(initiallyExpanded);
  const expanded = controlledExpanded ?? localExpanded;
  useEffect(() => {
    if (initiallyExpanded && controlledExpanded === undefined) setLocalExpanded(true);
  }, [initiallyExpanded, controlledExpanded]);
  const childrenId = useId();
  const children = subtasks.filter(
    (child) =>
      child.accountId === task.accountId &&
      child.listId === task.listId &&
      child.parentId === task.id,
  );
  const openChildren = countOpenTasks(children, task.accountId);
  const childTotal = subtaskSummary?.total ?? children.length;
  const childOpen = subtaskSummary?.open ?? openChildren;
  const childCountsKnown = subtaskSummary?.complete ?? false;
  const partialChildren = !childCountsKnown || childTotal > children.length;
  const blocking = blockingState ?? getBlockingState(task, relatedTasks);
  const taskLabels = labels.filter(
    (label) => label.accountId === task.accountId && task.labelIds.includes(label.id),
  );
  const restriction =
    task.capabilities.restriction ??
    (task.unsupportedHierarchy ? 'google returned a hierarchy lanes cannot safely edit' : null);
  const restrictionText = [
    restriction,
    task.capabilities.assignmentSource ? `assigned in ${task.capabilities.assignmentSource}` : null,
  ]
    .filter(Boolean)
    .join('. ');
  const excerpt = Array.from(task.notes).slice(0, 240).join('');
  const canComplete =
    providerActionsEnabled && task.capabilities.canEdit && !task.unsupportedHierarchy && !pending;
  const showMetadata =
    task.scheduledDay ||
    taskLabels.length ||
    childTotal ||
    task.repeatRule ||
    blocking.state !== 'unblocked';

  return (
    <article
      className={`task-card task-card--${layout}${task.completed ? ' task-card--completed' : ''}${pending ? ' task-card--pending' : ''}${contextOnly ? ' task-card--context' : ''}`}
      role="listitem"
      aria-busy={pending || undefined}
      data-task-id={task.id}
      data-account-id={task.accountId}
    >
      <div className="task-card__main">
        {parentTitle && <p className="task-card__parent">in {parentTitle}</p>}
        <div className="task-card__top">
          <CompletionButton task={task} disabled={!canComplete} onToggle={onToggleComplete} />
          <button className="task-card__title" type="button" onClick={() => onOpen(task)}>
            {taskTitle(task)}
          </button>
          {task.starred && (
            <Icon name="star" size={12} title="starred" className="task-card__star" />
          )}
          {task.priority !== 'none' && (
            <span
              className={`task-card__priority task-card__priority--${task.priority}`}
              title={`${task.priority} priority`}
            >
              <span aria-hidden="true">
                {task.priority === 'high' ? '!!' : task.priority === 'medium' ? '!' : '↓'}
              </span>
              <span className="task-card__sr-only">{task.priority} priority</span>
            </span>
          )}
          {restrictionText && (
            <span
              className="task-card__restriction-icon"
              role="img"
              aria-label={restrictionText}
              title={restrictionText}
            >
              <Icon name={task.unsupportedHierarchy ? 'warning' : 'lock'} size={12} />
            </span>
          )}
          {onMenu && (
            <button
              className="task-card__menu"
              type="button"
              aria-label={`options for ${taskTitle(task)}`}
              onClick={(event) => onMenu(task, event.currentTarget)}
            >
              <Icon name="more" size={15} />
            </button>
          )}
        </div>
        {contextOnly && <span className="task-card__context-label">parent context</span>}
        {showNotes && excerpt && (
          <p className="task-card__notes">
            {excerpt}
            {excerpt !== task.notes ? '…' : ''}
          </p>
        )}
        {showMetadata && (
          <div className="task-card__meta">
            <DueDate task={task} today={today} accountTimeZone={accountTimeZone} />
            {taskLabels.map((label) => (
              <span
                className="task-card__label"
                key={label.id}
                style={{ '--task-label-color': label.color } as CSSProperties}
              >
                <i aria-hidden="true" />
                {label.name}
              </span>
            ))}
            {task.repeatRule && (
              <span
                className="task-card__repeat"
                title="a lanes repeat rule; native google repeat rules are separate"
              >
                <Icon name="sync" size={12} />
                repeats
              </span>
            )}
            {blocking.state === 'blocked' && (
              <span
                className="task-card__blocked"
                title={blocking.openBlockers.map((blocker) => taskTitle(blocker)).join(', ')}
              >
                <Icon name="link" size={12} />
                {blocking.openBlockers.length}{' '}
                {blocking.openBlockers.length === 1 ? 'blocker' : 'blockers'}
              </span>
            )}
            {blocking.state === 'unknown' && (
              <span className="task-card__blocked">
                <Icon name="warning" size={12} />
                blocker status unknown
              </span>
            )}
            {childTotal > 0 && (
              <button
                className="task-card__subtasks-toggle"
                type="button"
                aria-expanded={partialChildren ? undefined : expanded}
                aria-controls={partialChildren ? undefined : childrenId}
                aria-label={
                  childCountsKnown
                    ? `${partialChildren ? 'open checklist with' : expanded ? 'hide' : 'show'} ${childTotal} subtasks, ${childOpen} open`
                    : 'open checklist'
                }
                onClick={() => {
                  if (partialChildren) return onOpen(task);
                  const next = !expanded;
                  if (controlledExpanded === undefined) setLocalExpanded(next);
                  onExpandedChange?.(next);
                }}
              >
                <Icon name="subtasks" size={12} />
                <span>
                  {childCountsKnown ? `${childTotal - childOpen}/${childTotal}` : 'checklist'}
                </span>
                <Icon name={expanded && !partialChildren ? 'down' : 'right'} size={11} />
              </button>
            )}
          </div>
        )}
      </div>
      {children.length > 0 && (
        <ul
          className="task-card__children"
          id={childrenId}
          aria-label={`subtasks of ${taskTitle(task)}`}
          hidden={!expanded}
        >
          {expanded &&
            children.map((child) => {
              const childPending = pendingTaskIds?.has(child.id) ?? false;
              return (
                <li
                  className={`task-card__child${child.completed ? ' task-card__child--completed' : ''}`}
                  key={child.id}
                  aria-busy={childPending || undefined}
                >
                  <CompletionButton
                    task={child}
                    disabled={
                      pending ||
                      childPending ||
                      !providerActionsEnabled ||
                      !child.capabilities.canEdit ||
                      child.unsupportedHierarchy
                    }
                    onToggle={onToggleComplete}
                  />
                  <div className="task-card__child-content">
                    <button
                      className="task-card__child-title"
                      type="button"
                      onClick={() => onOpen(child)}
                    >
                      {taskTitle(child)}
                    </button>
                    <DueDate task={child} today={today} accountTimeZone={accountTimeZone} />
                  </div>
                  {onMenu && (
                    <button
                      className="task-card__menu"
                      type="button"
                      aria-label={`options for ${taskTitle(child)}`}
                      onClick={(event) => onMenu(child, event.currentTarget)}
                    >
                      <Icon name="more" size={14} />
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </article>
  );
}
