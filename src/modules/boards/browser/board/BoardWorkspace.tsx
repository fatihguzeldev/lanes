import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Board, BoardList } from '../../contracts/board';
import { BoardSurface, type BoardColumn, type BoardSurfaceProps } from './BoardSurface';
import { selectTasksWithContext, sortTasks } from '../../../tasks/model/task';
import type { TaskFilter, TaskSort } from '../../../tasks/contracts/task';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import { unknownCoverage } from '../../../../shared/browser/resources/usePagedResource';
import { InlineTaskCreate } from '../../../tasks/browser/creation/InlineTaskCreate';
import {
  creationAcknowledged,
  type PendingTaskCreation,
} from '../../../tasks/browser/creation/useTaskCreations';
import {
  taskChangeAcknowledged,
  projectTaskCollection,
  type PendingTaskChange,
} from '../../../tasks/browser/changes/useTaskChanges';
import { projectSubtaskSummary } from '../../../tasks/browser/changes/project-subtask-summary';
import type { TaskMoveQueue } from '../../../tasks/browser/movement/useTaskMoveQueue';
import { projectTaskMoves } from '../../../tasks/browser/movement/task-move-model';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';

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
      readVersion:
        open.status === 'ready' &&
        open.settled &&
        (!completedInput || (completed.status === 'ready' && completed.settled))
          ? version
          : undefined,
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
      completed.settled,
      completedInput,
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
  onInitialReady?: (state: InitialViewReadiness) => void;
  moveQueue: TaskMoveQueue;
  creations?: readonly PendingTaskCreation[];
  onCreationRead?(id: number): void;
  edits?: readonly PendingTaskChange[];
  onEditRead?(id: string | number): void;
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
  onInitialReady,
  moveQueue,
  creations = [],
  onCreationRead,
  edits = [],
  onEditRead,
  ...props
}: BoardWorkspaceProps) {
  const [data, setData] = useState<Record<string, BoardColumn>>({}),
    [completed, setCompleted] = useState<Set<string>>(() => new Set());
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
  const activeEdits = edits.filter(
    (edit) =>
      !taskChangeAcknowledged(
        edit,
        columns.find((column) => column.list.id === edit.task.listId)?.readVersion,
      ),
  );
  const projectedTasks = projectTaskCollection(
    columns.flatMap((column) => column.tasks),
    activeEdits,
    undefined,
    (task) => task.accountId === account.id,
    moveQueue.moves,
  );
  const queuedColumns = projectTaskMoves(columns, moveQueue.moves).map((column) => ({
    ...column,
    tasks: projectedTasks.filter((task) => task.listId === column.list.id),
  }));
  const displayedColumns = queuedColumns.map((column) => {
    const pendingCreations = creations.filter(
      (creation) =>
        creation.input.accountId === account.id &&
        creation.input.listId === column.list.id &&
        !creationAcknowledged(creation, column.readVersion),
    );
    const projected = column.tasks.filter(
      (task) => !pendingCreations.some((creation) => creation.resolvedTaskId === task.id),
    );
    const selected = selectTasksWithContext(projected, {
      accountId: account.id,
      today,
      query,
      labels: props.labels,
      lists,
      filter: { ...filter, completion: filter.completion === 'completed' ? 'completed' : 'all' },
    });
    const summaries = { ...column.subtaskSummaries };
    for (const task of selected.tasks) {
      const summary = projectSubtaskSummary(
        task,
        summaries[task.id],
        columns.flatMap((source) => source.tasks),
        column.tasks,
        activeEdits,
      );
      if (summary) summaries[task.id] = summary;
    }
    return {
      ...column,
      tasks: sort === 'manual' ? selected.tasks : sortTasks(selected.tasks, sort),
      matchedTaskIds: selected.matchedTaskIds,
      subtaskSummaries: summaries,
      creations: pendingCreations.filter((creation) => !creation.deleted),
    };
  });
  useEffect(() => {
    for (const edit of edits) {
      const column = columns.find(
        (item) => item.list.accountId === edit.task.accountId && item.list.id === edit.task.listId,
      );
      if (column && taskChangeAcknowledged(edit, column.readVersion)) onEditRead?.(edit.id);
    }
  }, [columns, edits, onEditRead]);
  useEffect(() => {
    for (const creation of creations) {
      const column = columns.find(
        (item) =>
          item.list.accountId === creation.input.accountId &&
          item.list.id === creation.input.listId,
      );
      if (column && creationAcknowledged(creation, column.readVersion))
        onCreationRead?.(creation.id);
    }
  }, [columns, creations, onCreationRead]);
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
        columns={displayedColumns}
        onMoveTask={(intent) => moveQueue.enqueue(intent, columns, moveScope)}
        today={today}
        accountTimeZone={account.planningZone}
        sort={sort}
        providerActionsEnabled={providerActionsEnabled}
        renderTaskCreate={(list) => (
          <InlineTaskCreate
            accountId={account.id}
            listId={list.id}
            enabled={providerActionsEnabled && !!props.onAddTask}
            onCreate={() => props.onAddTask?.(list)}
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
