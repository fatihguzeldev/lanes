import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Board } from '../../contracts/board';
import {
  CalendarView,
  type CalendarRangeRequest,
  type CalendarViewProps,
  type CalendarMode,
  type CalendarScope,
  type CalendarCreateIntent,
  type CalendarDaySelection,
} from './CalendarView';
import { calendarRange, type CalendarRange } from './calendar-model';
import type { Label, TaskFilter, TaskList, TaskSort } from '../../../tasks/contracts/task';
import type { TaskQueryInput } from '../../../tasks/contracts/query';
import { addCalendarDays } from '../../../tasks/model/planning';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import { CalendarDestinationMenu, type CalendarKnownLists } from './CalendarDestinationMenu';
import { selectCollectionTasks } from '../../../tasks/browser/queries/collection-selection';
import { useTaskListContexts } from '../../../tasks/browser/queries/useTaskListContexts';
import {
  creationAcknowledged,
  type PendingTaskCreation,
} from '../../../tasks/browser/creation/useTaskCreations';
import {
  taskChangeAcknowledged,
  projectTaskCollection,
  type PendingTaskChange,
} from '../../../tasks/browser/changes/useTaskChanges';
import type { QueuedTaskMove } from '../../../tasks/browser/movement/task-move-model';
import './CalendarWorkspace.css';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';
import { taskBelongsToBoard } from '../view/task-board-scope';

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
  labels?: readonly Label[];
  scope?: CalendarScope;
  onScopeChange?(scope: CalendarScope): void;
  knownLists?: CalendarKnownLists;
  today: string;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
  version: number;
  onInitialReady?: (state: InitialViewReadiness) => void;
  creations?: readonly PendingTaskCreation[];
  onCreationRead?: (id: number) => void;
  edits?: readonly PendingTaskChange[];
  moves?: readonly QueuedTaskMove[];
  onEditRead?: (id: string | number) => void;
}
const emptySelectionCoverage = { complete: true, lastSyncedAt: null, stale: false };
export function CalendarWorkspace({
  account,
  board,
  lists: visibleLists,
  labels = [],
  scope: controlledScope,
  onScopeChange,
  knownLists,
  today,
  filter,
  query,
  sort,
  version,
  onCreateTask,
  onInitialReady,
  edits = [],
  moves = [],
  onEditRead,
  creations = [],
  onCreationRead,
  ...actions
}: CalendarWorkspaceProps) {
  const [mode, setMode] = useState<CalendarMode>('month');
  const [localScope, setLocalScope] = useState<CalendarScope>('board');
  const scope = controlledScope ?? localScope;
  const setScope = onScopeChange ?? setLocalScope;
  const [createDay, setCreateDay] = useState<
    (CalendarDaySelection & { anchor: HTMLElement }) | null
  >(null);
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
  const readVersion =
    activeRange &&
    (!inputs.dated || (dated.settled && dated.status === 'ready')) &&
    (!inputs.unscheduled || (undated.settled && undated.status === 'ready'))
      ? version
      : undefined;
  useEffect(() => {
    for (const edit of edits)
      if (edit.input.accountId === account.id && taskChangeAcknowledged(edit, readVersion))
        onEditRead?.(edit.id);
  }, [edits, account.id, readVersion, onEditRead]);
  const scopedCreations = creations.filter(
    (creation) =>
      creation.input.accountId === account.id &&
      (scope === 'account' || visibleLists.some((list) => list.id === creation.input.listId)),
  );
  useEffect(() => {
    for (const creation of scopedCreations)
      if (creationAcknowledged(creation, readVersion)) onCreationRead?.(creation.id);
  }, [scopedCreations, readVersion, onCreationRead]);
  const projected = projectTaskCollection(
    items,
    edits,
    readVersion,
    (task) => task.accountId === account.id,
    moves,
  ).filter(
    (task) =>
      !scopedCreations.some(
        (creation) =>
          !creationAcknowledged(creation, readVersion) && creation.resolvedTaskId === task.id,
      ),
  );
  const context = useTaskListContexts(
    account.id,
    [
      ...projected.map((task) => task.listId),
      ...scopedCreations
        .filter((creation) => !creation.deleted)
        .map((creation) => creation.input.listId),
    ],
    version,
    visibleLists,
  );
  useEffect(() => {
    onInitialReady?.({
      version,
      settled:
        context.settled &&
        activeRange &&
        (!inputs.dated || dated.settled) &&
        (!inputs.unscheduled || undated.settled),
      baselineComplete:
        (!inputs.dated || dated.page.providerCoverage.complete) &&
        (!inputs.unscheduled || undated.page.providerCoverage.complete),
      failed: Boolean(
        (inputs.dated && dated.status === 'error') ||
        (inputs.unscheduled && undated.status === 'error') ||
        context.error,
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
    context.settled,
    context.error,
  ]);
  const lists = context.items;
  const selection = selectCollectionTasks(
    projected.filter(
      (task) =>
        scope === 'account' ||
        taskBelongsToBoard(task, board.id, visibleLists, context.contexts, items),
    ),
    {
      accountId: account.id,
      today,
      query,
      filter,
      lists,
      labels,
    },
    [...dated.page.matchedTaskIds, ...undated.page.matchedTaskIds],
    edits,
    readVersion,
    new Set(moves.map((move) => move.intent.taskId)),
  );
  const matched = new Set(selection.matchedTaskIds);
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
      {context.error && (
        <div className="calendar-workspace__pages" role="alert">
          <p>{context.error}</p>
          <button type="button" onClick={context.retry}>
            retry list names
          </button>
        </div>
      )}
      <CalendarView
        {...actions}
        onCreateTask={(selection, anchor) => {
          if (
            selection.accountId === account.id &&
            actions.providerActionsEnabled !== false &&
            account.state === 'connected'
          )
            setCreateDay({ ...selection, anchor });
        }}
        key={`${account.id}:${board.id}`}
        accountId={account.id}
        boardId={board.id}
        creations={scopedCreations.filter(
          (creation) => !creation.deleted && !creationAcknowledged(creation, readVersion),
        )}
        tasks={selection.tasks}
        relatedTasks={selection.tasks}
        onReschedule={(intent) =>
          actions.onReschedule(
            intent,
            projected.find((task) => task.id === intent.taskId),
          )
        }
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
        <CalendarDestinationMenu
          {...(knownLists ? { knownLists } : {})}
          anchor={createDay.anchor}
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
