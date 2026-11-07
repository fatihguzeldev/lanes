import { useState } from 'react';
import type { Board, BoardList } from '../../contracts/board';
import { InlineField } from '../../../../shared/ui/inline-field/InlineField';
import { ColorPicker, ColorPreview } from '../../../../shared/ui/color-picker/ColorPicker';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import { Submenu } from '../../../../shared/ui/submenu/Submenu';
import type { useBoardData } from '../navigation/useBoardData';
import './ListOptions.css';

interface Props {
  list: BoardList;
  anchor: HTMLElement;
  boards: readonly Board[];
  boardPage: Pick<
    ReturnType<typeof useBoardData>['boards'],
    'nextCursor' | 'status' | 'error' | 'loadMore' | 'reload'
  >;
  lists: readonly BoardList[];
  loadedListCount: number;
  writable: boolean;
  localWritable: boolean;
  submit: (
    command: unknown,
    category?: 'local' | 'provider',
    identity?: string,
  ) => Promise<boolean>;
  guard: (action: () => void) => void;
  onColor(color: string): Promise<boolean>;
  onClose: () => void;
  onDuplicate: (list: BoardList) => void;
  onDeleteCompleted: (list: BoardList) => void;
  onDelete: (list: BoardList) => Promise<void>;
}
export function ListOptions({
  list: selectedList,
  anchor,
  boards,
  boardPage,
  lists,
  loadedListCount,
  writable,
  localWritable,
  submit,
  guard,
  onColor,
  onClose,
  onDuplicate,
  onDeleteCompleted,
  onDelete,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  return (
    <AnchoredPopover
      anchor={anchor}
      label={selectedList.title || 'list options'}
      onClose={() => onClose()}
    >
      <div className="popover__menu">
        {renaming ? (
          <div className="list-options__rename">
            <Icon name="pen" size={16} />
            <InlineField
              value={selectedList.title}
              label="list name"
              autoFocus
              maxLength={1024}
              disabled={!writable}
              onCommit={async (title) => {
                const done = await submit(
                  {
                    kind: 'list.rename',
                    listId: selectedList.id,
                    revision: selectedList.revision,
                    title,
                  },
                  'provider',
                );
                if (done) onClose();
                return done;
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="popover__item"
            disabled={!writable}
            onClick={() => setRenaming(true)}
          >
            <Icon name="pen" size={16} /> rename
          </button>
        )}
        <Submenu
          label="list color"
          disabled={!localWritable}
          trigger={
            <>
              <Icon name="palette" size={16} />
              <span>color</span>
              <span className="list-options__color-preview">
                <ColorPreview value={selectedList.color} />
              </span>
            </>
          }
          className="list-options__colors"
        >
          <ColorPicker value={selectedList.color} disabled={!localWritable} onChange={onColor} />
        </Submenu>
        <Submenu
          label="move to board"
          trigger={
            <>
              <Icon name="board" size={16} />
              <span>move to board</span>
            </>
          }
          disabled={!localWritable || selectedList.isDefault}
          className="list-options__boards"
        >
          {boards
            .filter((item) => item.accountId === selectedList.accountId)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                className="popover__item"
                aria-pressed={item.id === selectedList.boardId}
                disabled={item.id === selectedList.boardId}
                onClick={() =>
                  guard(() => {
                    void submit({
                      kind: 'list.placement',
                      listId: selectedList.id,
                      boardId: item.id,
                      revision: selectedList.membershipRevision,
                    }).then((done) => {
                      if (done) onClose();
                    });
                  })
                }
              >
                <span>{item.title || 'untitled board'}</span>
                {item.id === selectedList.boardId && <Icon name="check" size={14} />}
              </button>
            ))}
          {!!boardPage.error && (
            <button
              type="button"
              className="popover__item"
              aria-label="retry boards"
              onClick={() => void boardPage.reload()}
            >
              retry boards
            </button>
          )}
          {boardPage.nextCursor && (
            <button
              type="button"
              className="popover__item"
              aria-label="more boards"
              disabled={boardPage.status === 'loading'}
              onClick={() => void boardPage.loadMore()}
            >
              more boards <Icon name="down" size={13} />
            </button>
          )}
        </Submenu>
        <button
          type="button"
          className="popover__item"
          disabled={!localWritable || lists.findIndex((list) => list.id === selectedList.id) <= 0}
          onClick={() => {
            const list = selectedList;
            const index = lists.findIndex((item) => item.id === list.id);
            void submit({
              kind: 'list.placement',
              listId: list.id,
              boardId: list.boardId,
              revision: list.membershipRevision,
              position: index - 1,
            }).then((done) => {
              if (done) onClose();
            });
          }}
        >
          <Icon name="left" size={16} />
          move column left
        </button>
        <button
          type="button"
          className="popover__item"
          disabled={
            !localWritable ||
            lists.findIndex((list) => list.id === selectedList.id) === loadedListCount - 1
          }
          onClick={() => {
            const list = selectedList;
            const index = lists.findIndex((item) => item.id === list.id);
            void submit({
              kind: 'list.placement',
              listId: list.id,
              boardId: list.boardId,
              revision: list.membershipRevision,
              position: index + 1,
            }).then((done) => {
              if (done) onClose();
            });
          }}
        >
          <Icon name="right" size={16} />
          move column right
        </button>
        <button
          type="button"
          className="popover__item"
          disabled={!writable}
          onClick={() => {
            onDuplicate(selectedList);
            onClose();
          }}
        >
          <Icon name="copy" size={16} />
          duplicate
        </button>
        <button
          className="popover__item danger"
          onClick={() => {
            onDeleteCompleted(selectedList);
            onClose();
          }}
        >
          <Icon name="trash" size={16} />
          delete completed tasks
        </button>
        <button
          className="popover__item danger"
          disabled={!writable || selectedList.isDefault}
          onClick={() => guard(() => void onDelete(selectedList))}
        >
          <Icon name="trash" size={16} />
          delete list
        </button>
      </div>
    </AnchoredPopover>
  );
}
