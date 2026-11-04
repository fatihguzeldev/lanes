import { useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Board } from '../../contracts/board';
import {
  groupCompletedTasks,
  sevenDayCompletionSummary,
} from '../../../history/model/completion/completed';
import type { CompletedGroupKey } from '../../../history/contracts/events';
import type { Task, TaskFilter, TaskList } from '../../../tasks/contracts/task';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import { usePlanningToday } from '../../../tasks/browser/planning/usePlanningToday';
import { Select } from '../../../../shared/ui/select/Select';
import './CompletedWorkspace.css';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';

export interface CompletedWorkspaceProps {
  account: ConnectionSummary;
  board: Board | null;
  lists: readonly TaskList[];
  query: string;
  filter: TaskFilter;
  version: number;
  clockOffset: number;
  onOpenTask: (task: Task) => void;
  onTaskMenu?: (task: Task, anchor: HTMLButtonElement) => void;
  onInitialReady?: (state: InitialViewReadiness) => void;
}
const groupNames: Record<CompletedGroupKey, string> = {
  today: 'today',
  yesterday: 'yesterday',
  this_week: 'this week',
  earlier: 'earlier',
  unknown_time: 'completion time unavailable',
  future: 'future completion dates',
};
export function CompletedWorkspace({
  account,
  board,
  lists,
  query,
  filter,
  version,
  clockOffset,
  onOpenTask,
  onTaskMenu,
  onInitialReady,
}: CompletedWorkspaceProps) {
  const today = usePlanningToday(account.planningZone, clockOffset);
  const now = useMemo(() => new Date(Date.now() + clockOffset).toISOString(), [today, clockOffset]);
  const [scope, setScope] = useState<'board' | 'account'>(board ? 'board' : 'account');
  const selectionKey = `${account.id}:${scope}:${board?.id ?? ''}`;
  const [selection, setSelection] = useState({ key: selectionKey, listId: '' });
  const listId = selection.key === selectionKey ? selection.listId : '';
  const valid = scope === 'account' || !board || board.accountId === account.id;
  const input = useMemo(
    () =>
      valid
        ? {
            ...(scope === 'board' && board ? { boardId: board.id } : {}),
            query,
            sort: 'updated' as const,
            ...(listId ? { listIds: [listId] } : {}),
            filter: { ...filter, completion: 'completed' as const },
          }
        : null,
    [valid, scope, board?.id, query, listId, filter],
  );
  const tasks = useTaskQuery(account.id, input, version);
  useEffect(() => {
    onInitialReady?.({
      version,
      settled: !input || tasks.settled,
      baselineComplete: !input || tasks.page.providerCoverage.complete,
      failed: tasks.status === 'error',
    });
  }, [
    version,
    input,
    tasks.settled,
    tasks.page.providerCoverage.complete,
    tasks.status,
    onInitialReady,
  ]);
  const matched = useMemo(() => new Set(tasks.page.matchedTaskIds), [tasks.page.matchedTaskIds]);
  const rows = useMemo(
    () => tasks.page.items.filter((task) => task.accountId === account.id),
    [tasks.page.items, account.id],
  );
  const options = {
    accountId: account.id,
    zone: account.planningZone,
    weekStart: account.weekStart,
    now,
    lists,
  };
  const groups = groupCompletedTasks(rows, options).flatMap((group) => {
    const items = group.items.filter((item) => matched.has(item.task.id));
    return items.length ? [{ ...group, items }] : [];
  });
  const summary = sevenDayCompletionSummary(
    rows.filter((task) => matched.has(task.id)),
    options,
  );
  const complete = tasks.loaded && tasks.page.coverage.complete && tasks.page.nextCursor === null;
  const choices = lists.filter((list) => list.accountId === account.id);
  const listName = (id: string) =>
    choices.find((list) => list.id === id)?.title.trim() || 'list not loaded';
  const byList = new Map<string, number>();
  for (const day of summary.days)
    for (const list of day.lists)
      byList.set(list.listId, (byList.get(list.listId) ?? 0) + list.count);
  const dayName = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
  const completionTime = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: account.planningZone,
  });
  return (
    <section className="completed-workspace" aria-label="completed tasks">
      <header className="completed-workspace__header">
        <div>
          <h2>completed</h2>
        </div>
        <div className="completed-workspace__filters">
          {board && (
            <Select
              aria-label="completed task scope"
              value={scope}
              onChange={(selectedValue) => setScope(selectedValue as 'board' | 'account')}
              options={[
                { value: 'board', label: 'this board' },
                { value: 'account', label: 'all boards in this account' },
              ]}
            />
          )}
          <Select
            aria-label="filter completed tasks by list"
            value={listId}
            onChange={(selectedValue) => setSelection({ key: selectionKey, listId: selectedValue })}
            options={[
              { value: '', label: 'all lists in this view' },
              ...choices.map((list) => ({
                value: list.id,
                label: list.title.trim() || 'untitled list',
              })),
            ]}
          />
        </div>
      </header>
      {complete && (
        <section className="completed-workspace__summary" aria-label="seven day completion summary">
          <div className="completed-workspace__summary-heading">
            <h3>last 7 days</h3>
          </div>
          <ol>
            {summary.days.map((day) => (
              <li key={day.day}>
                <span>{dayName.format(new Date(day.day + 'T12:00:00Z')).toLowerCase()}</span>
                <strong>{day.count}</strong>
                <time dateTime={day.day}>{day.day.slice(5).replace('-', '/')}</time>
              </li>
            ))}
          </ol>
          {byList.size > 0 && (
            <details>
              <summary>by list</summary>
              <ul>
                {[...byList].map(([id, count]) => (
                  <li key={id}>
                    <span>{listName(id)}</span>
                    <strong>{count}</strong>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {summary.unknownTimeCount > 0 && (
            <p className="completed-workspace__summary-note">
              {summary.unknownTimeCount} tasks have no completion time and are outside the daily
              summary.
            </p>
          )}
        </section>
      )}
      {!valid && (
        <p className="completed-workspace__notice completed-workspace__notice--error" role="alert">
          this board belongs to a different account.
        </p>
      )}
      {valid && !tasks.loaded && tasks.status === 'loading' && (
        <p className="completed-workspace__notice" role="status">
          loading completed tasks…
        </p>
      )}
      {valid && tasks.status === 'error' && (
        <div
          className="completed-workspace__notice completed-workspace__notice--error"
          role="alert"
        >
          <p>{tasks.error}</p>
          <button
            type="button"
            onClick={() => {
              void tasks.reload();
            }}
          >
            try again
          </button>
        </div>
      )}
      {valid && tasks.loaded && !groups.length && (
        <div className="completed-workspace__empty">
          <Icon name="check" size={23} />
          <p>
            {complete
              ? 'no completed tasks match this view.'
              : 'no matching completed tasks loaded yet.'}
          </p>
        </div>
      )}
      {groups.map((group) => (
        <section className="completed-workspace__group" key={group.key}>
          <h3>{groupNames[group.key]}</h3>
          <ul>
            {group.items.map(({ task, parent }) => (
              <li key={task.id}>
                <Icon name="check" size={14} />
                <div>
                  <button
                    className="completed-workspace__task"
                    type="button"
                    onClick={() => onOpenTask(task)}
                  >
                    {task.title.trim() || 'untitled task'}
                  </button>
                  <p>
                    {task.parentId ? `${parent?.title.trim() || 'parent not loaded'} · ` : ''}
                    {listName(task.listId)}
                    {task.completedAt && (
                      <>
                        {' '}
                        ·{' '}
                        <time dateTime={task.completedAt}>
                          {completionTime.format(new Date(task.completedAt)).toLowerCase()}
                        </time>
                      </>
                    )}
                  </p>
                </div>
                {onTaskMenu && (
                  <button
                    className="completed-workspace__menu"
                    type="button"
                    aria-label={`options for ${task.title.trim() || 'untitled task'}`}
                    onClick={(event) => onTaskMenu(task, event.currentTarget)}
                  >
                    <Icon name="more" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {tasks.page.nextCursor && (
        <button
          className="completed-workspace__more"
          type="button"
          disabled={tasks.status === 'loading'}
          onClick={() => {
            void tasks.loadMore();
          }}
        >
          more completed tasks
          <Icon name="down" size={13} />
        </button>
      )}
    </section>
  );
}
