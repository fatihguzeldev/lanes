import { WorkspaceViews } from './WorkspaceViews';
import {
  useHistoryDialog,
  HistoryDialog,
} from '../../modules/history/browser/activity/HistoryDialog';
import {
  useTransferDialog,
  TransferDialog,
} from '../../modules/transfer/browser/workspace/TransferDialog';
import {
  useTemplateDialog,
  TemplateDialog,
} from '../../modules/boards/browser/templates/TemplateDialog';
import {
  useBoardManagement,
  BoardManagement,
} from '../../modules/boards/browser/management/BoardManagement';
import {
  useChangeInspection,
  ChangeInspection,
} from '../../modules/operations/browser/status/ChangeInspection';
import type { EditorLocation } from '../../modules/tasks/browser/editor/editor-contract';
import { useTaskEditor } from '../../modules/tasks/browser/editor/useTaskEditor';
import { useTaskCreations } from '../../modules/tasks/browser/creation/useTaskCreations';
import type {
  CreationIntent,
  CreationResult,
} from '../../modules/tasks/browser/creation/creation-model';
import { useTaskChanges } from '../../modules/tasks/browser/changes/useTaskChanges';
import { TaskEditorFlow } from '../../modules/tasks/browser/editor/TaskEditorFlow';
import {
  useTaskCompletion,
  TaskCompletionDialogs,
} from '../../modules/tasks/browser/completion/TaskCompletionDialogs';
import { useTaskMenu, TaskMenu } from '../../modules/tasks/browser/actions/TaskMenu';
import { WorkspaceToolbar } from './WorkspaceToolbar';
import { WorkspaceNavigation } from './WorkspaceNavigation';
import { useInitialWorkspaceReveal } from './useInitialWorkspaceReveal';
import { readTask, readTaskList } from '../../modules/tasks/browser/queries/references';
import { readListPlacement } from '../../modules/boards/browser/placement/queries';
import { useLabels } from '../../modules/tasks/browser/labels/useLabels';
import { useUnfinishedChanges } from '../../modules/operations/browser/queries/useUnfinishedChanges';
import { useTaskActions } from '../../modules/tasks/browser/actions/useTaskActions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WorkspaceSkeleton } from './WorkspaceSkeleton';
import { Icon } from '../../shared/ui/icon/Icon';
import { Dialog } from '../../shared/ui/dialog/Dialog';
import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import { type Task, type TaskFilter, type TaskSort } from '../../modules/tasks/contracts/task';
import { checkServerConnection } from '../../shared/browser/http/http';
import { useServerConnection } from '../../shared/browser/connectivity/useServerConnection';
import {
  PromptDialog,
  type Prompt,
} from '../../modules/operations/browser/submission/PromptDialog';
import { useCommands } from '../../modules/operations/browser/submission/useCommands';
import { useWorkspaceSync } from '../../modules/tasks/browser/sync/useWorkspaceSync';
import type { SyncChanges } from '../../modules/tasks/contracts/sync';
import { Confirmation } from '../../modules/operations/browser/submission/Confirmation';
import { useConfirmationQueue } from '../../modules/operations/browser/submission/useConfirmationQueue';
import { useRecurrenceWork } from '../../modules/tasks/browser/planning/useRecurrenceWork';
import { AccountMenu } from '../../modules/accounts/browser/identity/AccountMenu';
import { ThemeToggle } from '../theme/ThemeToggle';
import { WorkspaceSettings } from './WorkspaceSettings';
import { InlineListCreate } from '../../modules/boards/browser/management/InlineListCreate';
import { TaskMovePicker } from '../../modules/boards/browser/placement/TaskMovePicker';
import { useAccountPreferences } from '../../modules/accounts/browser/preferences/AccountPreferences';
import { SyncControl } from '../../modules/tasks/browser/sync/SyncControl';
import { TaskMoveError } from '../../modules/tasks/browser/movement/save-task-move';
import { useTaskMoveQueue } from '../../modules/tasks/browser/movement/useTaskMoveQueue';
import { OperationResolutionDialog } from '../../modules/tasks/browser/operations/OperationResolutionDialog';
import { AccountLifecycleDialog } from '../../modules/accounts/browser/connections/AccountLifecycleDialog';
import { usePlanningToday } from '../../modules/tasks/browser/planning/usePlanningToday';
import { useMobileNavigation } from './useMobileNavigation';
import type { ResolvedTheme } from '../theme/theme';
import type { BoardViewPreferences } from '../../modules/boards/browser/view/view-preferences';
import { useBoardData } from '../../modules/boards/browser/navigation/useBoardData';
import { useBoardViewPreferences } from '../../modules/boards/browser/view/useBoardViewPreferences';
import './Workspace.css';
import './WorkspaceSkeleton.css';

export interface WorkspaceProps {
  active?: boolean;
  onBackgroundNotice?: (message: string, operationId?: string | null) => void;
  account: ConnectionSummary;
  accounts: readonly ConnectionSummary[];
  clockOffset: number;
  theme: ResolvedTheme;
  onTheme: (theme: ResolvedTheme) => void;
  onSelectAccount: (id: string) => void;
  onAuthorize: (purpose: 'link' | 'reconnect', accountId?: string) => void;
  onAccountsChanged: () => void;
  onSignOut: () => void;
}

export function Workspace({
  active = true,
  onBackgroundNotice,
  account,
  accounts,
  clockOffset,
  theme,
  onTheme,
  onSelectAccount,
  onAuthorize,
  onAccountsChanged,
  onSignOut,
}: WorkspaceProps) {
  const connection = useServerConnection();
  const [version, setVersion] = useState(0);
  const [topologyVersion, setTopologyVersion] = useState(0);
  const [localVersion, setLocalVersion] = useState(0);
  const [quick, setQuick] = useState<'all' | 'today' | 'starred'>('all');
  const templateDialog = useTemplateDialog();
  const templateDirty = templateDialog.dirty;
  const inspection = useChangeInspection();
  const [accountLifecycleOpen, setAccountLifecycleOpen] = useState(false);
  const transferDialog = useTransferDialog(account.id);
  const transferDirty = transferDialog.dirty;
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState<TaskSort>('manual'),
    [filter, setFilter] = useState<TaskFilter>({});
  const [searchScope, setSearchScope] = useState<'board' | 'account'>('board');
  const [navOpen, setNavOpen] = useState(false);
  const historyDialog = useHistoryDialog();
  const [boardCreationDirty, setBoardCreationDirty] = useState(false);
  const [listCreationDirty, setListCreationDirty] = useState(false);
  const closeNavigation = useCallback(() => setNavOpen(false), []);
  const navigation = useMobileNavigation(active && navOpen, closeNavigation);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [discard, setDiscard] = useState<(() => void) | null>(null),
    [notice, setNoticeText] = useState('');
  const confirmation = useConfirmationQueue();
  const [noticeOperationId, setNoticeOperationId] = useState<string | null>(null);
  const noticeAudience = useRef({ active, onBackgroundNotice });
  noticeAudience.current = { active, onBackgroundNotice };
  const setNotice = useCallback((message: string, operationId: string | null = null) => {
    setNoticeText(message);
    setNoticeOperationId(operationId);
    if (!noticeAudience.current.active)
      noticeAudience.current.onBackgroundNotice?.(message, operationId);
  }, []);
  const taskEditor = useTaskEditor(async (listId) => {
    const [list, membership] = await Promise.all([
      readTaskList(account.id, listId),
      readListPlacement(account.id, listId),
    ]);
    return { list, boardId: membership.boardId };
  }, setNotice);
  const editorDirty = taskEditor.dirty;
  const edits = useTaskChanges(account.id, version);
  const replayCreation = useRef<(task: Task, intent: CreationIntent) => Promise<CreationResult>>(
    async () => false,
  );
  const creations = useTaskCreations(account.id, version, {
    editable: account.state === 'connected' && connection === 'reachable',
    onReady: (task, intent) => replayCreation.current(task, intent),
    onChanged: () => changed(),
    onOrderRefresh: () => void sync.resume(),
    onError: setNotice,
    onInspect: inspection.inspect,
  });
  const completion = useTaskCompletion();
  const taskMenu = useTaskMenu();
  const changed = useCallback(() => {
    setVersion((value) => value + 1);
    setTopologyVersion((value) => value + 1);
    setLocalVersion((value) => value + 1);
  }, []);
  const moveQueue = useTaskMoveQueue(account.id, {
    version,
    clockOffset,
    runTask: edits.run,
    resumeOrder: () => sync.resume(),
    active,
    onRefresh: changed,
    onError: (error) => {
      setNotice(
        error instanceof Error ? error.message : 'couldn’t move this task.',
        error instanceof TaskMoveError ? (error.operationId ?? null) : null,
      );
    },
    confirmChildren: (title, count) =>
      new Promise<boolean>((resolve) => {
        confirmation.request({
          title: `move ${title || 'this task'}?`,
          message: `this moves the task and its ${count} subtasks together.`,
          confirmLabel: 'move checklist',
          onConfirm: async () => {
            resolve(true);
            return true;
          },
          onCancel: () => resolve(false),
        });
      }),
  });
  const movingTasks = moveQueue.busy;
  const commands = useCommands(account.id, clockOffset, changed);
  const repeatWork = useRecurrenceWork(
    account.id,
    active && account.state === 'connected',
    changed,
  );
  const syncChanged = useCallback(({ topology, tasks }: SyncChanges) => {
    if (topology) setTopologyVersion((value) => value + 1);
    if (tasks) setVersion((value) => value + 1);
  }, []);
  const sync = useWorkspaceSync(
    account.id,
    syncChanged,
    account.state === 'connected',
    clockOffset,
    repeatWork.run,
    active,
  );
  const boardData = useBoardData({
    accountId: account.id,
    version: topologyVersion,
    onNotice: setNotice,
  });
  const { boards, board, lists, boardId, startBoardId, failedBoardLookup } = boardData;
  const {
    preferences: viewPreferences,
    update: updateBoardView,
    returnToBoard: leaveCompleted,
  } = useBoardViewPreferences(account.id, board?.id ?? null);
  const view = viewPreferences.view;
  const setView = (next: BoardViewPreferences['view']) =>
    guard(() => updateBoardView({ view: next }));
  const visibleLists = lists.items;
  const unfinished = useUnfinishedChanges(account.id, version);
  const labels = useLabels(account.id, localVersion);
  const activeFilter = useMemo<TaskFilter>(
    () => ({
      ...filter,
      ...(quick === 'today'
        ? { scheduled: { kind: 'today' as const } }
        : quick === 'starred'
          ? { starred: true }
          : {}),
    }),
    [filter, quick],
  );
  const today = usePlanningToday(account.planningZone, clockOffset);
  const writable = account.state === 'connected' && connection === 'reachable';
  const localWritable =
    !['disconnecting', 'disconnected'].includes(account.state) && connection === 'reachable';
  const submit = async (
    command: unknown,
    category: 'local' | 'provider' = 'local',
    identity?: string,
  ) => {
    const result = await commands.submit(command, category, identity);
    if (result?.state === 'succeeded') {
      changed();
      onAccountsChanged();
      return true;
    }
    const failure = commands.getErrorDetails();
    setNotice(
      result && result.totalSteps > 1
        ? `${result.confirmedSteps} of ${result.totalSteps} changes saved. check the remaining changes.`
        : (failure?.message ?? 'this change needs attention. check its save status.'),
      result?.id ?? failure?.operationId ?? null,
    );
    return false;
  };
  const boardManagement = useBoardManagement(board, submit, {
    account,
    clockOffset,
    boards: boards.items,
    lists: visibleLists,
    version: topologyVersion,
    boardsReady: boards.status === 'ready' && boards.settled,
    listsReady: lists.status === 'ready' && lists.settled,
    onChanged: changed,
    onNotice: setNotice,
    onInspect: inspection.inspect,
    onMoveTask: (task, choice) => moveQueue.enqueuePlacement(task, choice),
    onBoardDraftChange: setBoardCreationDirty,
    onListDraftChange: setListCreationDirty,
    onMoved: (taskId) => {
      if (taskMenu.task?.id === taskId) taskMenu.close();
    },
  });
  const displayedBoard = boardManagement.appearance.board(board);
  const displayedBoards = boardManagement.appearance.orderedBoards(boards.items);
  const displayedLists = boardManagement.appearance.orderedLists(visibleLists, board?.id);
  const {
    toggleStar,
    toggleComplete,
    deleteTask,
    deleteList,
    reschedule,
    busy: quickActionsBusy,
    applyCreation,
  } = useTaskActions(
    {
      accountId: account.id,
      changes: edits,
      submit,
      confirm: confirmation.request,
      onNotice: setNotice,
      onChanged: changed,
      onRepeat: repeatWork.run,
      onReopen: completion.openReopen,
      onTaskDeleted: (task) => {
        if (taskEditor.selection?.task?.id === task.id) taskEditor.close();
        if (taskMenu.task?.id === task.id) taskMenu.close();
      },
      onListDeleteReady: boardManagement.closeListMenu,
    },
    clockOffset,
  );
  replayCreation.current = applyCreation;
  const guard = useCallback(
    (action: () => void) => {
      if (taskEditor.deferCreateExit(action)) return;
      if (taskEditor.isDirty() || templateDirty || transferDirty) setDiscard(() => action);
      else action();
    },
    [taskEditor, templateDirty, transferDirty],
  );
  const changeSearchScope = (scope: 'board' | 'account') => guard(() => setSearchScope(scope));
  const preferences = useAccountPreferences({
    account,
    clockOffset,
    onError: setNotice,
    onChanged: () => {
      changed();
      onAccountsChanged();
    },
  });
  const guardAccount = (action: () => void, leavingPage = false) => {
    if (
      leavingPage &&
      (movingTasks ||
        preferences.busy ||
        commands.isBusy() ||
        quickActionsBusy ||
        taskEditor.isSaving() ||
        boardManagement.creation.isSaving() ||
        boardManagement.listCreation.isSaving() ||
        boardManagement.appearance.isSaving() ||
        creations.busy)
    )
      setNotice('wait for your changes to finish saving before leaving this account.');
    else if (boardCreationDirty || listCreationDirty || creations.hasDrafts)
      setDiscard(() => () => {
        creations.discardDrafts();
        action();
      });
    else guard(action);
  };
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (sync.status?.initialized) onAccountsChanged();
  }, [sync.status?.initialized, onAccountsChanged]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        editorDirty ||
        creations.hasDrafts ||
        creations.busy ||
        templateDirty ||
        transferDirty ||
        boardCreationDirty ||
        listCreationDirty ||
        movingTasks ||
        preferences.busy ||
        commands.isBusy() ||
        boardManagement.creation.isSaving() ||
        boardManagement.listCreation.isSaving() ||
        boardManagement.appearance.isSaving() ||
        quickActionsBusy ||
        taskEditor.saving
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [
    editorDirty,
    creations.hasDrafts,
    creations.busy,
    templateDirty,
    transferDirty,
    boardCreationDirty,
    listCreationDirty,
    movingTasks,
    preferences.busy,
    commands.busy,
    boardManagement.creation.isSaving(),
    boardManagement.listCreation.isSaving(),
    boardManagement.appearance.pending,
    quickActionsBusy,
    taskEditor.saving,
  ]);
  const openTask = (task: Task, loaded?: EditorLocation) => {
    const list = lists.items.find((item) => item.id === task.listId);
    guard(() =>
      taskEditor.open(task, loaded ?? (list ? { list, boardId: list.boardId } : undefined)),
    );
  };

  const awaitingBoard =
    !board &&
    (boards.status === 'loading' ||
      (boardId !== null && failedBoardLookup !== boardId) ||
      (sync.busy && !sync.status?.initialized));
  const initialViewKey = JSON.stringify([
    board?.id,
    view,
    quick,
    searchScope,
    search,
    visibleLists.map((list) => list.id),
  ]);
  const { revealed, onInitialReady } = useInitialWorkspaceReveal({
    scope: initialViewKey,
    retainedWorkspace: account.state === 'connected',
    version,
    topologyReady: sync.initialTopologyReady,
    foregroundSettled: sync.initialForegroundSettled,
    metadataSettled:
      boards.settled &&
      (board
        ? lists.settled && labels.settled
        : Boolean(boards.error || failedBoardLookup) || !awaitingBoard),
    metadataFailed: Boolean(boards.error || lists.error || labels.error || failedBoardLookup),
    viewRequired: Boolean(board) && lists.status !== 'error',
  });
  const settings = {
    preferences,
    onTransfer: () =>
      guard(() => {
        setNavOpen(false);
        transferDialog.show();
      }),
    onTemplates: () =>
      guard(() => {
        setNavOpen(false);
        templateDialog.show();
      }),
  };
  const syncControl = {
    unfinished: unfinished.items,
    moreUnfinished: !!unfinished.nextCursor,
    unfinishedLoading: unfinished.status === 'loading',
    unfinishedError: unfinished.error,
    onMoreUnfinished: () => void unfinished.loadMore(),
    onRetryUnfinished: () => void unfinished.reload(),
    onInspectChange: inspection.inspect,
    onNavigate: closeNavigation,
    connected: account.state === 'connected',
    reachable: connection === 'reachable',
    busy:
      sync.busy ||
      preferences.busy ||
      commands.busy ||
      quickActionsBusy ||
      repeatWork.busy ||
      movingTasks ||
      taskEditor.saving ||
      boardManagement.creation.isSaving() ||
      boardManagement.listCreation.isSaving(),
    error: sync.error,
    status: sync.status,
    onRefresh: () =>
      void sync.refresh(
        'manual',
        lists.items.map((list) => list.id),
      ),
  };
  const noticeInspectionId = commands.error
    ? (commands.errorDetails?.operationId ?? commands.latest?.id ?? null)
    : repeatWork.error
      ? null
      : noticeOperationId;
  return (
    <div
      className={`workspace${navOpen ? ' workspace--nav-open' : ''}${!revealed ? ' workspace--loading' : ''}`}
      hidden={!active}
      inert={!active || !revealed}
      aria-busy={!revealed || undefined}
    >
      {active && !revealed && (
        <WorkspaceSkeleton
          theme={theme}
          accountInitial={Array.from(account.displayName.trim())[0] ?? '?'}
        />
      )}
      {active && (
        <>
          <WorkspaceNavigation
            navigation={navigation}
            open={navOpen}
            quick={quick}
            onQuick={(next) =>
              guard(() => {
                setQuick(next);
                updateBoardView({ view: 'board' });
                setNavOpen(false);
              })
            }
            onClose={() => setNavOpen(false)}
            utilities={
              <>
                <SyncControl {...syncControl} labelled />
                <div className="workspace__utility-pair">
                  <ThemeToggle theme={theme} onTheme={onTheme} labelled />
                  <WorkspaceSettings {...settings} labelled />
                </div>
              </>
            }
            boards={{
              resource: { ...boards, items: displayedBoards },
              selectedBoardId:
                quick === 'all' && !(searchScope === 'account' && search)
                  ? (board?.id ?? null)
                  : null,
              writable: localWritable,
              creation: boardManagement.creation,
              onCreate: boardManagement.createBoard,
              onSelect: (item) =>
                guard(() => {
                  leaveCompleted();
                  boardData.selectBoard(item);
                  setQuick('all');
                  setSearchScope('board');
                  setSearch('');
                  setQuery('');
                  setNavOpen(false);
                }),
              onReorder: (command) => {
                const source = boards.items.find((item) => item.id === command.boardId);
                if (source) boardManagement.appearance.reorderBoard(source, command.position);
              },
            }}
          />
          <main className="workspace__main" inert={navOpen || undefined}>
            {displayedBoard?.backgroundUrl && (
              <img
                key={displayedBoard.backgroundUrl}
                className="workspace__background"
                src={displayedBoard.backgroundUrl}
                alt=""
                aria-hidden="true"
                referrerPolicy="no-referrer"
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
            )}
            <WorkspaceToolbar
              navigationTrigger={navigation.trigger}
              onOpenNavigation={() => setNavOpen(true)}
              awaitingBoard={awaitingBoard}
              quick={quick}
              searchScope={searchScope}
              search={search}
              board={displayedBoard}
              onBoardOptions={(anchor) => {
                boardManagement.openBoardMenu(anchor);
              }}
              query={query}
              onQuery={setQuery}
              onScope={changeSearchScope}
              viewMenu={{
                allowLayout: quick === 'all' && !(searchScope === 'account' && search),
                view: view,
                sort: sort,
                filter: filter,
                lists: visibleLists,
                labels: labels.items,
                today: today,
                moreLists: !!lists.nextCursor,
                moreLabels: !!labels.nextCursor,
                onView: setView,
                onSort: setSort,
                onFilter: (next) => guard(() => setFilter(next)),
                onClear: () =>
                  guard(() => {
                    setFilter({});
                    setSearch('');
                    setQuery('');
                  }),
                onMoreLists: () => void lists.loadMore(),
                onMoreLabels: () => void labels.loadMore(),
              }}
              syncControl={<SyncControl {...syncControl} compact />}
              desktopControls={
                <>
                  <ThemeToggle theme={theme} onTheme={onTheme} />
                  <WorkspaceSettings {...settings} />
                </>
              }
              accountControl={
                <AccountMenu
                  account={account}
                  accounts={accounts}
                  onSelect={(id) => guardAccount(() => onSelectAccount(id))}
                  onConnect={() => guardAccount(() => onAuthorize('link'), true)}
                  onManage={() => guard(() => setAccountLifecycleOpen(true))}
                  onSignOut={() => guardAccount(onSignOut, true)}
                />
              }
            />
            {connection !== 'reachable' && (
              <div className="workspace__connection" role="status">
                <Icon name="warning" size={15} />
                <p>
                  {connection === 'incompatible'
                    ? 'this page and server do not agree. reload before making another change.'
                    : 'the server connection is paused. unsent work stays in its editor.'}
                </p>
                <button
                  onClick={() => {
                    if (connection === 'incompatible') window.location.reload();
                    else
                      void checkServerConnection().catch((error) =>
                        setNotice(
                          error instanceof Error
                            ? error.message
                            : 'the server is still unavailable.',
                        ),
                      );
                  }}
                >
                  {connection === 'incompatible' ? 'reload lanes' : 'check connection'}
                </button>
              </div>
            )}
            {account.state !== 'connected' && (
              <div className="workspace__connection" role="status">
                <Icon name={account.state === 'connecting' ? 'sync' : 'warning'} size={15} />
                <p>
                  {account.state === 'connecting'
                    ? 'bringing your google lists and tasks into lanes…'
                    : account.state === 'reconnect_required'
                      ? 'this google connection has expired. your workspace is retained.'
                      : `google connection: ${account.state.replaceAll('_', ' ')}.`}
                </p>
                {account.state === 'reconnect_required' && (
                  <button
                    onClick={() => guardAccount(() => onAuthorize('reconnect', account.id), true)}
                  >
                    reconnect
                  </button>
                )}
              </div>
            )}
            {(commands.error || repeatWork.error || notice) && (
              <div className="workspace__notice" role={commands.error ? 'alert' : 'status'}>
                <span>{commands.error || repeatWork.error || notice}</span>
                {noticeInspectionId && (
                  <button onClick={() => inspection.inspect(noticeInspectionId)}>check save</button>
                )}
                <button
                  aria-label="dismiss message"
                  onClick={() => {
                    commands.clearError();
                    repeatWork.clearError();
                    setNotice('');
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
            <WorkspaceViews
              account={account}
              board={displayedBoard}
              boardId={boardId}
              boardsError={boards.error}
              failedBoardLookup={failedBoardLookup}
              awaitingBoard={awaitingBoard}
              lists={lists}
              visibleLists={displayedLists}
              labels={labels.items}
              today={today}
              viewPreferences={viewPreferences}
              quick={quick}
              searchScope={searchScope}
              search={search}
              filter={filter}
              activeFilter={activeFilter}
              sort={sort}
              version={version}
              clockOffset={clockOffset}
              writable={writable}
              localWritable={localWritable}
              pendingTaskIds={commands.pendingTaskIds}
              moveQueue={moveQueue}
              creations={creations.items.filter(
                (item) =>
                  item.id !== taskEditor.session?.id &&
                  item.id !== taskEditor.session?.selection.pendingCreationId,
              )}
              onCreationRead={creations.acknowledge}
              edits={edits.items}
              onEditRead={edits.remove}
              listCreationOpen={
                boardManagement.listCreation.open &&
                boardManagement.listCreation.boardId === board?.id
              }
              listCreation={
                (boardManagement.listCreation.open &&
                  boardManagement.listCreation.boardId === board?.id) ||
                boardManagement.listCreation.previews.some((item) => item.boardId === board?.id) ? (
                  <InlineListCreate controller={boardManagement.listCreation} writable={writable} />
                ) : null
              }
              onInitialReady={onInitialReady}
              actions={{
                onChanged: changed,
                onSearchScope: changeSearchScope,
                onReturnToBoard: () =>
                  guard(() => {
                    leaveCompleted();
                    setQuick('all');
                    setSearchScope('board');
                  }),
                onClearCompletedFilters: () =>
                  guard(() => {
                    setFilter({});
                    setSearch('');
                    setQuery('');
                  }),
                onAddList: boardManagement.createList,
                onAddTask: (list) => {
                  if (list.accountId !== account.id) return;
                  guard(() =>
                    taskEditor.createInline({ list, ...(board ? { boardId: board.id } : {}) }),
                  );
                },
                onOpenTask: openTask,
                onToggleComplete: toggleComplete,
                onToggleStar: toggleStar,
                onTaskMenu: taskMenu.open,
                onListMenu: boardManagement.openListMenu,
                onOpenBoard: (id) =>
                  guard(() => {
                    leaveCompleted();
                    boardData.selectBoardId(id);
                    setQuick('all');
                    setSearchScope('board');
                    setSearch('');
                    setQuery('');
                  }),
                onCreateTask: (intent) => {
                  if (intent.accountId !== account.id) return;
                  guard(() => {
                    const list = lists.items.find((list) => list.id === intent.listId);
                    taskEditor.create(
                      intent.listId,
                      intent.scheduledDay,
                      list ? { list, boardId: list.boardId } : undefined,
                    );
                  });
                },
                onReschedule: (intent, task) => reschedule(intent, task),
              }}
            />
          </main>
        </>
      )}
      <TaskEditorFlow
        active={active}
        controller={taskEditor}
        creations={creations}
        edits={edits}
        onNotice={setNotice}
        account={account}
        boardId={board?.id ?? null}
        labels={labels.items}
        labelPage={labels}
        version={version}
        clockOffset={clockOffset}
        guard={guard}
        onChanged={changed}
        onAccountsChanged={onAccountsChanged}
        onInspect={inspection.inspect}
        onOpenTask={openTask}
        onToggleComplete={toggleComplete}
        onDelete={(task) => void deleteTask(task)}
      />
      {active && (
        <TaskCompletionDialogs
          controller={completion}
          account={account}
          clockOffset={clockOffset}
          onChanged={changed}
          onRepeat={repeatWork.run}
          onInspect={inspection.inspect}
        />
      )}
      <TransferDialog
        active={active}
        controller={transferDialog}
        account={account}
        accounts={accounts}
        clockOffset={clockOffset}
        version={version}
        guard={guard}
        onChanged={changed}
        onInspect={inspection.inspect}
        onOpenTask={openTask}
        onNotice={setNotice}
      />
      <TemplateDialog
        active={active}
        onNotice={setNotice}
        controller={templateDialog}
        account={account}
        clockOffset={clockOffset}
        version={version}
        guard={guard}
        onChanged={changed}
        onInspect={inspection.inspect}
        onRefreshInventory={() =>
          void sync.refresh(
            'manual',
            lists.items.map((list) => list.id),
          )
        }
      />
      {active && confirmation.current && (
        <Confirmation
          key={confirmation.current.id}
          choice={confirmation.current.choice}
          clockOffset={clockOffset}
          onError={setNotice}
          onClose={() => confirmation.close(confirmation.current!.id)}
        />
      )}
      {active && (
        <BoardManagement
          controller={boardManagement}
          account={account}
          board={displayedBoard}
          boards={displayedBoards}
          boardPage={boards}
          lists={displayedLists}
          clockOffset={clockOffset}
          preferences={viewPreferences}
          startBoardId={startBoardId}
          loadedListCount={displayedLists.length}
          writable={writable}
          localWritable={localWritable}
          busy={commands.busy}
          submit={submit}
          guard={guard}
          onPrompt={setPrompt}
          onPreferences={updateBoardView}
          onStartBoard={boardData.setStartBoard}
          onChanged={changed}
          onHistory={() => {
            historyDialog.open();
          }}
          onCompleted={() =>
            guard(() => {
              setQuick('all');
              setSearchScope('board');
              updateBoardView({ view: 'completed' });
            })
          }
          onInspect={inspection.inspect}
          onRefresh={() =>
            void sync.refresh(
              'manual',
              lists.items.map((list) => list.id),
            )
          }
          onDeleteCompleted={completion.openDeletion}
          onDeleteList={deleteList}
        />
      )}
      {active && (
        <>
          <HistoryDialog
            controller={historyDialog}
            clockOffset={clockOffset}
            account={account}
            board={board}
            lists={lists.items}
            version={version}
            onOpenTask={openTask}
            onNotice={setNotice}
          />
          {prompt && (
            <PromptDialog
              onError={setNotice}
              key={prompt.title + prompt.initial}
              clockOffset={clockOffset}
              prompt={prompt}
              onClose={() => setPrompt(null)}
            />
          )}
          {discard && (
            <Dialog title="leave this draft?" onClose={() => setDiscard(null)}>
              <div className="dialog__body">
                <p>your unsent changes will be discarded. changes already sent will keep saving.</p>
                <footer>
                  <button onClick={() => setDiscard(null)}>keep editing</button>
                  <button
                    className="primary"
                    onClick={() => {
                      const next = discard;
                      setDiscard(null);
                      if (!boardManagement.creation.isSaving()) boardManagement.creation.discard();
                      if (!boardManagement.listCreation.isSaving()) {
                        boardManagement.listCreation.discard();
                        setListCreationDirty(false);
                      }
                      templateDialog.setDirty(false);
                      transferDialog.setDirty(false);
                      taskEditor.close();
                      next();
                    }}
                  >
                    discard draft
                  </button>
                </footer>
              </div>
            </Dialog>
          )}
          <TaskMenu
            controller={taskMenu}
            writable={writable}
            localWritable={localWritable}
            onToggleStar={toggleStar}
            onHistory={(task) => {
              historyDialog.open(task);
            }}
            onOpen={openTask}
            onDuplicate={(task) => boardManagement.duplicateTask(task, board?.id ?? '')}
            onMove={(task, anchor) => boardManagement.moveTask(task, anchor)}
            moveOpen={Boolean(
              boardManagement.placement.selection &&
              boardManagement.placement.selection.task.id === taskMenu.task?.id,
            )}
            moveMenu={
              boardManagement.placement.selection ? (
                <TaskMovePicker
                  controller={boardManagement.placement}
                  workspace={boardData}
                  embedded
                />
              ) : null
            }
            onMoveClose={boardManagement.placement.close}
            onDelete={(task) => void deleteTask(task)}
          />
          {accountLifecycleOpen && (
            <AccountLifecycleDialog
              account={account}
              onClose={() => setAccountLifecycleOpen(false)}
              onChanged={() => {
                changed();
                onAccountsChanged();
                if (typeof BroadcastChannel !== 'undefined') {
                  const channel = new BroadcastChannel('lanes.session');
                  channel.postMessage({ type: 'account-changed' });
                  channel.close();
                }
              }}
            />
          )}
          <ChangeInspection
            controller={inspection}
            account={account}
            version={version}
            clockOffset={clockOffset}
            onChanged={changed}
            onOpenTask={(id) =>
              void readTask(account.id, id)
                .then((task) => {
                  inspection.close();
                  openTask(task);
                })
                .catch((error) =>
                  setNotice(
                    error instanceof Error
                      ? error.message
                      : 'this task is no longer available. its history is retained.',
                  ),
                )
            }
            onOpenList={(id) =>
              void readListPlacement(account.id, id)
                .then((placement) =>
                  guard(() => {
                    leaveCompleted();
                    boardData.selectBoardId(placement.boardId);
                    setQuick('all');
                    inspection.close();
                  }),
                )
                .catch((error) =>
                  setNotice(
                    error instanceof Error ? error.message : 'this list is no longer available.',
                  ),
                )
            }
          />
          {inspection.resolutionId && (
            <OperationResolutionDialog
              account={account}
              operationId={inspection.resolutionId}
              onClose={() => inspection.closeResolution()}
              onResolved={() => {
                const id = inspection.resolutionId;
                inspection.closeResolution();
                changed();
                if (id) void commands.advance(id);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
