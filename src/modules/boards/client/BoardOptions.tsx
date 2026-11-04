import { useState } from 'react';
import type { ConnectionSummary } from '../../accounts/contracts';
import { BoardPatchSchema, type Board } from '../contracts';
import type { BoardViewPreferences } from './view-preferences';
import { Icon } from '../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../shared/ui/popover/Popover';
import { Select } from '../../../shared/ui/select/Select';
import { newOperationId } from '../../operations/browser/submission/operation-identity';
import { useCommands } from '../../tasks/client/useCommands';
import { useServerConnection } from '../../../shared/browser/connectivity/useServerConnection';
import './BoardOptions.css';

interface Props {
  anchor: HTMLElement;
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
  onHistory: () => void;
  onCompleted: () => void;
}
export function BoardOptions({
  anchor,
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
  onHistory,
  onCompleted,
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
    <AnchoredPopover
      anchor={anchor}
      label="board options"
      onClose={onClose}
      className="board-options"
    >
      <div className="popover__menu">
        <button
          type="button"
          className="popover__item"
          disabled={commands.busy}
          onClick={onHistory}
        >
          <Icon name="history" size={15} /> history
        </button>
        <button
          type="button"
          className="popover__item"
          disabled={commands.busy}
          onClick={onCompleted}
        >
          <Icon name="check" size={15} /> completed tasks
        </button>
      </div>
      <details className="board-options__section">
        <summary>
          appearance <Icon name="down" size={13} />
        </summary>
        <form
          className="board-options__fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (!dirty || !writable || commands.busy || recorded) return;
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
          <fieldset disabled={!writable || commands.busy || recorded}>
            <label>
              name
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={256}
              />
            </label>
            <div className="board-options__pair">
              <label>
                emoji
                <input
                  value={emoji}
                  onChange={(event) => setEmoji(event.target.value)}
                  maxLength={64}
                  placeholder="🌱"
                />
              </label>
              <label>
                color
                <input
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                  spellCheck={false}
                  placeholder="#f1f0e9"
                />
              </label>
            </div>
            <label>
              background
              <Select
                value={
                  background.startsWith('/backgrounds/') ? background : background ? 'custom' : ''
                }
                onChange={(value) => setBackground(value === 'custom' ? 'https://' : value)}
                aria-label="board background"
                options={[
                  { value: '', label: 'color only' },
                  { value: '/backgrounds/lines.svg', label: 'quiet lines' },
                  { value: '/backgrounds/circles.svg', label: 'soft shapes' },
                  { value: 'custom', label: 'an image url' },
                ]}
              />
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
          {dirty && (
            <button
              type="submit"
              className="board-options__save"
              disabled={!writable || commands.busy || recorded}
            >
              {commands.busy ? 'saving…' : 'save appearance'}
            </button>
          )}
        </form>
      </details>
      <details className="board-options__section">
        <summary>
          view preferences <Icon name="down" size={13} />
        </summary>
        <div className="board-options__checks">
          <label>
            <input
              type="checkbox"
              checked={startBoardId === board.id || (board.isMain && !startBoardId)}
              onChange={(event) => onStartBoard(event.target.checked ? board.id : null)}
            />
            open this board first
          </label>
          {(['showCounts', 'showCompleted', 'showNotes'] as const).map((field) => (
            <label key={field}>
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
            </label>
          ))}
        </div>
      </details>
      <details className="board-options__section">
        <summary>
          board order <Icon name="down" size={13} />
        </summary>
        <div className="popover__menu">
          <button
            type="button"
            className="popover__item"
            disabled={!writable || commands.busy || dirty || index <= 0}
            onClick={() => reorder(index - 1)}
          >
            <Icon name="up" size={14} /> move up
          </button>
          <button
            type="button"
            className="popover__item"
            disabled={
              !writable || commands.busy || dirty || index < 0 || index === boards.length - 1
            }
            onClick={() => reorder(index + 1)}
          >
            <Icon name="down" size={14} /> move down
          </button>
        </div>
      </details>
      {(error || commands.error) && (
        <p className="board-options__error" role="alert">
          {error || commands.error}
        </p>
      )}
      {recorded && commands.latest?.state === 'failed' && commands.latest.finished && (
        <button
          type="button"
          className="popover__item"
          onClick={() => {
            setIdentity(newOperationId(clockOffset));
            commands.clearError();
          }}
        >
          start a new attempt
        </button>
      )}
      <div className="board-options__delete">
        <button
          type="button"
          className="popover__item danger"
          disabled={board.isMain || !writable || commands.busy}
          onClick={onDelete}
          title={board.isMain ? 'the main board cannot be deleted' : undefined}
        >
          <Icon name="trash" size={15} /> delete board
        </button>
      </div>
    </AnchoredPopover>
  );
}
