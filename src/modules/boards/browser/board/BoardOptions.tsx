import type { Board, BoardPatch } from '../../contracts/board';
import type { BoardViewPreferences } from '../view/view-preferences';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import { BoardAppearance } from '../appearance/BoardAppearance';
import './BoardOptions.css';

interface Props {
  anchor: HTMLElement;
  board: Board;
  boards: readonly Board[];
  preferences: BoardViewPreferences;
  startBoardId: string | null;
  onPreferences: (patch: Partial<BoardViewPreferences>) => void;
  onStartBoard: (id: string | null) => void;
  writable: boolean;
  pending: boolean;
  onChange(input: BoardPatch): Promise<boolean>;
  submit(command: unknown, category: 'local'): Promise<boolean>;
  onClose: () => void;
  onDelete: () => void;
  onHistory: () => void;
  onCompleted: () => void;
}
export function BoardOptions({
  anchor,
  board,
  boards,
  preferences,
  startBoardId,
  onPreferences,
  onStartBoard,
  writable,
  pending,
  onChange,
  submit,
  onClose,
  onDelete,
  onHistory,
  onCompleted,
}: Props) {
  const index = boards.findIndex((item) => item.id === board.id);
  const reorder = async (position: number) => {
    if (
      await submit(
        { kind: 'board.reorder', boardId: board.id, revision: board.revision, position },
        'local',
      )
    )
      onClose();
  };

  return (
    <AnchoredPopover
      anchor={anchor}
      label="board options"
      onClose={onClose}
      className="board-options"
    >
      <div className="popover__menu">
        <button type="button" className="popover__item" onClick={onHistory}>
          <Icon name="history" size={15} /> history
        </button>
      </div>
      <div className="popover__menu board-options__section">
        <button type="button" className="popover__item" onClick={onCompleted}>
          <Icon name="list-check" size={15} /> completed tasks
        </button>
      </div>
      <details className="board-options__section">
        <summary>
          <Icon name="palette" size={15} /> appearance
          <Icon name="down" size={13} className="board-options__chevron" />
        </summary>
        <BoardAppearance board={board} disabled={!writable} onChange={onChange} />
      </details>
      <details className="board-options__section">
        <summary>
          <Icon name="sliders" size={15} /> view preferences
          <Icon name="down" size={13} className="board-options__chevron" />
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
          <Icon name="sort" size={15} /> board order
          <Icon name="down" size={13} className="board-options__chevron" />
        </summary>
        <div className="popover__menu">
          <button
            type="button"
            className="popover__item"
            disabled={!writable || pending || index <= 0}
            onClick={() => reorder(index - 1)}
          >
            <Icon name="up" size={14} /> move up
          </button>
          <button
            type="button"
            className="popover__item"
            disabled={!writable || pending || index < 0 || index === boards.length - 1}
            onClick={() => reorder(index + 1)}
          >
            <Icon name="down" size={14} /> move down
          </button>
        </div>
      </details>
      <div className="board-options__delete">
        <button
          type="button"
          className="popover__item danger"
          disabled={board.isMain || !writable || pending}
          onClick={onDelete}
          title={board.isMain ? 'the main board cannot be deleted' : undefined}
        >
          <Icon name="trash" size={15} /> delete board
        </button>
      </div>
    </AnchoredPopover>
  );
}
