import { useState, type CSSProperties } from 'react';
import type { Board } from '../../contracts/board';
import type { BoardCommand } from '../../contracts/commands';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';
import type { BoardCreation } from '../management/useBoardCreation';
import { InlineBoardCreate } from './InlineBoardCreate';
import './BoardNavigation.css';

interface Props {
  resource: {
    items: readonly Board[];
    status: 'loading' | 'ready' | 'error';
    error: string;
    nextCursor: string | null;
    reload: () => Promise<void>;
    loadMore: () => Promise<void>;
  };
  selectedBoardId: string | null;
  writable: boolean;
  creation?: BoardCreation | undefined;
  onCreate: () => void;
  onSelect: (board: Board) => void;
  onReorder: (command: Extract<BoardCommand, { kind: 'board.reorder' }>) => void;
}
function BoardNavigationPlaceholder() {
  return (
    <button
      type="button"
      className="board-navigation__placeholder"
      disabled
      aria-hidden="true"
      tabIndex={-1}
    >
      <span className="board-navigation__symbol">
        <Skeleton className="board-navigation__placeholder-symbol" />
      </span>
      <span className="board-navigation__placeholder-name">
        <Skeleton className="board-navigation__placeholder-line" />
      </span>
    </button>
  );
}
export function BoardNavigationSkeleton() {
  return (
    <>
      <div className="board-navigation__label board-navigation__label--skeleton">
        <span>your boards</span>
        <span className="board-navigation__new-placeholder">
          <Icon name="plus" size={14} />
        </span>
      </div>
      <nav className="board-navigation__boards" aria-hidden="true">
        <BoardNavigationPlaceholder />
      </nav>
    </>
  );
}
export function BoardNavigation({
  resource,
  selectedBoardId,
  writable,
  creation,
  onCreate,
  onSelect,
  onReorder,
}: Props) {
  const [draggingBoard, setDraggingBoard] = useState<string | null>(null);
  return (
    <>
      <div className="board-navigation__label">
        <span>your boards</span>
        <button aria-label="new board" disabled={!writable} onClick={onCreate}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <nav className="board-navigation__boards" aria-label="boards">
        {creation?.open && <InlineBoardCreate controller={creation} writable={writable} />}
        {resource.items.map((item) => (
          <button
            key={item.id}
            className={selectedBoardId === item.id ? 'active' : ''}
            title={item.title || 'untitled board'}
            draggable={writable}
            onDragStart={(event) => {
              setDraggingBoard(item.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
            }}
            onDragEnd={() => setDraggingBoard(null)}
            onDragOver={(event) => {
              if (draggingBoard && draggingBoard !== item.id) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = resource.items.find((value) => value.id === draggingBoard);
              setDraggingBoard(null);
              if (!source || source.id === item.id || !writable) return;
              onReorder({
                kind: 'board.reorder',
                boardId: source.id,
                revision: source.revision,
                position: resource.items.findIndex((value) => value.id === item.id),
              });
            }}
            onClick={() => onSelect(item)}
          >
            <span
              className="board-navigation__symbol"
              style={{ '--board-color': item.color } as CSSProperties}
            >
              {item.emoji ?? <Icon name="board" size={15} />}
            </span>
            <span>{item.title || 'untitled board'}</span>
          </button>
        ))}
        {resource.status === 'loading' && !resource.items.length && (
          <div className="board-navigation__loading" role="status" aria-label="loading boards">
            {[0, 1, 2].map((key) => (
              <BoardNavigationPlaceholder key={key} />
            ))}
          </div>
        )}
        {resource.error && <button onClick={() => void resource.reload()}>retry boards</button>}
        {resource.nextCursor && (
          <button className="board-navigation__note" onClick={() => void resource.loadMore()}>
            more boards
            <Icon name="down" size={12} />
          </button>
        )}
      </nav>
    </>
  );
}
