import { useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import { BoardPatchSchema, type Board } from '../modules/boards/contracts';
import type { BoardViewPreferences } from '../modules/boards/view-preferences';
import { Dialog } from '../ui/Dialog';
import { newOperationId, useCommands } from './useCommands';
import { useServerConnection } from './useServerConnection';
interface Props {
  account: ConnectionSummary;
  board: Board;
  boards: readonly Board[];
  clockOffset: number;
  preferences: BoardViewPreferences;
  startBoardId: string | null;
  onPreferences: (patch: Partial<BoardViewPreferences>) => void;
  onStartBoard: (id: string | null) => void;
  onChanged: () => void;
  onClose: () => void;
  onDelete: () => void;
}
export function BoardOptions({
  account,
  board,
  boards,
  clockOffset,
  preferences,
  startBoardId,
  onPreferences,
  onStartBoard,
  onChanged,
  onClose,
  onDelete,
}: Props) {
  const [title, setTitle] = useState(board.title),
    [emoji, setEmoji] = useState(board.emoji ?? ''),
    [color, setColor] = useState(board.color);
  const [background, setBackground] = useState(board.backgroundUrl ?? ''),
    [error, setError] = useState('');
  const [identity, setIdentity] = useState(() => newOperationId(clockOffset));
  const commands = useCommands(account.id, clockOffset, onChanged),
    connection = useServerConnection();
  const writable =
    connection === 'reachable' && !['disconnecting', 'disconnected'].includes(account.state);
  const recorded = commands.latest?.id === identity,
    index = boards.findIndex((item) => item.id === board.id);
  const dirty =
    title !== board.title ||
    emoji !== (board.emoji ?? '') ||
    color !== board.color ||
    background !== (board.backgroundUrl ?? '');
  const reorder = (position: number) =>
    void commands
      .submit(
        { kind: 'board.reorder', boardId: board.id, revision: board.revision, position },
        'local',
      )
      .then((result) => {
        if (result?.state === 'succeeded') onClose();
      });
  return (
    <Dialog title="board settings" onClose={onClose} pending={commands.busy}>
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || !writable || recorded) return;
          const parsed = BoardPatchSchema.safeParse({
            ...(title !== board.title ? { title } : {}),
            ...(emoji !== (board.emoji ?? '') ? { emoji: emoji || null } : {}),
            ...(color !== board.color ? { color } : {}),
            ...(background !== (board.backgroundUrl ?? '')
              ? { backgroundUrl: background || null }
              : {}),
          });
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'check these board settings.');
            return;
          }
          setError('');
          void commands
            .submit(
              {
                kind: 'board.update',
                boardId: board.id,
                revision: board.revision,
                input: parsed.data,
              },
              'local',
              identity,
            )
            .then((result) => {
              if (result?.state === 'succeeded') onClose();
            });
        }}
      >
        <fieldset disabled={!writable || commands.busy || recorded} style={{ display: 'contents' }}>
          <label>
            name
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={256}
            />
          </label>
          <label>
            emoji <span>optional</span>
            <input
              value={emoji}
              onChange={(event) => setEmoji(event.target.value)}
              maxLength={64}
              placeholder="🌱"
            />
          </label>
          <label>
            board color
            <input
              value={color}
              onChange={(event) => setColor(event.target.value)}
              spellCheck={false}
              placeholder="#f1f0e9"
            />
          </label>
          <label>
            background
            <select
              value={
                background.startsWith('/backgrounds/') ? background : background ? 'custom' : ''
              }
              onChange={(event) =>
                setBackground(event.target.value === 'custom' ? 'https://' : event.target.value)
              }
            >
              <option value="">color only</option>
              <option value="/backgrounds/lines.svg">quiet lines</option>
              <option value="/backgrounds/circles.svg">soft shapes</option>
              <option value="custom">an image url</option>
            </select>
          </label>
          {!!background && !background.startsWith('/backgrounds/') && (
            <label>
              https image url
              <input
                type="url"
                value={background}
                onChange={(event) => setBackground(event.target.value)}
                maxLength={4096}
              />
              <small>your browser contacts this image host when opening the board.</small>
            </label>
          )}
        </fieldset>
        <fieldset className="board-options__preferences">
          <legend>in this browser</legend>
          <label>
            <span>
              <input
                type="checkbox"
                checked={startBoardId === board.id || (board.isMain && !startBoardId)}
                onChange={(event) => onStartBoard(event.target.checked ? board.id : null)}
              />{' '}
              open this board first
            </span>
          </label>
          {(['showCounts', 'showCompleted', 'showNotes'] as const).map((field) => (
            <label key={field}>
              <span>
                <input
                  type="checkbox"
                  checked={preferences[field]}
                  onChange={(event) => onPreferences({ [field]: event.target.checked })}
                />
                {field === 'showCounts'
                  ? 'show task counts'
                  : field === 'showCompleted'
                    ? 'show completed sections'
                    : 'show note excerpts'}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="board-options__order">
          <button
            type="button"
            disabled={!writable || commands.busy || dirty || index <= 0}
            onClick={() => reorder(index - 1)}
          >
            move earlier
          </button>
          <button
            type="button"
            disabled={
              !writable || commands.busy || dirty || index < 0 || index === boards.length - 1
            }
            onClick={() => reorder(index + 1)}
          >
            move later
          </button>
        </div>
        {(error || commands.error) && (
          <p className="error" role="alert">
            {error || commands.error}
          </p>
        )}
        {recorded && commands.latest?.state === 'failed' && commands.latest.finished && (
          <button
            type="button"
            onClick={() => {
              setIdentity(newOperationId(clockOffset));
              commands.clearError();
            }}
          >
            start a new attempt
          </button>
        )}
        <footer>
          <button
            type="button"
            className="danger"
            disabled={board.isMain || !writable || commands.busy}
            onClick={onDelete}
          >
            delete board{board.isMain ? ' · main board stays' : ''}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!dirty || !writable || commands.busy || recorded}
          >
            {commands.busy ? 'saving…' : 'save'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
