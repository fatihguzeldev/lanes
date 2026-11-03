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
import { unknownCoverage } from './usePagedResource';

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
  onData: (id: string, data: BoardColumn) => void;
  onActions: (id: string, actions: Actions) => void;
}
function ColumnData({
  accountId,
  list,
  filter,
  query,
  sort,
  version,
  completedRequested,
  onData,
  onActions,
}: ColumnDataProps) {
  const completion = filter.completion ?? 'open';
  const input = useMemo(
    () => ({ listIds: [list.id], query, sort, filter: { ...filter, completion } }),
    [list.id, filter, query, sort, completion],
  );
  const completedInput = useMemo(
    () =>
      completedRequested && completion === 'open'
        ? { ...input, filter: { ...filter, completion: 'completed' as const } }
        : null,
    [completedRequested, input, filter, completion],
  );
  const open = useTaskQuery(accountId, input, version),
    completed = useTaskQuery(accountId, completedInput, version);
  const data = useMemo<BoardColumn>(
    () => ({
      list,
      tasks: [
        ...new Map(
          [...open.page.items, ...completed.page.items].map((task) => [task.id, task]),
        ).values(),
      ],
      coverage: open.page.coverage,
      status: open.status,
      nextCursor: open.page.nextCursor,
      errorMessage: open.error,
      completedCoverage:
        completion !== 'open'
          ? open.page.coverage
          : completed.loaded
            ? completed.page.coverage
            : unknownCoverage,
      completedNextCursor: completion !== 'open' ? open.page.nextCursor : completed.page.nextCursor,
      completedLoading: completedRequested && completed.status === 'loading',
      completedError: completed.error,
      color: list.color,
      subtaskSummaries: { ...open.page.subtaskSummaries, ...completed.page.subtaskSummaries },
      matchedTaskIds: open.page.matchedTaskIds,
    }),
    [
      list,
      open.page,
      open.status,
      open.error,
      completed.page,
      completed.status,
      completed.error,
      completed.loaded,
      completedRequested,
      completion,
    ],
  );
  useEffect(() => onData(list.id, data), [list.id, data, onData]);
  const latest = useRef({ open, completed });
  latest.current = { open, completed };
  useEffect(
    () =>
      onActions(list.id, {
        open: () => latest.current.open.loadMore(),
        completed: () =>
          completion !== 'open'
            ? latest.current.open.loadMore()
            : latest.current.completed.loaded
              ? latest.current.completed.loadMore()
              : latest.current.completed.reload(),
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
  ...props
}: BoardWorkspaceProps) {
  const [data, setData] = useState<Record<string, BoardColumn>>({}),
    [completed, setCompleted] = useState<Set<string>>(() => new Set());
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
        nextCursor: null,
      },
  );
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
          onData={onData}
          onActions={onActions}
        />
      ))}
      <BoardSurface
        {...props}
        key={filter.completion ?? 'open'}
        expandCompleted={!!filter.completion && filter.completion !== 'open'}
        accountId={account.id}
        columns={columns}
        today={today}
        accountTimeZone={account.planningZone}
        sort={sort}
        providerActionsEnabled={providerActionsEnabled}
        onLoadMore={(list, section) => {
          if (
            section === 'completed' &&
            (filter.completion ?? 'open') === 'open' &&
            !completed.has(list.id)
          ) {
            setCompleted((previous) => new Set(previous).add(list.id));
            return;
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
