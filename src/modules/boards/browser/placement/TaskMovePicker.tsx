import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { request } from '../../../../shared/browser/http/http';
import { BoardPageSchema, BoardListPageSchema } from '../../contracts/query';
import type { BoardList } from '../../contracts/board';
import type { Task } from '../../../tasks/contracts/task';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import type { TaskPlacement } from './useTaskPlacement';
import './TaskMovePicker.css';

type Page =
  | { kind: 'boards' }
  | { kind: 'lists'; boardId: string }
  | { kind: 'position'; list: BoardList; parent: Task | null }
  | { kind: 'parents'; list: BoardList }
  | { kind: 'siblings'; list: BoardList; parent: Task | null };

export function TaskMovePicker({ controller }: { controller: TaskPlacement }) {
  const selection = controller.selection!;
  const task = controller.source?.task ?? selection.task;
  const [page, setPage] = useState<Page>(
    selection.boardId ? { kind: 'lists', boardId: selection.boardId } : { kind: 'boards' },
  );
  const base = `/api/accounts/${encodeURIComponent(task.accountId)}`;
  const boards = usePagedResource(
    `${task.accountId}:move-boards`,
    (cursor, signal) =>
      request(
        `${base}/boards${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const boardId = page.kind === 'lists' ? page.boardId : null;
  const lists = usePagedResource(
    boardId ? `${task.accountId}:move-lists:${boardId}` : null,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(boardId!)}/lists${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const query = useMemo(
    () =>
      page.kind === 'parents' || page.kind === 'siblings'
        ? {
            listIds: [page.list.id],
            parentId: page.kind === 'siblings' ? (page.parent?.id ?? null) : null,
            filter: { completion: 'all' as const },
            sort: 'manual' as const,
          }
        : null,
    [page],
  );
  const tasks = useTaskQuery(task.accountId, query);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    content.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [page, !!controller.confirmation, controller.locked]);
  const back = () => {
    if (page.kind === 'lists') setPage({ kind: 'boards' });
    else if (page.kind === 'position')
      setPage(
        page.parent
          ? { kind: 'parents', list: page.list }
          : { kind: 'lists', boardId: page.list.boardId },
      );
    else if (page.kind === 'parents') setPage({ kind: 'position', list: page.list, parent: null });
    else if (page.kind === 'siblings')
      setPage({ kind: 'position', list: page.list, parent: page.parent });
  };
  const eligibleTasks =
    page.kind === 'parents' || page.kind === 'siblings'
      ? tasks.page.items.filter(
          (item) =>
            item.accountId === task.accountId &&
            item.listId === page.list.id &&
            item.id !== task.id &&
            (page.kind === 'parents'
              ? !item.parentId && item.capabilities.canHaveChildren && !item.unsupportedHierarchy
              : item.parentId === (page.parent?.id ?? null)),
        )
      : [];
  const disabled =
    !controller.enabled ||
    !task.capabilities.canMove ||
    task.unsupportedHierarchy ||
    controller.busy ||
    controller.sourceLoading ||
    !controller.source?.preview.coverageComplete ||
    controller.locked;
  const choose = (
    list: BoardList,
    position: 'first' | 'last' | 'after',
    parent: Task | null = null,
    previous: Task | null = null,
  ) => controller.choose({ list, position, parent, previous });
  const loadingRows = (
    <div className="task-move-picker__loading" aria-label="loading destinations" role="status">
      {[0, 1, 2].map((key) => (
        <Skeleton className="task-move-picker__loading-line" key={key} />
      ))}
    </div>
  );
  return (
    <AnchoredPopover
      anchor={selection.anchor}
      label={`move ${task.title || 'task'}`}
      onClose={controller.close}
      className="task-move-picker"
    >
      <div
        ref={content}
        className="popover__menu"
        onKeyDown={(event) => {
          if (
            event.key === 'ArrowLeft' &&
            page.kind !== 'boards' &&
            !controller.locked &&
            !controller.confirmation
          ) {
            event.preventDefault();
            event.stopPropagation();
            back();
          }
        }}
      >
        {controller.confirmation ? (
          <>
            <p className="task-move-picker__message">
              move this task and its {controller.confirmation.subtaskCount} subtasks to{' '}
              {controller.confirmation.listTitle || 'this list'}?
            </p>
            <button type="button" className="popover__item" onClick={controller.cancelConfirmation}>
              <Icon name="left" size={14} /> back
            </button>
            <button
              type="button"
              className="popover__item"
              disabled={controller.busy || !controller.enabled}
              onClick={controller.confirm}
            >
              <Icon name="arrow" size={15} /> move checklist
            </button>
          </>
        ) : controller.locked ? (
          <>
            <p className="task-move-picker__message">
              {controller.busy
                ? 'moving…'
                : 'this move needs checking before another destination is chosen.'}
            </p>
            {!controller.busy && (
              <button
                type="button"
                className="popover__item"
                onClick={controller.retry}
                disabled={!controller.enabled}
              >
                <Icon name="sync" size={14} /> check again
              </button>
            )}
            <button type="button" className="popover__item" onClick={controller.inspect}>
              <Icon name="history" size={14} /> review save
            </button>
          </>
        ) : (
          <>
            {page.kind !== 'boards' && (
              <button type="button" className="popover__item task-move-picker__back" onClick={back}>
                <Icon name="left" size={14} />{' '}
                {page.kind === 'lists'
                  ? 'boards'
                  : page.kind === 'position' && page.parent
                    ? page.parent.title || 'parent task'
                    : page.kind === 'position' ||
                        page.kind === 'parents' ||
                        page.kind === 'siblings'
                      ? page.list.title || 'untitled list'
                      : 'back'}
              </button>
            )}
            {page.kind === 'boards' && (
              <>
                <p className="task-move-picker__label">move to board</p>
                {boards.items
                  .filter((board) => board.accountId === task.accountId)
                  .map((board) => (
                    <button
                      key={board.id}
                      type="button"
                      className="popover__item"
                      onClick={() => setPage({ kind: 'lists', boardId: board.id })}
                    >
                      <Icon name="board" size={15} />
                      <span>{board.title || 'untitled board'}</span>
                      <Icon name="right" size={13} />
                    </button>
                  ))}
                {boards.status === 'loading' && !boards.items.length && loadingRows}
                {boards.error && (
                  <button
                    type="button"
                    className="popover__item"
                    onClick={() => void boards.reload()}
                  >
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
            )}
            {page.kind === 'lists' && (
              <>
                <p className="task-move-picker__label">
                  {boards.items.find((board) => board.id === page.boardId)?.title || 'move to list'}
                </p>
                {lists.items
                  .filter((list) => list.accountId === task.accountId)
                  .map((list) => (
                    <div className="task-move-picker__destination" key={list.id}>
                      <button
                        type="button"
                        className="popover__item"
                        disabled={disabled || (list.id === task.listId && task.parentId === null)}
                        onClick={() => choose(list, 'last')}
                      >
                        <Icon name="list" size={15} />
                        <span>{list.title || 'untitled list'}</span>
                        {list.id === task.listId && <Icon name="check" size={13} />}
                      </button>
                      <button
                        type="button"
                        className="task-move-picker__more"
                        aria-label={`placement in ${list.title || 'untitled list'}`}
                        disabled={disabled}
                        onClick={() => setPage({ kind: 'position', list, parent: null })}
                      >
                        <Icon name="right" size={13} />
                      </button>
                    </div>
                  ))}
                {lists.status === 'loading' && !lists.items.length && loadingRows}
                {lists.error && (
                  <button
                    type="button"
                    className="popover__item"
                    onClick={() => void lists.reload()}
                  >
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
            )}
            {page.kind === 'position' && (
              <>
                <button
                  type="button"
                  className="popover__item"
                  disabled={disabled}
                  onClick={() => choose(page.list, 'first', page.parent)}
                >
                  <Icon name="up" size={14} /> first {page.parent ? 'under this task' : 'in list'}
                </button>
                <button
                  type="button"
                  className="popover__item"
                  disabled={disabled}
                  onClick={() => choose(page.list, 'last', page.parent)}
                >
                  <Icon name="down" size={14} /> last {page.parent ? 'under this task' : 'in list'}
                </button>
                <button
                  type="button"
                  className="popover__item"
                  disabled={disabled}
                  onClick={() =>
                    setPage({ kind: 'siblings', list: page.list, parent: page.parent })
                  }
                >
                  <Icon name="right" size={14} /> after a task
                </button>
                {!page.parent &&
                  task.capabilities.canNest &&
                  !task.repeatRule &&
                  !controller.source?.preview.subtaskCount && (
                    <button
                      type="button"
                      className="popover__item"
                      disabled={disabled}
                      onClick={() => setPage({ kind: 'parents', list: page.list })}
                    >
                      <Icon name="subtasks" size={14} /> under a task{' '}
                      <Icon name="right" size={13} />
                    </button>
                  )}
              </>
            )}
            {(page.kind === 'parents' || page.kind === 'siblings') && (
              <>
                {eligibleTasks.map((item) => (
                  <div className="task-move-picker__destination" key={item.id}>
                    <button
                      type="button"
                      className="popover__item"
                      disabled={disabled}
                      onClick={() =>
                        choose(
                          page.list,
                          page.kind === 'parents' ? 'last' : 'after',
                          page.kind === 'parents' ? item : page.parent,
                          page.kind === 'siblings' ? item : null,
                        )
                      }
                    >
                      <Icon name={page.kind === 'parents' ? 'subtasks' : 'arrow'} size={14} />
                      <span>{item.title || 'untitled task'}</span>
                    </button>
                    {page.kind === 'parents' && (
                      <button
                        type="button"
                        className="task-move-picker__more"
                        disabled={disabled}
                        aria-label={`position under ${item.title || 'untitled task'}`}
                        onClick={() => setPage({ kind: 'position', list: page.list, parent: item })}
                      >
                        <Icon name="right" size={13} />
                      </button>
                    )}
                  </div>
                ))}
                {tasks.status === 'loading' && !tasks.loaded && loadingRows}
                {tasks.loaded && !tasks.error && !eligibleTasks.length && (
                  <p className="task-move-picker__message">
                    {page.kind === 'parents'
                      ? tasks.page.coverage.complete
                        ? 'no eligible parents.'
                        : 'no eligible parents to show yet.'
                      : tasks.page.coverage.complete
                        ? 'no other tasks in this group.'
                        : 'no other tasks to show yet.'}
                  </p>
                )}
                {tasks.error && (
                  <button
                    type="button"
                    className="popover__item"
                    onClick={() => void tasks.reload()}
                  >
                    retry tasks
                  </button>
                )}
                {tasks.page.nextCursor && (
                  <button
                    type="button"
                    className="popover__item"
                    disabled={tasks.status === 'loading'}
                    onClick={() => void tasks.loadMore()}
                  >
                    more tasks
                  </button>
                )}
              </>
            )}
          </>
        )}
        {controller.error && (
          <div className="task-move-picker__error" role="alert">
            <p>{controller.error}</p>
            {!controller.locked && (
              <button type="button" onClick={controller.reload}>
                try again
              </button>
            )}
          </div>
        )}
        {(!task.capabilities.canMove || task.unsupportedHierarchy) && (
          <p className="task-move-picker__error">
            {task.capabilities.restriction || 'google does not allow moving this task.'}
          </p>
        )}
        {!controller.sourceLoading &&
          controller.source &&
          !controller.source.preview.coverageComplete && (
            <p className="task-move-picker__error">
              refresh the source list before moving this task.
            </p>
          )}
      </div>
    </AnchoredPopover>
  );
}
