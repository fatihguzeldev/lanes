import type { ComponentProps, ReactNode } from 'react';
import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import type { Board, BoardList } from '../../modules/boards/contracts/board';
import type {
  Label,
  Task,
  TaskFilter,
  TaskList,
  TaskSort,
} from '../../modules/tasks/contracts/task';
import type { BoardViewPreferences } from '../../modules/boards/browser/view/view-preferences';
import type { useBoardData } from '../../modules/boards/browser/navigation/useBoardData';
import type { TaskMoveQueue } from '../../modules/tasks/browser/movement/useTaskMoveQueue';
import type { InitialViewReadiness } from '../../shared/browser/resources/readiness';
import { BoardWorkspace } from '../../modules/boards/browser/board/BoardWorkspace';
import { CalendarWorkspace } from '../../modules/boards/browser/calendar/CalendarWorkspace';
import { CompletedWorkspace } from '../../modules/boards/browser/completed/CompletedWorkspace';
import { BoardSkeleton } from '../../modules/boards/browser/board/BoardSkeleton';
import { TaskCollectionWorkspace } from '../../modules/tasks/browser/queries/TaskCollectionWorkspace';
import { Icon } from '../../shared/ui/icon/Icon';

interface ViewActions {
  onChanged(): void;
  onReturnToBoard(): void;
  onClearCompletedFilters(): void;
  onAddList(): void;
  onAddTask(list: TaskList): void;
  onOpenTask(task: Task): void;
  onToggleComplete(task: Task, completed: boolean): void;
  onToggleStar(task: Task, starred: boolean): Promise<boolean>;
  onTaskMenu(task: Task, anchor: HTMLButtonElement): void;
  onListMenu(list: BoardList | null, anchor: HTMLButtonElement): void;
  onOpenBoard(id: string): void;
  onCreateTask: ComponentProps<typeof CalendarWorkspace>['onCreateTask'];
  onReschedule: ComponentProps<typeof CalendarWorkspace>['onReschedule'];
}
interface Props {
  account: ConnectionSummary;
  board: Board | null;
  boardId: string | null;
  boardsError: string;
  failedBoardLookup: string | null;
  awaitingBoard: boolean;
  lists: ReturnType<typeof useBoardData>['lists'];
  visibleLists: readonly BoardList[];
  labels: readonly Label[];
  today: string;
  viewPreferences: BoardViewPreferences;
  quick: 'all' | 'today' | 'starred';
  searchScope: 'board' | 'account';
  search: string;
  filter: TaskFilter;
  activeFilter: TaskFilter;
  sort: TaskSort;
  version: number;
  clockOffset: number;
  writable: boolean;
  localWritable: boolean;
  pendingTaskIds: ReadonlySet<string>;
  moveQueue: TaskMoveQueue;
  listCreation: ReactNode;
  onInitialReady(state: InitialViewReadiness): void;
  actions: ViewActions;
}
export function WorkspaceViews({
  account,
  board,
  boardId,
  boardsError,
  failedBoardLookup,
  awaitingBoard,
  lists,
  visibleLists,
  labels,
  today,
  viewPreferences,
  quick,
  searchScope,
  search,
  filter,
  activeFilter,
  sort,
  version,
  clockOffset,
  writable,
  localWritable,
  pendingTaskIds,
  moveQueue,
  listCreation,
  onInitialReady,
  actions,
}: Props) {
  const view = viewPreferences.view;
  return (
    <>
      {board &&
        quick === 'all' &&
        !(searchScope === 'account' && search) &&
        (view === 'board' || view === 'list') && (
          <BoardWorkspace
            key={`${account.id}:${board.id}`}
            account={account}
            board={board}
            lists={visibleLists}
            today={today}
            labels={labels}
            filter={activeFilter}
            query={search}
            sort={sort}
            version={version}
            onInitialReady={onInitialReady}
            layout={view === 'list' ? 'stacked' : 'kanban'}
            showCounts={viewPreferences.showCounts}
            showCompleted={
              viewPreferences.showCompleted || (!!filter.completion && filter.completion !== 'open')
            }
            showNotes={viewPreferences.showNotes}
            providerActionsEnabled={writable}
            localActionsEnabled={localWritable}
            filtered={!!search || quick !== 'all' || Object.keys(filter).length > 0}
            status={lists.status}
            pendingTaskIds={pendingTaskIds}
            errorMessage={lists.error}
            onRetry={() => void lists.reload()}
            onAddList={actions.onAddList}
            listCreation={listCreation}
            {...(lists.nextCursor ? { onLoadMoreLists: () => void lists.loadMore() } : {})}
            onAddTask={actions.onAddTask}
            onOpenTask={actions.onOpenTask}
            onToggleComplete={actions.onToggleComplete}
            onToggleStar={actions.onToggleStar}
            onTaskMenu={actions.onTaskMenu}
            onListMenu={(list, anchor) =>
              actions.onListMenu(visibleLists.find((item) => item.id === list.id) ?? null, anchor)
            }
            moveQueue={moveQueue}
          />
        )}
      {board &&
        (quick !== 'all' || (searchScope === 'account' && !!search)) &&
        (view === 'board' || view === 'list') && (
          <TaskCollectionWorkspace
            account={account}
            today={today}
            labels={labels}
            query={search}
            filter={activeFilter}
            sort={sort}
            version={version}
            onInitialReady={onInitialReady}
            onOpenTask={actions.onOpenTask}
            onToggleComplete={actions.onToggleComplete}
            onToggleStar={actions.onToggleStar}
            onTaskMenu={actions.onTaskMenu}
            localActionsEnabled={localWritable}
            pendingTaskIds={pendingTaskIds}
            onOpenBoard={actions.onOpenBoard}
          />
        )}
      {board && view === 'calendar' && (
        <CalendarWorkspace
          key={`${account.id}:${board.id}`}
          account={account}
          board={board}
          lists={visibleLists}
          today={today}
          filter={activeFilter}
          query={search}
          sort={sort}
          version={version}
          onInitialReady={onInitialReady}
          providerActionsEnabled={writable}
          onOpenTask={actions.onOpenTask}
          onTaskMenu={actions.onTaskMenu}
          onCreateTask={actions.onCreateTask}
          onReschedule={actions.onReschedule}
        />
      )}
      {board && view === 'completed' && (
        <CompletedWorkspace
          clockOffset={clockOffset}
          key={`${account.id}:${board.id}`}
          account={account}
          board={board}
          lists={visibleLists}
          query={search}
          filter={activeFilter}
          version={version}
          onInitialReady={onInitialReady}
          onOpenTask={actions.onOpenTask}
          onReturn={actions.onReturnToBoard}
          onClearFilters={actions.onClearCompletedFilters}
          onTaskMenu={actions.onTaskMenu}
        />
      )}
      {!board &&
        (awaitingBoard ? (
          <div className="board-surface">
            <div className="board-surface__scroll">
              <BoardSkeleton
                showAddList={quick === 'all' && !(searchScope === 'account' && search)}
              />
            </div>
          </div>
        ) : (
          <div className="workspace__empty">
            <Icon name="board" size={26} />
            <h2>
              {failedBoardLookup === boardId && boardId
                ? 'couldn’t load this board'
                : boardsError
                  ? 'couldn’t load your boards'
                  : 'no boards yet'}
            </h2>
            {boardsError ? (
              <p role="alert">{boardsError}</p>
            ) : (
              !failedBoardLookup && (
                <p>your google lists will appear here when the first refresh is ready.</p>
              )
            )}
            {(boardsError || (boardId && failedBoardLookup === boardId)) && (
              <button className="workspace__retry-board" onClick={actions.onChanged}>
                try again
              </button>
            )}
          </div>
        ))}
    </>
  );
}
