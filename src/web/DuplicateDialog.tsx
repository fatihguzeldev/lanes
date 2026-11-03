import { useMemo, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import type { BoardList } from '../modules/boards/contracts';
import { DuplicatePreviewSchema } from '../modules/tasks/consequence-contract';
import type { Task } from '../modules/tasks/contracts';
import type { ProviderCommandInput } from '../modules/tasks/provider-command-contract';
import { Dialog } from '../ui/Dialog';
import { request } from './http';
import { BoardPageSchema, BoardListPageSchema } from './schemas';
import { usePagedResource } from './usePagedResource';
import { newOperationId, useCommands } from './useCommands';
import { useServerConnection } from './useServerConnection';
interface Props {
  account: ConnectionSummary;
  source: { kind: 'list'; list: BoardList } | { kind: 'task'; task: Task; boardId: string };
  clockOffset: number;
  onClose: () => void;
  onChanged: () => void;
  onInspect: (id: string) => void;
  onRefresh: () => void;
}
export function DuplicateDialog({
  account,
  source,
  clockOffset,
  onClose,
  onChanged,
  onInspect,
  onRefresh,
}: Props) {
  const [boardId, setBoardId] = useState(
    source.kind === 'list' ? source.list.boardId : source.boardId,
  );
  const [listId, setListId] = useState(source.kind === 'task' ? source.task.listId : '');
  const [title, setTitle] = useState(
    (source.kind === 'list' ? source.list.title : source.task.title) + ' copy',
  );
  const [includeCompleted, setIncludeCompleted] = useState(false),
    [repeatConfirmed, setRepeatConfirmed] = useState(false),
    [dependenciesConfirmed, setDependenciesConfirmed] = useState(false);
  const [preview, setPreview] = useState<{
      key: string;
      value: ReturnType<typeof DuplicatePreviewSchema.parse>;
    } | null>(null),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const [identity, setIdentity] = useState(() => newOperationId(clockOffset)),
    [attempted, setAttempted] = useState(false);
  const commands = useCommands(account.id, clockOffset, onChanged),
    connection = useServerConnection(),
    base = `/api/accounts/${encodeURIComponent(account.id)}`;
  const boards = usePagedResource(
    `${account.id}:copy:boards`,
    (cursor, signal) =>
      request(
        `${base}/boards${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const lists = usePagedResource(
    source.kind === 'task' ? `${account.id}:copy:lists:${boardId}` : null,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(boardId)}/lists${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const destinationBoard = boards.items.find((item) => item.id === boardId),
    destinationList = lists.items.find((item) => item.id === listId);
  const command = useMemo<ProviderCommandInput | null>(
    () =>
      source.kind === 'list'
        ? {
            kind: 'list.duplicate',
            listId: source.list.id,
            revision: source.list.revision,
            title,
            boardId,
            ...(destinationBoard ? { boardRevision: destinationBoard.revision } : {}),
            includeCompleted,
          }
        : destinationList
          ? {
              kind: 'task.duplicate',
              taskId: source.task.id,
              revision: source.task.revision,
              listId: destinationList.id,
              listRevision: destinationList.revision,
              parentId: null,
              title,
              includeCompleted,
            }
          : null,
    [
      source,
      title,
      boardId,
      destinationBoard?.revision,
      destinationList?.id,
      destinationList?.revision,
      includeCompleted,
    ],
  );
  const key = JSON.stringify(command),
    current = preview?.key === key ? preview.value : null;
  const required = source.kind === 'list' ? 1 : 0,
    capacityReady =
      !required ||
      (!!current &&
        !current.capacity.stale &&
        current.capacity.available !== null &&
        current.capacity.available >= required);
  const valid =
    !!command &&
    !!title.trim() &&
    !!current?.preview.coverageComplete &&
    capacityReady &&
    (!current.preview.repeatingTaskCount || repeatConfirmed) &&
    (!current.preview.externalDependencyCount || dependenciesConfirmed);
  const readPreview = async () => {
    if (!command || reading) return;
    setReading(true);
    setError('');
    setRepeatConfirmed(false);
    setDependenciesConfirmed(false);
    try {
      setPreview({
        key,
        value: await request(`${base}/copies/preview`, DuplicatePreviewSchema, {
          method: 'POST',
          body: { command },
        }),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'this copy could not be checked.');
    } finally {
      setReading(false);
    }
  };
  const recorded = commands.latest?.id === identity ? commands.latest : null;
  return (
    <Dialog
      title={source.kind === 'list' ? 'duplicate list' : 'duplicate task'}
      onClose={onClose}
      pending={commands.busy && !recorded}
    >
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !command || !current || attempted) return;
          setAttempted(true);
          void commands
            .submit(
              {
                ...command,
                ...(current.preview.repeatingTaskCount ? { confirmIndependentRepeat: true } : {}),
                confirmOmittedDependencyCount: current.preview.externalDependencyCount,
              },
              'provider',
              identity,
            )
            .then((result) => {
              if (result?.state === 'succeeded') {
                onChanged();
                onClose();
              }
            });
        }}
      >
        <p>{account.email}. the original stays in place. every copied task gets a new identity.</p>
        <fieldset disabled={commands.busy || attempted} style={{ display: 'contents' }}>
          <label>
            {source.kind === 'list' ? 'new list name' : 'new task title'}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={1024}
              required
            />
          </label>
          <label>
            destination board
            <select
              value={boardId}
              onChange={(event) => {
                setBoardId(event.target.value);
                setListId('');
              }}
            >
              {!destinationBoard && <option value={boardId}>current board</option>}
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
          {source.kind === 'task' && (
            <>
              <label>
                destination list
                <select value={listId} onChange={(event) => setListId(event.target.value)}>
                  <option value="">choose a list</option>
                  {lists.items.map((list) => (
                    <option value={list.id} key={list.id}>
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
            </>
          )}
          <label>
            <span>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={includeCompleted}
                onChange={(event) => setIncludeCompleted(event.target.checked)}
              />{' '}
              include completed tasks
            </span>
          </label>
          <button
            type="button"
            disabled={!command || !title.trim() || reading || connection !== 'reachable'}
            onClick={() => void readPreview()}
          >
            {reading ? 'checking…' : current ? 'refresh preview' : 'preview copy'}
          </button>
        </fieldset>
        {current && (
          <section aria-label="copy preview">
            <p>
              <strong>{current.preview.taskCount} tasks</strong>
              {current.preview.contextParentCount
                ? `, including ${current.preview.contextParentCount} parents copied as open context`
                : ''}
              . dates, notes, order and lanes metadata are copied. history stays with the original.
            </p>
            {required > 0 && (
              <p>
                {required} list slot needed · {current.capacity.available ?? 'unknown'} available
                {current.capacity.stale ? ' · refresh needed' : ''}.
              </p>
            )}
            {!current.preview.coverageComplete && (
              <p className="error">source coverage is incomplete. refresh it before copying.</p>
            )}
            {(!current.preview.coverageComplete || current.capacity.stale) && (
              <button type="button" onClick={onRefresh}>
                refresh google inventory
              </button>
            )}
            {!!current.preview.repeatingTaskCount && (
              <label>
                <span>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={repeatConfirmed}
                    onChange={(event) => setRepeatConfirmed(event.target.checked)}
                    disabled={attempted}
                  />{' '}
                  {current.preview.repeatingTaskCount} repeat rules become independent series.
                  completed copies do not generate a new occurrence on import.
                </span>
              </label>
            )}
            {!!current.preview.externalDependencyCount && (
              <label>
                <span>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={dependenciesConfirmed}
                    onChange={(event) => setDependenciesConfirmed(event.target.checked)}
                    disabled={attempted}
                  />{' '}
                  omit {current.preview.externalDependencyCount} dependencies outside this copy.
                  internal dependencies point to the new tasks.
                </span>
              </label>
            )}
          </section>
        )}
        {(error || commands.error || boards.error || lists.error) && (
          <p className="error" role="alert">
            {error || commands.error || boards.error || lists.error}
          </p>
        )}
        {attempted && (
          <p role="status">
            {recorded
              ? `${recorded.state.replaceAll('_', ' ')} · ${recorded.confirmedSteps}/${recorded.totalSteps} steps confirmed.`
              : 'the input has been submitted. inspect its receipt before another attempt.'}{' '}
            <button type="button" onClick={() => onInspect(identity)}>
              inspect operation
            </button>
          </p>
        )}
        {recorded?.finished && recorded.state === 'failed' && (
          <button
            type="button"
            onClick={() => {
              setIdentity(newOperationId(clockOffset));
              setAttempted(false);
              setPreview(null);
              commands.clearError();
            }}
          >
            review a new attempt
          </button>
        )}
        <footer>
          <button type="button" disabled={commands.busy && !recorded} onClick={onClose}>
            {attempted ? 'close' : 'cancel'}
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              !valid ||
              commands.busy ||
              attempted ||
              account.state !== 'connected' ||
              connection !== 'reachable'
            }
          >
            {commands.busy ? 'copying…' : 'create independent copy'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
