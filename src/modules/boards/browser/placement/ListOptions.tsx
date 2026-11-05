import type { Board, BoardList } from '../../contracts/board';
import type { Prompt } from '../../../operations/browser/submission/PromptDialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { AnchoredPopover } from '../../../../shared/ui/popover/Popover';
import { Submenu } from '../../../../shared/ui/submenu/Submenu';
import './ListOptions.css';

interface Props {
  list: BoardList;
  anchor: HTMLElement;
  boards: readonly Board[];
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
  onPrompt: (prompt: Prompt) => void;
  onClose: () => void;
  onDuplicate: (list: BoardList) => void;
  onDeleteCompleted: (list: BoardList) => void;
  onDelete: (list: BoardList) => Promise<void>;
}
export function ListOptions({
  list: selectedList,
  anchor,
  boards,
  lists,
  loadedListCount,
  writable,
  localWritable,
  submit,
  guard,
  onPrompt,
  onClose,
  onDuplicate,
  onDeleteCompleted,
  onDelete,
}: Props) {
  return (
    <AnchoredPopover
      anchor={anchor}
      label={selectedList.title || 'list options'}
      onClose={() => onClose()}
    >
      <div className="dialog__actions">
        <button
          disabled={!writable}
          onClick={() => {
            const list = selectedList;
            onClose();
            onPrompt({
              title: 'rename list',
              label: 'list name',
              initial: list.title,
              submit: (value, identity) =>
                submit(
                  {
                    kind: 'list.rename',
                    listId: list.id,
                    revision: list.revision,
                    title: value,
                  },
                  'provider',
                  identity,
                ),
            });
          }}
        >
          <Icon name="pen" size={16} />
          rename
        </button>
        <button
          disabled={!localWritable}
          onClick={() => {
            const list = selectedList;
            onClose();
            onPrompt({
              title: 'list color',
              label: 'hex color',
              initial: list.color,
              submit: (value, identity) =>
                submit(
                  {
                    kind: 'list.appearance',
                    listId: list.id,
                    revision: list.membershipRevision,
                    color: value,
                  },
                  'local',
                  identity,
                ),
            });
          }}
        >
          <Icon name="leaf" size={16} />
          color
        </button>
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
        </Submenu>
        <button
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
          move column left
        </button>
        <button
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
          move column right
        </button>
        <button
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
          className="danger"
          onClick={() => {
            onDeleteCompleted(selectedList);
            onClose();
          }}
        >
          <Icon name="trash" size={16} />
          delete completed tasks
        </button>
        <button
          className="danger"
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
