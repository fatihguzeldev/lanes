import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import type { Board, BoardList } from '../modules/boards/contracts';
import {
  BoardSurface,
  type BoardColumn,
  type BoardSurfaceProps,
} from '../modules/boards/components/BoardSurface';
import type { TaskFilter, TaskSort } from '../modules/tasks/contracts';
import { useTaskQuery } from './useTaskQuery';
import { unknownCoverage } from '../client/usePagedResource';
import { InlineTaskCreate } from './InlineTaskCreate';
import type { TaskMoveQueue } from './useTaskMoveQueue';
import { projectTaskMoves } from './task-move-queue';
import type { InitialViewReadiness } from '../client/readiness';

type Actions = {
  open: () => Promise<void>;
  completed: () => Promise<void>;
  retry: () => Promise<void>;
};
interface ColumnDataProps {
  accountId: string;
  list: BoardList;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
  version: number;
  completedRequested: boolean;
  discoverCompleted: boolean;
  onData: (id: string, data: BoardColumn) => void;
  onActions: (id: string, actions: Actions) => void;
  onReady: (id: string, state: InitialViewReadiness) => void;
}
function ColumnData({
  accountId,
  list,
  filter,
  query,
  sort,
  version,
  completedRequested,
  discoverCompleted,
  onData,
  onActions,
  onReady,
}: ColumnDataProps) {
  const completion = filter.completion ?? 'open';
  const input = useMemo(
    () => ({ listIds: [list.id], query, sort, filter: { ...filter, completion } }),
    [list.id, filter, query, sort, completion],
  );
  const completedInput = useMemo(
    () =>
      (discoverCompleted || completedRequested) && completion === 'open'
        ? { ...input, filter: { ...filter, completion: 'completed' as const } }
        : null,
    [discoverCompleted, completedRequested, input, filter, completion],
  );
  const open = useTaskQuery(accountId, input, version),
    completed = useTaskQuery(accountId, completedInput, version);
  const data = useMemo<BoardColumn>(
    () => ({
      list,
      tasks: [...open.page.items, ...completed.page.items],
      coverage: open.page.coverage,
      providerComplete: open.page.providerCoverage.complete,
      readVersion: open.status === 'ready' && open.settled ? version : undefined,
      status: open.status,
      countLoading: open.status === 'loading' && !open.loaded,
      nextCursor: open.page.nextCursor,
      errorMessage: open.error,
      completedCoverage:
        completion !== 'open'
          ? open.page.coverage
          : completed.loaded
            ? completed.page.coverage
            : unknownCoverage,
      completedNextCursor: completion !== 'open' ? open.page.nextCursor : completed.page.nextCursor,
      completedLoading: (discoverCompleted || completedRequested) && completed.status === 'loading',
      completedCountLoading:
        completion !== 'open'
          ? open.status === 'loading' && !open.loaded
          : completed.status === 'loading' && !completed.loaded,
      completedError: completed.error,
      color: list.color,
      subtaskSummaries: { ...open.page.subtaskSummaries, ...completed.page.subtaskSummaries },
      matchedTaskIds: open.page.matchedTaskIds,
    }),
    [
      list,
      open.page,
      open.status,
      open.settled,
      open.loaded,
      open.error,
      completed.page,
      completed.status,
      completed.error,
      completed.loaded,
      completedRequested,
      discoverCompleted,
      completion,
      version,
    ],
  );
  useEffect(() => onData(list.id, data), [list.id, data, onData]);
  useEffect(() => {
    onReady(list.id, {
      version,
      settled: open.settled && (!completedInput || completed.settled),
      baselineComplete:
        open.page.providerCoverage.complete &&
        (!completedInput || completed.page.providerCoverage.complete),
      failed: open.status === 'error' || Boolean(completedInput && completed.status === 'error'),
    });
  }, [
    list.id,
    version,
    open.settled,
    completed.settled,
    completedInput,
    open.page.providerCoverage.complete,
    completed.page.providerCoverage.complete,
    open.status,
    completed.status,
    onReady,
  ]);
  const latest = useRef({ open, completed });
  latest.current = { open, completed };
  useEffect(
    () =>
      onActions(list.id, {
        open: () => latest.current.open.loadMore(),
        completed: () => {
          const target = completion === 'open' ? latest.current.completed : latest.current.open;
          return target.page.nextCursor ? target.loadMore() : target.reload();
        },
        retry: () => latest.current.open.reload(),
      }),
    [list.id, onActions, completion],
  );
  return null;
}

export interface BoardWorkspaceProps extends Omit<
  BoardSurfaceProps,
  | 'accountId'
  | 'columns'
  | 'today'
  | 'accountTimeZone'
  | 'onLoadMore'
  | 'onRetryList'
  | 'providerActionsEnabled'
  | 'relatedTasks'
  | 'renderTaskCreate'
  | 'onMoveTask'
> {
  account: ConnectionSummary;
  board: Board;
  lists: readonly BoardList[];
  today: string;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
  version: number;
  providerActionsEnabled?: boolean;
  clockOffset?: number;
  resetDrafts?: number;
  onTaskCreated: () => void;
  onDraftChange?: (dirty: boolean) => void;
  onInspectCreate?: (identity: string) => void;
  onInitialReady?: (state: InitialViewReadiness) => void;
  moveQueue: TaskMoveQueue;
}
export function BoardWorkspace({
  account,
  board,
  lists,
  today,
  filter,
  query,
  sort,
  version,
  providerActionsEnabled = account.state === 'connected',
  clockOffset = 0,
  resetDrafts = 0,
  onTaskCreated,
  onDraftChange,
  onInspectCreate,
  onInitialReady,
  moveQueue,
  ...props
}: BoardWorkspaceProps) {
  const [data, setData] = useState<Record<string, BoardColumn>>({}),
    [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const dirtyLists = useRef(new Set<string>());
  const [readiness, setReadiness] = useState<Record<string, InitialViewReadiness>>({});
  const onReady = useCallback((id: string, next: InitialViewReadiness) => {
    setReadiness((previous) => {
      const old = previous[id];
      return old?.version === next.version &&
        old.settled === next.settled &&
        old.baselineComplete === next.baselineComplete &&
        old.failed === next.failed
        ? previous
        : { ...previous, [id]: next };
    });
  }, []);
  useEffect(() => {
    const current = lists.map((list) => readiness[list.id]);
    onInitialReady?.({
      version,
      settled: current.every((state) => state?.version === version && state.settled),
      baselineComplete: current.every(
        (state) => state?.version === version && state.baselineComplete,
      ),
      failed: current.some((state) => state?.version === version && state.failed),
    });
  }, [lists, readiness, version, onInitialReady]);
  const created = useCallback(() => {
    onTaskCreated();
  }, [onTaskCreated]);
  const actions = useRef(new Map<string, Actions>());
  const onData = useCallback(
    (id: string, column: BoardColumn) => setData((previous) => ({ ...previous, [id]: column })),
    [],
  );
  const onActions = useCallback((id: string, action: Actions) => {
    actions.current.set(id, action);
  }, []);
  const columns = lists.map(
    (list) =>
      data[list.id] ?? {
        list,
        tasks: [],
        coverage: unknownCoverage,
        status: 'loading' as const,
        countLoading: true,
        nextCursor: null,
      },
  );
  const moveScope = JSON.stringify([
    account.id,
    board.id,
    lists.map((list) => list.id),
    filter,
    query,
    sort,
  ]);
  const queuedColumns = projectTaskMoves(
    columns,
    moveQueue.moves.filter((move) => move.scope === moveScope),
  );
  useEffect(() => {
    moveQueue.reconcile(columns, moveScope);
  }, [columns, moveQueue, moveScope]);
  return (
    <>
      {lists.map((list) => (
        <ColumnData
          key={`${account.id}:${board.id}:${list.id}`}
          accountId={account.id}
          list={list}
          filter={filter}
          query={query}
          sort={sort}
          version={version}
          completedRequested={completed.has(list.id)}
          discoverCompleted={props.showCompleted !== false}
          onData={onData}
          onActions={onActions}
          onReady={onReady}
        />
      ))}
      <BoardSurface
        {...props}
        key={filter.completion ?? 'open'}
        expandCompleted={!!filter.completion && filter.completion !== 'open'}
        accountId={account.id}
        columns={queuedColumns}
        onMoveTask={(intent) => moveQueue.enqueue(intent, columns, moveScope)}
        today={today}
        accountTimeZone={account.planningZone}
        sort={sort}
        providerActionsEnabled={providerActionsEnabled}
        renderTaskCreate={(list) => (
          <InlineTaskCreate
            key={`${account.id}:${list.id}:${resetDrafts}`}
            accountId={account.id}
            list={list}
            clockOffset={clockOffset}
            enabled={providerActionsEnabled}
            onCreated={created}
            onDirtyChange={(dirty) => {
              if (dirty) dirtyLists.current.add(list.id);
              else dirtyLists.current.delete(list.id);
              onDraftChange?.(dirtyLists.current.size > 0);
            }}
            {...(onInspectCreate ? { onInspect: onInspectCreate } : {})}
          />
        )}
        onLoadMore={(list, section) => {
          if (
            section === 'completed' &&
            (filter.completion ?? 'open') === 'open' &&
            !completed.has(list.id)
          ) {
            setCompleted((previous) => new Set(previous).add(list.id));
          }
          void actions.current.get(list.id)?.[section]();
        }}
        onRetryList={(list) => {
          void actions.current.get(list.id)?.retry();
        }}
      />
    </>
  );
}
