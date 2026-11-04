import { useMemo, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import type { Board } from '../modules/boards/contracts';
import type { HistoryEvent } from '../modules/history/contracts';
import { groupHistoryEventsByDay } from '../modules/history/completed';
import type { Task, TaskList } from '../modules/tasks/contracts';
import { addCalendarDays } from '../modules/tasks/planning';
import { Dialog } from '../ui/Dialog';
import { Icon, type IconName } from '../ui/Icon';
import { request } from '../client/http';
import { HistoryPageSchema } from './schemas';
import { usePagedResource } from '../client/usePagedResource';
import { usePlanningToday } from './usePlanningToday';
import { Select } from '../ui/Select';
import './HistoryPanel.css';

export interface HistoryPanelProps {
  account: ConnectionSummary;
  board: Board | null;
  task?: Task | null;
  lists?: readonly TaskList[];
  version: number;
  clockOffset: number;
  onClose: () => void;
  onOpenTask?: (reference: { accountId: string; taskId: string }) => void;
}
export function describeHistoryEvent(event: HistoryEvent): {
  action: string;
  detail: string;
  icon: IconName;
} {
  switch (event.kind) {
    case 'task_created':
      return {
        action: 'created',
        detail:
          event.summary.source && event.summary.source !== 'direct'
            ? `from ${event.summary.source}`
            : '',
        icon: 'plus',
      };
    case 'task_completed':
      return { action: 'completed', detail: '', icon: 'check' };
    case 'task_reopened':
      return { action: 'reopened', detail: '', icon: 'history' };
    case 'task_moved':
      return {
        action: 'moved',
        detail:
          event.summary.from.listId !== event.summary.to.listId
            ? 'to another list'
            : event.summary.to.parentId
              ? 'under a parent task'
              : 'to the top level',
        icon: 'arrow',
      };
    case 'task_deleted':
      return {
        action: 'deleted',
        detail: event.summary.knownSubtaskCount
          ? `with ${event.summary.knownSubtaskCount} known subtasks`
          : '',
        icon: 'trash',
      };
    case 'list_deleted':
      return {
        action: 'deleted list',
        detail: `${event.summary.knownTaskCount} observed tasks`,
        icon: 'trash',
      };
    case 'scheduled_day_changed':
      return {
        action: event.summary.after ? 'changed date' : 'removed date',
        detail: `${event.summary.before ?? 'unscheduled'} → ${event.summary.after ?? 'unscheduled'}`,
        icon: 'calendar',
      };
    case 'scheduled_time_changed':
      return {
        action: 'changed time',
        detail: `${event.summary.before.time ?? 'any time'} → ${event.summary.after.time ?? 'any time'}${event.summary.after.zone ? ` · ${event.summary.after.zone}` : ''}`,
        icon: 'clock',
      };
    case 'repeat_rule_changed':
      return {
        action: event.summary.after ? 'changed repetition' : 'stopped repetition',
        detail: event.summary.after
          ? `every ${event.summary.after.interval} · ${event.summary.after.frequency}`
          : '',
        icon: 'sync',
      };
    case 'labels_changed':
      return {
        action: 'changed labels',
        detail: `${event.summary.before.length} → ${event.summary.after.length} labels`,
        icon: 'list',
      };
    case 'priority_changed':
      return {
        action: 'changed priority',
        detail: `${event.summary.before} → ${event.summary.after}`,
        icon: 'up',
      };
    case 'star_changed':
      return { action: event.summary.after ? 'starred' : 'removed star', detail: '', icon: 'star' };
    case 'dependencies_changed':
      return {
        action: 'changed dependencies',
        detail: `${event.summary.before.length} → ${event.summary.after.length} blockers`,
        icon: 'link',
      };
  }
}
function dayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  if (day === addCalendarDays(today, -1)) return 'yesterday';
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
    timeZone: 'UTC',
  })
    .format(new Date(day + 'T12:00:00Z'))
    .toLowerCase();
}
export function HistoryPanel({
  account,
  board,
  task,
  lists = [],
  version,
  clockOffset,
  onClose,
  onOpenTask,
}: HistoryPanelProps) {
  const [scope, setScope] = useState<'board' | 'account'>(board ? 'board' : 'account');
  const selectionKey = JSON.stringify([
    account.id,
    task?.id ?? null,
    scope,
    scope === 'board' ? (board?.id ?? null) : null,
  ]);
  const [selection, setSelection] = useState({ key: selectionKey, listId: '' });
  const listId = selection.key === selectionKey ? selection.listId : '';
  const valid =
    (!task || task.accountId === account.id) &&
    (Boolean(task) || scope === 'account' || !board || board.accountId === account.id);
  const params = new URLSearchParams({ limit: '50' });
  if (task) params.set('taskId', task.id);
  else {
    if (scope === 'board' && board) params.set('boardId', board.id);
    if (listId) params.set('listId', listId);
  }
  const queryKey = valid ? JSON.stringify([account.id, params.toString()]) : null;
  const history = usePagedResource(
    queryKey,
    (cursor, signal) => {
      const query = new URLSearchParams(params);
      if (cursor) query.set('cursor', cursor);
      return request(
        `/api/accounts/${encodeURIComponent(account.id)}/history?${query}`,
        HistoryPageSchema,
        { signal },
      );
    },
    (event) => event.id,
    version,
  );
  const groups = useMemo(
    () =>
      groupHistoryEventsByDay(history.items, { accountId: account.id, zone: account.planningZone }),
    [history.items, account.id, account.planningZone],
  );
  const choices = new Map(
    lists
      .filter((list) => list.accountId === account.id)
      .map((list) => [list.id, list.title.trim() || 'untitled list']),
  );
  for (const event of history.items)
    if (event.accountId === account.id && event.listId && !choices.has(event.listId))
      choices.set(event.listId, event.listTitle?.trim() || 'untitled list');
  const today = usePlanningToday(account.planningZone, clockOffset);
  const time = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: account.planningZone,
  });
  return (
    <Dialog
      title={task ? 'task history' : board && scope === 'board' ? 'board history' : 'history'}
      onClose={onClose}
      side
    >
      <div className="history-panel">
        <p className="history-panel__intro">
          {task
            ? task.title.trim() || 'untitled task'
            : scope === 'board' && board
              ? board.title
              : account.email}
          <span>last 90 days · {account.planningZone}</span>
        </p>
        {!task && (
          <div className="history-panel__filters">
            {board && (
              <label>
                <span>activity from</span>
                <Select
                  value={scope}
                  onChange={(selectedValue) => setScope(selectedValue as 'board' | 'account')}
                  aria-label="activity from"
                  options={[
                    { value: 'board', label: 'this board' },
                    { value: 'account', label: 'all boards in this account' },
                  ]}
                />
              </label>
            )}
            <label>
              <span>list</span>
              <Select
                value={listId}
                onChange={(selectedValue) =>
                  setSelection({ key: selectionKey, listId: selectedValue })
                }
                aria-label="list"
                options={[
                  { value: '', label: 'all lists in this view' },
                  ...[...choices].map(([id, name]) => ({ value: id, label: name })),
                ]}
              />
            </label>
          </div>
        )}
        {!valid && (
          <p className="history-panel__error" role="alert">
            this selection belongs to a different account.
          </p>
        )}
        {valid && history.status === 'loading' && (
          <p className="history-panel__state" role="status">
            {history.loaded ? 'loading more activity…' : 'loading activity…'}
          </p>
        )}
        {valid && history.status === 'error' && (
          <div className="history-panel__error" role="alert">
            <p>{history.error}</p>
            <button
              type="button"
              onClick={() => {
                void history.reload();
              }}
            >
              try again
            </button>
          </div>
        )}
        {valid && history.loaded && !groups.length && (
          <div className="history-panel__empty">
            <Icon name="clock" size={21} />
            <p>no recorded activity in this view.</p>
            <span>
              the first sync establishes a baseline. it does not backfill google’s history.
            </span>
          </div>
        )}
        {groups.map((group) => (
          <section className="history-panel__day" key={group.day}>
            <h3>{dayLabel(group.day, today)}</h3>
            <ol>
              {group.events.map((event) => {
                const text = describeHistoryEvent(event);
                const title =
                  (event.kind === 'list_deleted' ? event.listTitle : event.taskTitle)?.trim() ||
                  (event.kind === 'list_deleted' ? 'untitled list' : 'untitled task');
                return (
                  <li key={event.id}>
                    <span
                      className={`history-panel__mark${event.kind === 'task_completed' ? ' history-panel__mark--complete' : ''}`}
                    >
                      <Icon name={text.icon} size={14} />
                    </span>
                    <div className="history-panel__entry">
                      <p>
                        {onOpenTask && event.taskId && event.kind !== 'task_deleted' ? (
                          <button
                            type="button"
                            className="history-panel__task"
                            onClick={() =>
                              onOpenTask({ accountId: account.id, taskId: event.taskId! })
                            }
                          >
                            {title}
                          </button>
                        ) : (
                          <strong>{title}</strong>
                        )}{' '}
                        <span>{text.action}</span>
                      </p>
                      {text.detail && <p className="history-panel__detail">{text.detail}</p>}
                      <p className="history-panel__meta">
                        {event.origin === 'observed'
                          ? 'observed in google'
                          : event.origin === 'scheduled'
                            ? 'scheduled in lanes'
                            : 'in lanes'}{' '}
                        ·{' '}
                        <time dateTime={event.recordedAt}>
                          {time.format(new Date(event.recordedAt)).toLowerCase()}
                        </time>
                        {event.kind !== 'list_deleted' && event.listTitle && (
                          <> · {event.listTitle}</>
                        )}
                      </p>
                      {event.origin === 'observed' && event.providerAt && (
                        <p className="history-panel__provider-time">
                          google updated{' '}
                          <time dateTime={event.providerAt}>
                            {new Intl.DateTimeFormat('en', {
                              day: 'numeric',
                              month: 'short',
                              hour: 'numeric',
                              minute: '2-digit',
                              timeZone: account.planningZone,
                            })
                              .format(new Date(event.providerAt))
                              .toLowerCase()}
                          </time>
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
        {history.nextCursor && (
          <button
            className="history-panel__more"
            type="button"
            disabled={history.status === 'loading'}
            onClick={() => {
              void history.loadMore();
            }}
          >
            older activity
            <Icon name="down" size={13} />
          </button>
        )}
        <details className="history-panel__footnote">
          <summary>about this history</summary>
          <p>
            recorded time is when lanes confirmed or observed a change. title and note revisions are
            not stored. google does not provide a full audit trail.
          </p>
        </details>
      </div>
    </Dialog>
  );
}
