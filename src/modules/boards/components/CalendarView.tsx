import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Coverage } from '../../../contracts/http';
import { Icon } from '../../../ui/Icon';
import type { Task, TaskList } from '../../tasks/contracts';
import {
  calendarGrid,
  calendarRange,
  groupCalendarTasks,
  moveCalendarCursor,
  type CalendarBucket,
  type CalendarDay,
  type CalendarDaySelection,
  type CalendarMode,
  type CalendarRange,
  type CalendarScope,
} from './calendar-model';
import { Select } from '../../../ui/Select';
import './CalendarView.css';

export type { CalendarMode, CalendarScope } from './calendar-model';
export type { CalendarCreateIntent, CalendarDaySelection } from './calendar-model';
export interface CalendarRescheduleIntent {
  accountId: string;
  taskId: string;
  listId: string;
  revision: number;
  scheduledDay: string | null;
}
export interface CalendarRangeRequest extends CalendarRange {
  accountId: string;
  boardId: string;
  mode: CalendarMode;
  scope: CalendarScope;
}
export interface CalendarViewProps {
  accountId: string;
  boardId: string;
  tasks: readonly Task[];
  relatedTasks?: readonly Task[] | undefined;
  lists: readonly TaskList[];
  today: string;
  accountTimeZone: string;
  weekStart: 1 | 7;
  mode: CalendarMode;
  scope: CalendarScope;
  coverage: Coverage;
  status?: 'loading' | 'ready' | 'error' | undefined;
  nextCursor?: string | null | undefined;
  errorMessage?: string | undefined;
  providerActionsEnabled?: boolean | undefined;
  readOnlyReason?: string | undefined;
  pendingTaskIds?: ReadonlySet<string> | undefined;
  matchedTaskIds?: ReadonlySet<string> | undefined;
  onModeChange: (mode: CalendarMode) => void;
  onScopeChange: (scope: CalendarScope) => void;
  onOpenTask: (task: Task) => void;
  onTaskMenu: (task: Task, anchor: HTMLButtonElement) => void;
  onCreateTask: (intent: CalendarDaySelection) => void;
  onReschedule: (intent: CalendarRescheduleIntent) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRangeChange?: ((range: CalendarRangeRequest) => void) | undefined;
}

type DraggedTask = Omit<CalendarRescheduleIntent, 'scheduledDay'>;
const dragType = 'application/x-lanes-calendar-task+json';
const monthFormatter = new Intl.DateTimeFormat('en', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const yearFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const fullFormatter = new Intl.DateTimeFormat('en', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const toDate = (day: string): Date => new Date(`${day}T12:00:00Z`);
const taskTitle = (task: Task): string => (task.title.trim() ? task.title : 'untitled task');
const weekdayNames = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function periodTitle(cursorDay: string, mode: CalendarMode, range: CalendarRange): string {
  if (mode === 'month') return monthFormatter.format(toDate(cursorDay)).toLowerCase();
  if (range.from.slice(0, 4) !== range.to.slice(0, 4))
    return `${yearFormatter.format(toDate(range.from))} – ${yearFormatter.format(toDate(range.to))}`.toLowerCase();
  return `${shortFormatter.format(toDate(range.from))} – ${shortFormatter.format(toDate(range.to))}, ${range.to.slice(0, 4)}`.toLowerCase();
}

function knownTasks(tasks: readonly Task[], accountId: string): Map<string, Task> {
  const result = new Map<string, Task>();
  for (const task of tasks) {
    if (task.accountId !== accountId) continue;
    const old = result.get(task.id);
    if (!old || old.revision < task.revision) result.set(task.id, task);
  }
  return result;
}

function readDrag(data: string): DraggedTask | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.accountId !== 'string' ||
      typeof row.taskId !== 'string' ||
      typeof row.listId !== 'string' ||
      typeof row.revision !== 'number' ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0
    )
      return null;
    return {
      accountId: row.accountId,
      taskId: row.taskId,
      listId: row.listId,
      revision: row.revision,
    };
  } catch {
    return null;
  }
}

interface ItemProps {
  task: Task;
  options: CalendarViewProps;
  context: ReadonlyMap<string, Task>;
  listNames: ReadonlyMap<string, string>;
  startDrag: (task: Task, event: DragEvent<HTMLElement>) => void;
  endDrag: () => void;
}

function CalendarItem({ task, options, context, listNames, startDrag, endDrag }: ItemProps) {
  const pending = options.pendingTaskIds?.has(task.id) ?? false;
  const draggable =
    options.providerActionsEnabled !== false &&
    task.capabilities.canEdit &&
    !task.unsupportedHierarchy &&
    !pending;
  const parent = task.parentId ? context.get(task.parentId) : null;
  const zone = task.timeZone && task.timeZone !== options.accountTimeZone ? task.timeZone : null;
  return (
    <article
      className={`calendar-item${task.completed ? ' calendar-item--completed' : ''}${pending ? ' calendar-item--pending' : ''}`}
      role="listitem"
      data-calendar-task-id={task.id}
      aria-busy={pending || undefined}
      draggable={draggable}
      onDragStart={(event) => startDrag(task, event)}
      onDragEnd={endDrag}
    >
      <div className="calendar-item__top">
        <button
          className="calendar-item__title"
          type="button"
          onClick={() => options.onOpenTask(task)}
        >
          {task.completed && <Icon name="check" size={11} title="completed" />}
          {taskTitle(task)}
        </button>
        {task.starred && (
          <Icon name="star" size={11} className="calendar-item__star" title="starred" />
        )}
        <button
          className="calendar-item__menu"
          type="button"
          aria-label={`options for ${taskTitle(task)}`}
          onClick={(event) => options.onTaskMenu(task, event.currentTarget)}
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      {task.scheduledTime && (
        <p className="calendar-item__time">
          <Icon name="clock" size={11} />
          {task.scheduledTime}
          {zone && <span>{zone}</span>}
        </p>
      )}
      {task.parentId && (
        <p className="calendar-item__parent">
          <Icon name="subtasks" size={11} />
          {parent ? taskTitle(parent) : 'parent not loaded'}
        </p>
      )}
      <p className="calendar-item__list">{listNames.get(task.listId) || 'list not loaded'}</p>
      {task.unsupportedHierarchy && (
        <p className="calendar-item__restriction">
          <Icon name="warning" size={11} />
          unsupported hierarchy
        </p>
      )}
      {!task.capabilities.canEdit && (
        <p
          className="calendar-item__restriction"
          title={task.capabilities.restriction ?? undefined}
        >
          <Icon name="lock" size={11} />
          read-only task
        </p>
      )}
      {pending && (
        <span className="calendar-item__saving" role="status">
          saving…
        </span>
      )}
    </article>
  );
}

interface DayCellProps {
  day: CalendarDay;
  bucket: CalendarBucket | undefined;
  options: CalendarViewProps;
  dragging: DraggedTask | null;
  dropTarget: string | null;
  itemProps: Omit<ItemProps, 'task'>;
  inspectDay: (day: string) => void;
  dragOver: (day: string | null, event: DragEvent<HTMLElement>) => void;
  drop: (day: string | null, event: DragEvent<HTMLElement>) => void;
}

function DayCell({
  day,
  bucket,
  options,
  dragging,
  dropTarget,
  itemProps,
  inspectDay,
  dragOver,
  drop,
}: DayCellProps) {
  const [expanded, setExpanded] = useState(false);
  const today = day.date === options.today;
  const dateOnly = bucket?.dateOnly ?? [];
  const timed = bucket?.timed ?? [];
  const limited = options.mode === 'month' && !expanded;
  const visibleDateOnly = limited ? dateOnly.slice(0, 3) : dateOnly;
  const visibleTimed = limited ? timed.slice(0, Math.max(0, 3 - visibleDateOnly.length)) : timed;
  const omitted = dateOnly.length + timed.length - visibleDateOnly.length - visibleTimed.length;
  const dateLabel = fullFormatter.format(toDate(day.date)).toLowerCase();
  return (
    <td
      className={`calendar-day${today ? ' calendar-day--today' : ''}${!day.inMonth ? ' calendar-day--outside' : ''}${dragging && dropTarget === day.date ? ' calendar-day--drop-target' : ''}`}
      onDragOver={(event) => dragOver(day.date, event)}
      onDrop={(event) => drop(day.date, event)}
    >
      <section className="calendar-day__content" aria-label={dateLabel}>
        <header className="calendar-day__header">
          {options.mode === 'month' ? (
            <button
              className="calendar-day__number"
              type="button"
              aria-current={today ? 'date' : undefined}
              aria-label={`show the week containing ${dateLabel}`}
              onClick={() => inspectDay(day.date)}
            >
              {day.day}
            </button>
          ) : (
            <span className="calendar-day__number" aria-current={today ? 'date' : undefined}>
              {day.day}
            </span>
          )}
          <button
            className="calendar-day__add"
            type="button"
            disabled={options.providerActionsEnabled === false}
            aria-label={`new task on ${dateLabel}`}
            onClick={() =>
              options.onCreateTask({ accountId: options.accountId, scheduledDay: day.date })
            }
          >
            <Icon name="plus" size={13} />
          </button>
        </header>
        {visibleDateOnly.length > 0 && (
          <div className="calendar-day__group">
            <p className="calendar-day__group-label">any time</p>
            <div role="list" aria-label={`date-only tasks on ${dateLabel}`}>
              {visibleDateOnly.map((task) => (
                <CalendarItem key={task.id} task={task} {...itemProps} />
              ))}
            </div>
          </div>
        )}
        {visibleTimed.length > 0 && (
          <div className="calendar-day__group calendar-day__group--timed">
            <p className="calendar-day__group-label">scheduled times</p>
            <div role="list" aria-label={`timed tasks on ${dateLabel}`}>
              {visibleTimed.map((task) => (
                <CalendarItem key={task.id} task={task} {...itemProps} />
              ))}
            </div>
          </div>
        )}
        {omitted > 0 && (
          <button className="calendar-day__more" type="button" onClick={() => setExpanded(true)}>
            show {omitted} more
          </button>
        )}
        {options.mode === 'month' && expanded && dateOnly.length + timed.length > 3 && (
          <button className="calendar-day__more" type="button" onClick={() => setExpanded(false)}>
            show less
          </button>
        )}
      </section>
    </td>
  );
}

export function CalendarView(options: CalendarViewProps) {
  const [cursor, setCursor] = useState({ accountId: options.accountId, day: options.today });
  const [unscheduledExpanded, setUnscheduledExpanded] = useState(true);
  const [dragging, setDragging] = useState<DraggedTask | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const unscheduledId = useId();
  const cursorDay = cursor.accountId === options.accountId ? cursor.day : options.today;
  const grid = useMemo(
    () => calendarGrid(cursorDay, options.mode, options.weekStart),
    [cursorDay, options.mode, options.weekStart],
  );
  const range = useMemo(
    () => calendarRange(cursorDay, options.mode, options.weekStart),
    [cursorDay, options.mode, options.weekStart],
  );
  const groups = useMemo(
    () =>
      groupCalendarTasks(options.tasks, {
        accountId: options.accountId,
        ...range,
        matchedTaskIds: options.matchedTaskIds,
      }),
    [options.tasks, options.accountId, options.matchedTaskIds, range.from, range.to],
  );
  const context = useMemo(
    () => knownTasks([...(options.relatedTasks ?? []), ...options.tasks], options.accountId),
    [options.relatedTasks, options.tasks, options.accountId],
  );
  const listNames = useMemo(
    () =>
      new Map(
        options.lists
          .filter((list) => list.accountId === options.accountId)
          .map((list) => [list.id, list.title.trim() ? list.title : 'untitled list']),
      ),
    [options.lists, options.accountId],
  );
  const rangeCallback = useRef(options.onRangeChange);
  useEffect(() => {
    rangeCallback.current = options.onRangeChange;
  }, [options.onRangeChange]);
  useEffect(() => {
    rangeCallback.current?.({
      accountId: options.accountId,
      boardId: options.boardId,
      scope: options.scope,
      mode: options.mode,
      from: range.from,
      to: range.to,
    });
  }, [options.accountId, options.boardId, options.scope, options.mode, range.from, range.to]);
  const status = options.status ?? 'ready';

  function startDrag(task: Task, event: DragEvent<HTMLElement>) {
    if (
      options.providerActionsEnabled === false ||
      task.accountId !== options.accountId ||
      !task.capabilities.canEdit ||
      task.unsupportedHierarchy ||
      options.pendingTaskIds?.has(task.id)
    ) {
      event.preventDefault();
      return;
    }
    const payload: DraggedTask = {
      accountId: task.accountId,
      taskId: task.id,
      listId: task.listId,
      revision: task.revision,
    };
    event.dataTransfer.setData(dragType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'move';
    setDragging(payload);
    setAnnouncement(`rescheduling ${taskTitle(task)}. task options provide keyboard date changes.`);
  }
  function endDrag() {
    setDragging(null);
    setDropTarget(null);
  }
  function dragOver(day: string | null, event: DragEvent<HTMLElement>) {
    if (
      !dragging ||
      dragging.accountId !== options.accountId ||
      options.providerActionsEnabled === false
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(day ?? 'unscheduled');
  }
  function drop(day: string | null, event: DragEvent<HTMLElement>) {
    if (!dragging || options.providerActionsEnabled === false) return;
    event.preventDefault();
    const payload = readDrag(event.dataTransfer.getData(dragType));
    const task = payload ? context.get(payload.taskId) : undefined;
    if (
      !payload ||
      !task ||
      payload.accountId !== options.accountId ||
      payload.accountId !== dragging.accountId ||
      payload.taskId !== dragging.taskId ||
      payload.listId !== dragging.listId ||
      payload.revision !== dragging.revision ||
      task.listId !== payload.listId ||
      task.revision !== payload.revision ||
      !task.capabilities.canEdit ||
      task.unsupportedHierarchy
    ) {
      endDrag();
      setAnnouncement('the task changed. choose its date again.');
      return;
    }
    if (task.scheduledDay !== day) {
      options.onReschedule({ ...payload, scheduledDay: day });
      setAnnouncement(`date change requested for ${taskTitle(task)}.`);
    }
    endDrag();
  }
  function inspectDay(day: string) {
    setCursor({ accountId: options.accountId, day });
    options.onModeChange('week');
  }
  const itemProps: Omit<ItemProps, 'task'> = { options, context, listNames, startDrag, endDrag };

  return (
    <div
      className={`calendar-view calendar-view--${options.mode}${options.providerActionsEnabled === false ? ' calendar-view--read-only' : ''}`}
    >
      <div className="calendar-view__sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <div className="calendar-view__scroll">
        <header className="calendar-view__toolbar">
          <h2>{periodTitle(cursorDay, options.mode, range)}</h2>
          <div className="calendar-view__navigation">
            <button
              type="button"
              aria-label={`previous ${options.mode}`}
              onClick={() =>
                setCursor({
                  accountId: options.accountId,
                  day: moveCalendarCursor(cursorDay, options.mode, -1),
                })
              }
            >
              <Icon name="left" size={15} />
            </button>
            <button
              type="button"
              aria-label={`next ${options.mode}`}
              onClick={() =>
                setCursor({
                  accountId: options.accountId,
                  day: moveCalendarCursor(cursorDay, options.mode, 1),
                })
              }
            >
              <Icon name="right" size={15} />
            </button>
            <button
              className="calendar-view__today"
              type="button"
              onClick={() => setCursor({ accountId: options.accountId, day: options.today })}
            >
              today
            </button>
          </div>
          <div className="calendar-view__period" role="group" aria-label="calendar period">
            <button
              type="button"
              aria-pressed={options.mode === 'month'}
              onClick={() => options.onModeChange('month')}
            >
              month
            </button>
            <button
              type="button"
              aria-pressed={options.mode === 'week'}
              onClick={() => options.onModeChange('week')}
            >
              week
            </button>
          </div>
          <Select
            className="calendar-view__scope"
            aria-label="calendar scope"
            value={options.scope}
            onChange={(selectedValue) => options.onScopeChange(selectedValue as CalendarScope)}
            options={[
              { value: 'board', label: 'this board' },
              { value: 'account', label: 'all boards in this account' },
            ]}
          />
        </header>
        <p className="calendar-view__zone">
          <Icon name="clock" size={12} />
          {options.accountTimeZone} · {options.weekStart === 1 ? 'monday' : 'sunday'} week start
        </p>
        {options.providerActionsEnabled === false && (
          <p className="calendar-view__notice">
            <Icon name="lock" size={13} />
            {options.readOnlyReason ?? 'dates are read-only while provider actions are paused.'}
          </p>
        )}
        {status === 'loading' && options.tasks.length === 0 && (
          <p className="calendar-view__notice" role="status">
            loading calendar…
          </p>
        )}
        {status === 'error' && (
          <div className="calendar-view__error" role="alert">
            <p>{options.errorMessage ?? 'the calendar could not be refreshed.'}</p>
            <button type="button" onClick={options.onRetry}>
              try again
            </button>
          </div>
        )}
        <table className="calendar-view__table" aria-busy={status === 'loading' || undefined}>
          <caption className="calendar-view__sr-only">
            {periodTitle(cursorDay, options.mode, range)} ·{' '}
            {options.scope === 'board' ? 'current board' : 'all boards in the selected account'}
          </caption>
          <thead>
            <tr>
              {grid[0]?.map((day) => (
                <th scope="col" key={day.weekday}>
                  {weekdayNames[day.weekday - 1]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
              <tr key={row[0]?.date}>
                {row.map((day) => (
                  <DayCell
                    key={day.date}
                    day={day}
                    bucket={groups.byDay.get(day.date)}
                    options={options}
                    dragging={dragging}
                    dropTarget={dropTarget}
                    itemProps={itemProps}
                    inspectDay={inspectDay}
                    dragOver={dragOver}
                    drop={drop}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {options.nextCursor != null && (
          <button
            className="calendar-view__load-more"
            type="button"
            disabled={status === 'loading'}
            onClick={options.onLoadMore}
          >
            load more tasks
            <Icon name="down" size={13} />
          </button>
        )}
        <section
          className={`calendar-view__unscheduled${dragging && dropTarget === 'unscheduled' ? ' calendar-view__unscheduled--drop-target' : ''}`}
          onDragOver={(event) => dragOver(null, event)}
          onDrop={(event) => drop(null, event)}
        >
          <header>
            <button
              className="calendar-view__unscheduled-toggle"
              type="button"
              aria-expanded={unscheduledExpanded}
              aria-controls={unscheduledId}
              onClick={() => setUnscheduledExpanded((value) => !value)}
            >
              <Icon name={unscheduledExpanded ? 'down' : 'right'} size={13} />
              <h2>unscheduled</h2>
              {options.coverage.complete && options.nextCursor == null && (
                <span>{groups.unscheduled.length}</span>
              )}
            </button>
            <button
              className="calendar-view__unscheduled-add"
              type="button"
              disabled={options.providerActionsEnabled === false}
              onClick={() =>
                options.onCreateTask({ accountId: options.accountId, scheduledDay: null })
              }
            >
              <Icon name="plus" size={13} />
              new task
            </button>
          </header>
          {dragging && (
            <p className="calendar-view__clear-date-note">
              moving here requests removal of the date, time, and lanes repeat rule. confirmation is
              required before saving.
            </p>
          )}
          <div id={unscheduledId} hidden={!unscheduledExpanded}>
            {unscheduledExpanded && (
              <>
                {groups.unscheduled.length ? (
                  <div
                    className="calendar-view__unscheduled-items"
                    role="list"
                    aria-label="unscheduled tasks"
                  >
                    {groups.unscheduled.map((task) => (
                      <CalendarItem key={task.id} task={task} {...itemProps} />
                    ))}
                  </div>
                ) : (
                  <p className="calendar-view__unscheduled-empty">
                    {options.coverage.complete
                      ? 'no unscheduled tasks in this view.'
                      : 'no unscheduled tasks loaded yet.'}
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
