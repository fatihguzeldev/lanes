import { Icon } from '../../../../shared/ui/icon/Icon';
import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';
import { Submenu } from '../../../../shared/ui/submenu/Submenu';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { request } from '../../../../shared/browser/http/http';
import { BoardListPageSchema } from '../../contracts/query';
import type { useBoardData } from '../navigation/useBoardData';
import { TaskMovePlacement, type TaskMoveContext } from './TaskMovePlacement';

export type TaskMoveWorkspace = Pick<ReturnType<typeof useBoardData>, 'board' | 'boards' | 'lists'>;

export function TaskMoveDestinations(
  props: TaskMoveContext & { boardId: string | null; workspace: TaskMoveWorkspace },
) {
  const { task, boardId, workspace } = props;
  const boards = workspace.boards;
  const destinations = boards.items.filter(
    (board) => board.accountId === task.accountId && board.id !== boardId,
  );
  const moreBoards =
    destinations.length > 0 || boards.status === 'loading' || boards.error || boards.nextCursor;
  const boardRows = (
    <>
      {destinations.map((board) => (
        <Submenu
          key={board.id}
          label={`lists in ${board.title || 'untitled board'}`}
          trigger={
            <>
              <Icon name="board" size={15} />
              <span>{board.title || 'untitled board'}</span>
            </>
          }
        >
          <TaskMoveLists {...props} boardId={board.id} />
        </Submenu>
      ))}
      {boards.status === 'loading' && !boards.items.length && <LoadingDestinations />}
      {boards.error && (
        <button type="button" className="popover__item" onClick={() => void boards.reload()}>
          retry boards
        </button>
      )}
      {boards.nextCursor && (
        <button
          type="button"
          className="popover__item"
          disabled={boards.status === 'loading'}
          onClick={() => void boards.loadMore()}
        >
          more boards
        </button>
      )}
    </>
  );
  return (
    <>
      {boardId && <TaskMoveLists {...props} boardId={boardId} />}
      {boardId
        ? moreBoards && (
            <Submenu
              label="other boards"
              trigger={
                <>
                  <Icon name="board" size={15} />
                  <span>other boards</span>
                </>
              }
            >
              {boardRows}
            </Submenu>
          )
        : boardRows}
    </>
  );
}

function TaskMoveLists(props: TaskMoveContext & { boardId: string; workspace: TaskMoveWorkspace }) {
  if (
    props.workspace.board?.accountId === props.task.accountId &&
    props.workspace.board.id === props.boardId
  )
    return <TaskMoveListRows {...props} lists={props.workspace.lists} />;
  return <TaskMoveRemoteLists {...props} />;
}

function TaskMoveRemoteLists(props: TaskMoveContext & { boardId: string }) {
  const { task, boardId } = props;
  const base = `/api/accounts/${encodeURIComponent(task.accountId)}`;
  const lists = usePagedResource(
    `${task.accountId}:move-lists:${boardId}`,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(boardId)}/lists${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  return <TaskMoveListRows {...props} lists={lists} />;
}

function TaskMoveListRows({
  controller,
  task,
  disabled,
  boardId,
  lists,
}: TaskMoveContext & { boardId: string; lists: TaskMoveWorkspace['lists'] }) {
  return (
    <>
      {lists.items
        .filter((list) => list.accountId === task.accountId && list.boardId === boardId)
        .map((list) => (
          <div className="task-move-picker__destination" key={list.id}>
            <button
              type="button"
              className="popover__item"
              disabled={disabled || (list.id === task.listId && task.parentId === null)}
              onClick={() =>
                controller.choose({ list, position: 'last', parent: null, previous: null })
              }
            >
              <Icon name="list" size={15} />
              <span>{list.title || 'untitled list'}</span>
              {list.id === task.listId && <Icon name="check" size={13} />}
            </button>
            <Submenu
              label={`placement in ${list.title || 'untitled list'}`}
              trigger={null}
              triggerClassName="task-move-picker__more"
              disabled={disabled}
            >
              <TaskMovePlacement
                controller={controller}
                task={task}
                disabled={disabled}
                list={list}
              />
            </Submenu>
          </div>
        ))}
      {lists.status === 'loading' && !lists.items.length && <LoadingDestinations />}
      {lists.error && (
        <button type="button" className="popover__item" onClick={() => void lists.reload()}>
          retry lists
        </button>
      )}
      {lists.status === 'ready' && !lists.items.length && (
        <p className="task-move-picker__message">no lists in this board.</p>
      )}
      {lists.nextCursor && (
        <button
          type="button"
          className="popover__item"
          disabled={lists.status === 'loading'}
          onClick={() => void lists.loadMore()}
        >
          more lists
        </button>
      )}
    </>
  );
}

function LoadingDestinations() {
  return (
    <div className="task-move-picker__loading" aria-label="loading destinations" role="status">
      {[0, 1, 2].map((key) => (
        <Skeleton className="task-move-picker__loading-line" key={key} />
      ))}
    </div>
  );
}
