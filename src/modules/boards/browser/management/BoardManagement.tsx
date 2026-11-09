import { useState, type ComponentProps } from 'react';
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
import type { PlacementChoice } from '../placement/placement-model';
import { useBoardAppearance } from '../appearance/useBoardAppearance';

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
    version: number;
    boardsReady: boolean;
    listsReady: boolean;
    boards: readonly Board[];
    lists: readonly BoardList[];
    onMoveTask(task: Task, choice: PlacementChoice): boolean;
    onChanged(): void;
    onNotice(message: string): void;
    onInspect(id: string): void;
    onMoved?: ((taskId: string) => void) | undefined;
    onBoardDraftChange?: ((dirty: boolean) => void) | undefined;
    onListDraftChange?: ((dirty: boolean) => void) | undefined;
  },
) {
  const appearance = useBoardAppearance({
    accountId: environment.account.id,
    board,
    boards: environment.boards,
    lists: environment.lists,
    submit,
    onNotice: environment.onNotice,
  });
  const creation = useBoardCreation({
    accountId: environment.account.id,
    clockOffset: environment.clockOffset,
    version: environment.version,
    inventoryReady: environment.boardsReady,
    observedIds: environment.boards.map((board) => board.id),
    knownBoards: [...environment.boards, ...(board ? [board] : [])],
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
    version: environment.version,
    inventoryReady: environment.listsReady,
    observedIds: environment.lists.map((list) => list.id),
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
    appearance: {
      ...appearance,
      orderedBoards(values: readonly Board[]) {
        const known = new Map(values.map((value) => [value.id, value]));
        creation.resources.forEach((value) => {
          if (!known.has(value.id)) known.set(value.id, value);
        });
        return appearance.orderedBoards([...known.values()]);
      },
      orderedLists(values: readonly BoardList[], boardId = board?.id) {
        const known = new Map(values.map((value) => [value.id, value]));
        listCreation.resources.forEach((value) => {
          if (!known.has(value.id)) known.set(value.id, value);
        });
        return appearance.orderedLists([...known.values()], boardId);
      },
    },
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
  boardPage: ComponentProps<typeof ListOptions>['boardPage'];
  lists: readonly BoardList[];
  clockOffset: number;
  preferences: BoardViewPreferences;
  startBoardId: string | null;
  loadedListCount: number;
  writable: boolean;
  localWritable: boolean;
  busy: boolean;
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
  boardPage,
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
          board={board}
          boards={boards}
          preferences={preferences}
          startBoardId={startBoardId}
          onPreferences={onPreferences}
          onStartBoard={onStartBoard}
          writable={localWritable}
          pending={controller.appearance.pendingForBoard(board.id)}
          onReorder={(position) => controller.appearance.reorderBoard(board, position)}
          onChange={(patch) => controller.appearance.updateBoard(board, patch)}
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
          list={lists.find((list) => list.id === listMenu.id) ?? listMenu}
          anchor={listMenuAnchor}
          boards={boards}
          boardPage={boardPage}
          lists={lists}
          loadedListCount={loadedListCount}
          writable={writable}
          localWritable={localWritable}
          onPlacement={(boardId, position) =>
            controller.appearance.placeList(
              lists.find((list) => list.id === listMenu.id) ?? listMenu,
              boardId,
              position,
            )
          }
          guard={guard}
          onColor={(color) =>
            controller.appearance.updateListColor(
              lists.find((list) => list.id === listMenu.id) ?? listMenu,
              color,
            )
          }
          onRename={(title) =>
            controller.appearance.updateListTitle(
              lists.find((list) => list.id === listMenu.id) ?? listMenu,
              title,
            )
          }
          onClose={() => setListMenu(null)}
          onDuplicate={(list) => setCopying({ kind: 'list', list })}
          onDeleteCompleted={onDeleteCompleted}
          onDelete={onDeleteList}
        />
      )}
    </>
  );
}
