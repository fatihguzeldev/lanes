import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Board, BoardList } from '../../contracts/board';
import { BoardSurface, type BoardSurfaceProps } from './BoardSurface';
import { BoardColumnData, type BoardColumnActions } from './BoardColumnData';
import type { BoardColumn } from './board-column';
import { selectTasksWithContext, sortTasks } from '../../../tasks/model/task';
import type { TaskFilter, TaskSort } from '../../../tasks/contracts/task';
import { unknownCoverage } from '../../../../shared/browser/resources/usePagedResource';
import { InlineTaskCreate } from '../../../tasks/browser/creation/InlineTaskCreate';
import {
  creationAcknowledged,
  type PendingTaskCreation,
} from '../../../tasks/browser/creation/creation-model';
import {
  taskChangeAcknowledged,
  projectTaskCollection,
  type PendingTaskChange,
} from '../../../tasks/browser/changes/useTaskChanges';
import { projectSubtaskSummary } from '../../../tasks/browser/changes/project-subtask-summary';
import { collectionCreationMatches } from '../../../tasks/browser/queries/collection-selection';
import type { TaskMoveQueue } from '../../../tasks/browser/movement/useTaskMoveQueue';
import {
  moveReadAcknowledged,
  movesAcknowledged,
  projectTaskMoves,
} from '../../../tasks/browser/movement/task-move-model';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';

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
  const actions = useRef(new Map<string, BoardColumnActions>());
  const onData = useCallback(
    (id: string, column: BoardColumn) => setData((previous) => ({ ...previous, [id]: column })),
    [],
  );
  const onActions = useCallback((id: string, action: BoardColumnActions) => {
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
  const readVersion =
    columns.length && columns.every((column) => column.readVersion !== undefined)
      ? Math.min(...columns.map((column) => column.readVersion!))
      : undefined;
  const displayedMoves = moveQueue.moves.filter(
    (move) =>
      !moveReadAcknowledged(move, readVersion) &&
      !(move.confirmed && movesAcknowledged(columns, [move])),
  );
  useEffect(() => moveQueue.observeRead?.(readVersion), [moveQueue, readVersion]);
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
    displayedMoves,
  );
  const queuedColumns = projectTaskMoves(columns, displayedMoves).map((column) => ({
    ...column,
    tasks: projectedTasks.filter((task) => task.listId === column.list.id),
  }));
  const displayedColumns = queuedColumns.map((column) => {
    const pendingCreations = creations.filter(
      (creation) =>
        creation.input.accountId === account.id &&
        creation.input.listId === column.list.id &&
        !creationAcknowledged(
          creation,
          column.readVersion,
          column.orderReadyTaskIds,
          column.orderReadyListIds,
        ),
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
      creations: pendingCreations.filter((creation) =>
        collectionCreationMatches(
          creation,
          {
            accountId: account.id,
            today,
            query,
            labels: props.labels,
            lists,
            filter: { ...filter, completion: filter.completion ?? 'open' },
          },
          column.tasks,
        ),
      ),
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
      if (
        column &&
        creationAcknowledged(
          creation,
          column.readVersion,
          column.orderReadyTaskIds,
          column.orderReadyListIds,
        )
      )
        onCreationRead?.(creation.id);
    }
  }, [columns, creations, onCreationRead]);
  useEffect(() => {
    moveQueue.reconcile(columns, moveScope);
  }, [columns, moveQueue, moveScope]);
  return (
    <>
      {lists.map((list) => (
        <BoardColumnData
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
