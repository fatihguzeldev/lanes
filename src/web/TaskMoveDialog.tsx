import { useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import { TaskConsequencesSchema } from '../modules/tasks/consequence-contract';
import type { Task } from '../modules/tasks/contracts';
import { Dialog } from '../ui/Dialog';
import { request } from './http';
import { BoardPageSchema, BoardListPageSchema } from './schemas';
import { usePagedResource } from './usePagedResource';
import { useTaskQuery } from './useTaskQuery';
import { newOperationId, useCommands } from './useCommands';

interface Props {
  account: ConnectionSummary;
  task: Task;
  initialBoardId: string;
  clockOffset: number;
  onClose: () => void;
  onChanged: () => void;
}
export function TaskMoveDialog({
  account,
  task,
  initialBoardId,
  clockOffset,
  onClose,
  onChanged,
}: Props) {
  const [boardId, setBoardId] = useState(initialBoardId),
    [listId, setListId] = useState(task.listId),
    [parentId, setParentId] = useState('');
  const [position, setPosition] = useState<'first' | 'last' | 'after'>('last'),
    [afterId, setAfterId] = useState('');
  const [preview, setPreview] = useState<ReturnType<typeof TaskConsequencesSchema.parse> | null>(
      null,
    ),
    [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false),
    [identity] = useState(() => newOperationId(clockOffset));
  const commands = useCommands(account.id, clockOffset, onChanged),
    base = `/api/accounts/${encodeURIComponent(account.id)}`;
  const boards = usePagedResource(
    `${account.id}:move-boards`,
    (cursor, signal) =>
      request(
        `${base}/boards${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const lists = usePagedResource(
    `${account.id}:move-lists:${boardId}`,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(boardId)}/lists${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const destination = lists.items.find((list) => list.id === listId) ?? lists.items[0] ?? null;
  const parentInput = useMemo(
    () =>
      destination
        ? {
            listIds: [destination.id],
            parentId: null,
            filter: { completion: 'all' as const },
            sort: 'manual' as const,
          }
        : null,
    [destination?.id],
  );
  const parents = useTaskQuery(account.id, parentInput);
  const siblingInput = useMemo(
    () =>
      destination && parentId
        ? {
            listIds: [destination.id],
            parentId,
            filter: { completion: 'all' as const },
            sort: 'manual' as const,
          }
        : null,
    [destination?.id, parentId],
  );
  const childSiblings = useTaskQuery(account.id, siblingInput);
  const siblings = parentId ? childSiblings : parents;
  const parent = parents.page.items.find((item) => item.id === parentId);
  const previous = siblings.page.items.find((item) => item.id === afterId);
  useEffect(() => {
    const abort = new AbortController();
    void request(
      `${base}/tasks/${encodeURIComponent(task.id)}/consequences`,
      TaskConsequencesSchema,
      { signal: abort.signal },
    )
      .then(setPreview)
      .catch((error) => {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error ? error.message : 'the source checklist could not be checked.',
          );
      });
    return () => abort.abort();
  }, [base, task.id]);
  const valid =
    destination &&
    preview?.coverageComplete &&
    preview.revision === task.revision &&
    (!parentId || parent) &&
    (!preview.subtaskCount || confirmed) &&
    (!preview.subtaskCount || !parentId) &&
    (position !== 'after' || previous);
  return (
    <Dialog title={`move ${task.title || 'this task'}`} onClose={onClose} pending={commands.busy}>
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !destination || !preview) return;
          const command = {
            kind: 'task.move',
            taskId: task.id,
            revision: task.revision,
            listId: destination.id,
            listRevision: destination.revision,
            parentId: parentId || null,
            ...(parent ? { parentRevision: parent.revision } : {}),
            ...(position === 'first'
              ? { previousId: null }
              : position === 'after' && previous
                ? { previousId: previous.id, previousRevision: previous.revision }
                : {}),
            confirmSubtaskCount: preview.subtaskCount,
          };
          void commands.submit(command, 'provider', identity).then((result) => {
            if (result?.state === 'succeeded') {
              onChanged();
              onClose();
            }
          });
        }}
      >
        <p>
          {account.email}. this moves the original task and preserves its lanes identity and
          history.
        </p>
        <label>
          destination board
          <select
            value={boardId}
            onChange={(event) => {
              setBoardId(event.target.value);
              setListId('');
              setParentId('');
              setAfterId('');
              setConfirmed(false);
            }}
          >
            {boards.items.map((board) => (
              <option value={board.id} key={board.id}>
                {board.title}
              </option>
            ))}
          </select>
        </label>
        {boards.nextCursor && (
          <button type="button" onClick={() => void boards.loadMore()}>
            more boards
          </button>
        )}
        <label>
          destination list
          <select
            value={destination?.id ?? ''}
            disabled={lists.status === 'loading'}
            onChange={(event) => {
              setListId(event.target.value);
              setParentId('');
              setAfterId('');
              setConfirmed(false);
            }}
          >
            <option value="" disabled>
              choose a list
            </option>
            {lists.items.map((list) => (
              <option key={list.id} value={list.id}>
                {list.title || 'untitled list'}
              </option>
            ))}
          </select>
        </label>
        {lists.nextCursor && (
          <button type="button" onClick={() => void lists.loadMore()}>
            more lists
          </button>
        )}
        <label>
          nesting
          <select
            value={parentId}
            disabled={!task.capabilities.canNest || !!preview?.subtaskCount}
            onChange={(event) => {
              setParentId(event.target.value);
              setAfterId('');
            }}
          >
            <option value="">top level</option>
            {parents.page.items
              .filter(
                (item) =>
                  item.id !== task.id &&
                  !item.parentId &&
                  item.capabilities.canHaveChildren &&
                  !item.unsupportedHierarchy,
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  under {item.title || 'untitled task'}
                </option>
              ))}
          </select>
        </label>
        {parents.page.nextCursor && (
          <button type="button" onClick={() => void parents.loadMore()}>
            more possible parents
          </button>
        )}
        <label>
          position
          <select
            value={position}
            onChange={(event) => setPosition(event.target.value as typeof position)}
          >
            <option value="last">last in this group</option>
            <option value="first">first in this group</option>
            <option value="after">after a specific task</option>
          </select>
        </label>
        {position === 'after' && (
          <>
            <label>
              previous sibling
              <select value={afterId} onChange={(event) => setAfterId(event.target.value)}>
                <option value="">choose a task</option>
                {siblings.page.items
                  .filter((item) => item.id !== task.id && item.parentId === (parentId || null))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title || 'untitled task'}
                    </option>
                  ))}
              </select>
            </label>
            {siblings.page.nextCursor && (
              <button type="button" onClick={() => void siblings.loadMore()}>
                more siblings
              </button>
            )}
          </>
        )}
        {!!preview?.subtaskCount && (
          <label>
            <span>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                style={{ width: 'auto' }}
              />{' '}
              move the task and its {preview.subtaskCount} subtasks together.
            </span>
            <small>a parent with children stays at the top level.</small>
          </label>
        )}
        {preview && preview.revision !== task.revision && (
          <p className="error">
            the source changed. close this dialog and review its current values before moving it.
          </p>
        )}
        {preview && !preview.coverageComplete && (
          <p className="error">
            refresh complete source list coverage before moving its task tree.
          </p>
        )}
        {(error ||
          commands.error ||
          lists.error ||
          boards.error ||
          parents.error ||
          childSiblings.error) && (
          <p className="error" role="alert">
            {error ||
              commands.error ||
              lists.error ||
              boards.error ||
              parents.error ||
              childSiblings.error}
          </p>
        )}
        <footer>
          <button type="button" disabled={commands.busy} onClick={onClose}>
            cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              !valid || commands.busy || account.state !== 'connected' || !task.capabilities.canMove
            }
          >
            {commands.busy ? 'moving…' : 'move task'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
