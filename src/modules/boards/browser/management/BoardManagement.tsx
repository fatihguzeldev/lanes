import { useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Task, TaskList } from '../../../tasks/contracts/task';
import type { Board, BoardList } from '../../contracts/board';
import type { BoardViewPreferences } from '../view/view-preferences';
import type { Prompt } from '../../../operations/browser/submission/PromptDialog';
import { BoardOptions } from '../board/BoardOptions';
import { deleteBoardPrompt } from '../board/prompts';
import { useBoardCreation } from './useBoardCreation';
import { useListCreation } from './useListCreation';
import { ListOptions } from '../placement/ListOptions';
import { DuplicateDialog } from '../placement/DuplicateDialog';
import { useTaskPlacement } from '../placement/useTaskPlacement';

type Submit = (
  command: unknown,
  category?: 'local' | 'provider',
  identity?: string,
) => Promise<boolean>;
export function useBoardManagement(
  board: Board | null,
  submit: Submit,
  environment: {
    account: ConnectionSummary;
    clockOffset: number;
    onChanged(): void;
    onNotice(message: string): void;
    onInspect(id: string): void;
    onMoved?: ((taskId: string) => void) | undefined;
    onBoardDraftChange?: ((dirty: boolean) => void) | undefined;
    onListDraftChange?: ((dirty: boolean) => void) | undefined;
  },
) {
  const creation = useBoardCreation({
    accountId: environment.account.id,
    clockOffset: environment.clockOffset,
    onChanged: environment.onChanged,
    onNotice: environment.onNotice,
    onInspect: environment.onInspect,
    onDirtyChange: environment.onBoardDraftChange,
  });
  const placement = useTaskPlacement(environment);
  const listCreation = useListCreation({
    accountId: environment.account.id,
    board,
    clockOffset: environment.clockOffset,
    onChanged: environment.onChanged,
    onNotice: environment.onNotice,
    onInspect: environment.onInspect,
    onDirtyChange: environment.onListDraftChange,
  });
  const [listMenuAnchor, setListMenuAnchor] = useState<HTMLElement | null>(null);
  const [boardMenuAnchor, setBoardMenuAnchor] = useState<HTMLElement | null>(null);
  const [listMenu, setListMenu] = useState<BoardList | null>(null);
  const [boardMenu, setBoardMenu] = useState(false);
  const [copying, setCopying] = useState<
    { kind: 'list'; list: BoardList } | { kind: 'task'; task: Task; boardId: string } | null
  >(null);
  return {
    creation,
    listCreation,
    placement,
    listMenuAnchor,
    boardMenuAnchor,
    listMenu,
    boardMenu,
    copying,
    setListMenu,
    setBoardMenu,
    setCopying,
    createBoard() {
      creation.show();
    },
    createList() {
      if (board) listCreation.show(board);
    },
    openBoardMenu(anchor: HTMLElement) {
      setBoardMenuAnchor(anchor);
      setBoardMenu(true);
    },
    openListMenu(list: BoardList | null, anchor: HTMLElement) {
      setListMenuAnchor(anchor);
      setListMenu(list);
    },
    closeListMenu() {
      setListMenu(null);
    },
    duplicateTask(task: Task, boardId: string) {
      setCopying({ kind: 'task', task, boardId });
    },
    moveTask(task: Task, anchor: HTMLElement) {
      placement.open(task, anchor, board?.id ?? null);
    },
  };
}
interface Props {
  controller: ReturnType<typeof useBoardManagement>;
  account: ConnectionSummary;
  board: Board | null;
  boards: readonly Board[];
  lists: readonly BoardList[];
  clockOffset: number;
  preferences: BoardViewPreferences;
  startBoardId: string | null;
  loadedListCount: number;
  writable: boolean;
  localWritable: boolean;
  submit: Submit;
  guard(action: () => void): void;
  onPrompt(prompt: Prompt): void;
  onPreferences(patch: Partial<BoardViewPreferences>): void;
  onStartBoard(id: string | null): void;
  onChanged(): void;
  onHistory(): void;
  onCompleted(): void;
  onInspect(id: string): void;
  onRefresh(): void;
  onDeleteCompleted(list: TaskList): void;
  onDeleteList(list: TaskList): Promise<void>;
}
export function BoardManagement({
  controller,
  account,
  board,
  boards,
  lists,
  clockOffset,
  preferences,
  startBoardId,
  loadedListCount,
  writable,
  localWritable,
  submit,
  guard,
  onPrompt,
  onPreferences,
  onStartBoard,
  onChanged,
  onHistory,
  onCompleted,
  onInspect,
  onRefresh,
  onDeleteCompleted,
  onDeleteList,
}: Props) {
  const {
    listMenuAnchor,
    boardMenuAnchor,
    listMenu,
    boardMenu,
    copying,
    setListMenu,
    setBoardMenu,
    setCopying,
  } = controller;
  return (
    <>
      {copying && (
        <DuplicateDialog
          account={account}
          source={copying}
          clockOffset={clockOffset}
          onChanged={onChanged}
          onClose={() => setCopying(null)}
          onInspect={(id) => {
            setCopying(null);
            onInspect(id);
          }}
          onRefresh={onRefresh}
        />
      )}
      {boardMenu && board && boardMenuAnchor && (
        <BoardOptions
          anchor={boardMenuAnchor}
          onHistory={() => {
            setBoardMenu(false);
            onHistory();
          }}
          onCompleted={() => {
            setBoardMenu(false);
            onCompleted();
          }}
          account={account}
          board={board}
          boards={boards}
          clockOffset={clockOffset}
          preferences={preferences}
          startBoardId={startBoardId}
          onPreferences={onPreferences}
          onStartBoard={onStartBoard}
          onChanged={onChanged}
          onClose={() => setBoardMenu(false)}
          onDelete={() =>
            guard(() => {
              setBoardMenu(false);
              onPrompt(deleteBoardPrompt(board, submit));
            })
          }
        />
      )}
      {listMenu && listMenuAnchor && (
        <ListOptions
          list={listMenu}
          anchor={listMenuAnchor}
          boards={boards}
          lists={lists}
          loadedListCount={loadedListCount}
          writable={writable}
          localWritable={localWritable}
          submit={submit}
          guard={guard}
          onPrompt={onPrompt}
          onClose={() => setListMenu(null)}
          onDuplicate={(list) => setCopying({ kind: 'list', list })}
          onDeleteCompleted={onDeleteCompleted}
          onDelete={onDeleteList}
        />
      )}
    </>
  );
}
