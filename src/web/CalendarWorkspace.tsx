import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import type { Board } from '../modules/boards/contracts';
import {
  CalendarView,
  type CalendarRangeRequest,
  type CalendarViewProps,
  type CalendarMode,
  type CalendarScope,
  type CalendarCreateIntent,
  type CalendarDaySelection,
} from '../modules/boards/components/CalendarView';
import { calendarRange, type CalendarRange } from '../modules/boards/components/calendar-model';
import type { TaskFilter, TaskList, TaskSort } from '../modules/tasks/contracts';
import type { TaskQueryInput } from '../modules/tasks/query-contract';
import { addCalendarDays } from '../modules/tasks/planning';
import { useTaskQuery } from '../modules/tasks/client/useTaskQuery';
import { CalendarDestinationDialog } from './CalendarDestinationDialog';
import './CalendarWorkspace.css';
import type { InitialViewReadiness } from '../client/readiness';

interface CalendarQueryOptions {
  accountId: string;
  boardId: string;
  scope: CalendarScope;
  range: CalendarRange;
  today: string;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
}
export function buildCalendarQueries(options: CalendarQueryOptions): {
  dated: TaskQueryInput | null;
  unscheduled: TaskQueryInput | null;
} {
  const { scheduled, ...rest } = options.filter;
  const base: TaskQueryInput = {
    ...(options.scope === 'board' ? { boardId: options.boardId } : {}),
    query: options.query,
    sort: options.sort,
  };
  let from = options.range.from;
  let to = options.range.to;
  if (scheduled?.kind === 'range') {
    from = from > scheduled.from ? from : scheduled.from;
    to = to < scheduled.to ? to : scheduled.to;
  }
  if (scheduled?.kind === 'today') {
    from = from > options.today ? from : options.today;
    to = to < options.today ? to : options.today;
  }
  if (scheduled?.kind === 'overdue') {
    const yesterday = addCalendarDays(options.today, -1);
    to = to < yesterday ? to : yesterday;
  }
  const dated =
    scheduled?.kind === 'none' ||
    from > to ||
    (scheduled?.kind === 'overdue' && rest.completion === 'completed')
      ? null
      : {
          ...base,
          filter: {
            ...rest,
            ...(scheduled?.kind === 'overdue' ? { completion: 'open' as const } : {}),
            scheduled: { kind: 'range' as const, from, to },
          },
        };
  const unscheduled =
    scheduled && scheduled.kind !== 'none'
      ? null
      : { ...base, filter: { ...rest, scheduled: { kind: 'none' as const } } };
  return { dated, unscheduled };
}
export interface CalendarWorkspaceProps extends Pick<
  CalendarViewProps,
  'onOpenTask' | 'onTaskMenu' | 'onReschedule' | 'providerActionsEnabled'
> {
  onCreateTask: (intent: CalendarCreateIntent) => void;
  account: ConnectionSummary;
  board: Board;
  lists: readonly TaskList[];
  today: string;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
  version: number;
  onInitialReady?: (state: InitialViewReadiness) => void;
}
const emptySelectionCoverage = { complete: true, lastSyncedAt: null, stale: false };
export function CalendarWorkspace({
  account,
  board,
  lists,
  today,
  filter,
  query,
  sort,
  version,
  onCreateTask,
  onInitialReady,
  ...actions
}: CalendarWorkspaceProps) {
  const [mode, setMode] = useState<CalendarMode>('month');
  const [scope, setScope] = useState<CalendarScope>('board');
  const [createDay, setCreateDay] = useState<CalendarDaySelection | null>(null);
  const [range, setRange] = useState<CalendarRangeRequest>(() => ({
    accountId: account.id,
    boardId: board.id,
    mode: 'month',
    scope: 'board',
    ...calendarRange(today, 'month', account.weekStart),
  }));
  const validAccount = board.accountId === account.id;
  const activeRange =
    range.accountId === account.id &&
    range.boardId === board.id &&
    range.mode === mode &&
    range.scope === scope;
  const inputs = useMemo(() => {
    if (!validAccount) return { dated: null, unscheduled: null };
    const queries = buildCalendarQueries({
      accountId: account.id,
      boardId: board.id,
      scope,
      range,
      today,
      filter,
      query,
      sort,
    });
    return { dated: activeRange ? queries.dated : null, unscheduled: queries.unscheduled };
  }, [validAccount, activeRange, account.id, board.id, scope, range, today, filter, query, sort]);
  const dated = useTaskQuery(account.id, inputs.dated, version);
  const undated = useTaskQuery(account.id, inputs.unscheduled, version);
  useEffect(() => {
    onInitialReady?.({
      version,
      settled:
        activeRange && (!inputs.dated || dated.settled) && (!inputs.unscheduled || undated.settled),
      baselineComplete:
        (!inputs.dated || dated.page.providerCoverage.complete) &&
        (!inputs.unscheduled || undated.page.providerCoverage.complete),
      failed: Boolean(
        (inputs.dated && dated.status === 'error') ||
        (inputs.unscheduled && undated.status === 'error'),
      ),
    });
  }, [
    version,
    activeRange,
    inputs.dated,
    inputs.unscheduled,
    dated.settled,
    undated.settled,
    dated.page.providerCoverage.complete,
    undated.page.providerCoverage.complete,
    dated.status,
    undated.status,
    onInitialReady,
  ]);
  const onRangeChange = useCallback(
    (next: CalendarRangeRequest) => {
      if (next.accountId !== account.id || next.boardId !== board.id) return;
      setRange((previous) =>
        previous.accountId === next.accountId &&
        previous.boardId === next.boardId &&
        previous.mode === next.mode &&
        previous.scope === next.scope &&
        previous.from === next.from &&
        previous.to === next.to
          ? previous
          : next,
      );
    },
    [account.id, board.id],
  );
  const datedCoverage = inputs.dated ? dated.page.coverage : emptySelectionCoverage;
  const undatedCoverage = inputs.unscheduled ? undated.page.coverage : emptySelectionCoverage;
  const times = [datedCoverage.lastSyncedAt, undatedCoverage.lastSyncedAt]
    .filter((value): value is string => value !== null)
    .sort();
  const coverage = {
    complete: datedCoverage.complete && undatedCoverage.complete && activeRange && validAccount,
    stale: datedCoverage.stale || undatedCoverage.stale,
    lastSyncedAt: times[0] ?? null,
  };
  const items = [
    ...(inputs.dated ? dated.page.items : []),
    ...(inputs.unscheduled ? undated.page.items : []),
  ].filter((task) => task.accountId === account.id);
  const matched = new Set([
    ...(inputs.dated ? dated.page.matchedTaskIds : []),
    ...(inputs.unscheduled ? undated.page.matchedTaskIds : []),
  ]);
  const errors = [
    inputs.dated && dated.error ? `dated tasks: ${dated.error}` : '',
    inputs.unscheduled && undated.error ? `unscheduled tasks: ${undated.error}` : '',
  ].filter(Boolean);
  const loading =
    !activeRange ||
    Boolean(
      (inputs.dated && dated.status === 'loading') ||
      (inputs.unscheduled && undated.status === 'loading'),
    );
  return (
    <section className="calendar-workspace" aria-label="task calendar">
      <CalendarView
        {...actions}
        onCreateTask={(selection) => {
          if (
            selection.accountId === account.id &&
            actions.providerActionsEnabled !== false &&
            account.state === 'connected'
          )
            setCreateDay(selection);
        }}
        key={`${account.id}:${board.id}`}
        accountId={account.id}
        boardId={board.id}
        tasks={items}
        relatedTasks={items}
        lists={lists}
        today={today}
        accountTimeZone={account.planningZone}
        weekStart={account.weekStart}
        mode={mode}
        scope={scope}
        onModeChange={setMode}
        onScopeChange={setScope}
        onRangeChange={onRangeChange}
        matchedTaskIds={matched}
        coverage={coverage}
        status={errors.length ? 'error' : loading ? 'loading' : 'ready'}
        errorMessage={
          validAccount ? errors.join(' · ') : 'this board belongs to a different account.'
        }
        providerActionsEnabled={
          validAccount && actions.providerActionsEnabled !== false && account.state === 'connected'
        }
        onLoadMore={() => {
          if (dated.page.nextCursor) void dated.loadMore();
        }}
        onRetry={() => {
          if (inputs.dated) void dated.reload();
          if (inputs.unscheduled) void undated.reload();
        }}
      />
      {(!validAccount ||
        !inputs.dated ||
        !inputs.unscheduled ||
        dated.page.nextCursor ||
        undated.page.nextCursor) && (
        <footer className="calendar-workspace__pages" aria-label="calendar pages">
          {!validAccount ? (
            <p role="alert">this board belongs to a different account.</p>
          ) : (
            (!inputs.dated || !inputs.unscheduled) && (
              <p>
                the date filter hides{' '}
                {!inputs.dated ? 'scheduled tasks in this period' : 'unscheduled tasks'}.
              </p>
            )
          )}
          {inputs.dated && dated.page.nextCursor && (
            <button
              type="button"
              disabled={dated.status === 'loading'}
              onClick={() => {
                void dated.loadMore();
              }}
            >
              more tasks in this period
            </button>
          )}
          {inputs.unscheduled && undated.page.nextCursor && (
            <button
              type="button"
              disabled={undated.status === 'loading'}
              onClick={() => {
                void undated.loadMore();
              }}
            >
              more unscheduled tasks
            </button>
          )}
        </footer>
      )}
      {createDay?.accountId === account.id && (
        <CalendarDestinationDialog
          accountId={account.id}
          board={board}
          scope={scope}
          scheduledDay={createDay.scheduledDay}
          enabled={
            validAccount &&
            actions.providerActionsEnabled !== false &&
            account.state === 'connected'
          }
          version={version}
          onClose={() => setCreateDay(null)}
          onChoose={(intent) => {
            setCreateDay(null);
            onCreateTask(intent);
          }}
        />
      )}
    </section>
  );
}
