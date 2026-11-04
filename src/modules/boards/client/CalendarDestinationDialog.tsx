import { useState } from 'react';
import type { Board } from '../contracts';
import {
  calendarCreateIntent,
  type CalendarCreateIntent,
  type CalendarScope,
} from '../components/calendar-model';
import { Dialog } from '../../../ui/Dialog';
import { Icon } from '../../../ui/Icon';
import { request } from '../../../client/http';
import { BoardListPageSchema, BoardPageSchema } from '../query-contract';
import { usePagedResource } from '../../../client/usePagedResource';
import { useServerConnection } from '../../../client/useServerConnection';
import { Select } from '../../../ui/Select';
import './CalendarDestinationDialog.css';

export function CalendarDestinationDialog({
  accountId,
  board,
  scope,
  scheduledDay,
  enabled,
  version,
  onChoose,
  onClose,
}: {
  accountId: string;
  board: Board;
  scope: CalendarScope;
  scheduledDay: string | null;
  enabled: boolean;
  version: number;
  onChoose: (intent: CalendarCreateIntent) => void;
  onClose: () => void;
}) {
  const [boardId, setBoardId] = useState(board.id);
  const connection = useServerConnection();
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  const boards = usePagedResource(
    scope === 'account' ? `${accountId}:calendar-destinations` : null,
    (cursor, signal) =>
      request(
        `${base}/boards?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        BoardPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  const lists = usePagedResource(
    `${accountId}:calendar-destination:${boardId}`,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(boardId)}/lists?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  const choices = [
    ...new Map(
      [board, ...boards.items]
        .filter((item) => item.accountId === accountId)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const destinations = lists.items.filter(
    (item) => item.accountId === accountId && item.boardId === boardId,
  );
  return (
    <Dialog title="choose a list" onClose={onClose}>
      <div className="dialog__body calendar-destination">
        <p>
          {scheduledDay ? `new task on ${scheduledDay}` : 'new unscheduled task'} · choose where it
          belongs before writing.
        </p>
        {scope === 'account' && (
          <>
            <label>
              board
              <Select
                value={boardId}
                onChange={(selectedValue) => setBoardId(selectedValue)}
                aria-label="board"
                options={[
                  ...choices.map((item) => ({
                    value: item.id,
                    label: item.title || 'untitled board',
                  })),
                ]}
              />
            </label>
            {boards.status === 'loading' && <p role="status">loading boards…</p>}
            {boards.error && (
              <p role="alert">
                {boards.error}{' '}
                <button type="button" onClick={() => void boards.reload()}>
                  retry boards
                </button>
              </p>
            )}
            {boards.nextCursor && (
              <button
                className="calendar-destination__more"
                type="button"
                disabled={boards.status === 'loading'}
                onClick={() => void boards.loadMore()}
              >
                more boards
              </button>
            )}
          </>
        )}
        {scope === 'board' && (
          <p className="calendar-destination__board">{board.title || 'untitled board'}</p>
        )}
        {lists.status === 'loading' && (
          <p role="status">{destinations.length ? 'loading more lists…' : 'loading lists…'}</p>
        )}
        {lists.error && (
          <p role="alert">
            {lists.error}{' '}
            <button type="button" onClick={() => void lists.reload()}>
              retry lists
            </button>
          </p>
        )}
        {destinations.length > 0 && (
          <ul aria-label="destination lists">
            {destinations.map((list) => (
              <li key={list.id}>
                <button
                  type="button"
                  disabled={!enabled || connection !== 'reachable'}
                  onClick={() => {
                    const intent = calendarCreateIntent(accountId, boardId, list, scheduledDay);
                    if (intent && enabled && connection === 'reachable') onChoose(intent);
                  }}
                >
                  <Icon name="list" size={14} />
                  <span>{list.title || 'untitled list'}</span>
                  <Icon name="right" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {lists.loaded && !destinations.length && !lists.error && (
          <p>this board has no lists. create a list in the board, then choose its day.</p>
        )}
        {lists.nextCursor && (
          <button
            className="calendar-destination__more"
            type="button"
            disabled={lists.status === 'loading'}
            onClick={() => void lists.loadMore()}
          >
            more lists
          </button>
        )}
        {!lists.coverage.complete && lists.loaded && (
          <p>list data is incomplete. refresh the account if a destination is missing.</p>
        )}
        {(!enabled || connection !== 'reachable') && (
          <p role="status">
            {connection !== 'reachable'
              ? 'the server is unavailable. your selected day stays here.'
              : 'reconnect this account before creating a task.'}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            cancel
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
