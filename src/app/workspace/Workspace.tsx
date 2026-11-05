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
import { useTaskEditor } from '../../modules/tasks/browser/editor/useTaskEditor';
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
import { createTaskActions } from '../../modules/tasks/browser/actions/task-actions';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WorkspaceSkeleton } from './WorkspaceSkeleton';
import { Icon } from '../../shared/ui/icon/Icon';
import { Dialog } from '../../shared/ui/dialog/Dialog';
import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import { type Board, type BoardList } from '../../modules/boards/contracts/board';
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
import {
  Confirmation,
  type ConfirmationChoice,
} from '../../modules/operations/browser/submission/Confirmation';
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
  const [inlineDirty, setInlineDirty] = useState(false);
  const [boardCreationDirty, setBoardCreationDirty] = useState(false);
  const [listCreationDirty, setListCreationDirty] = useState(false);
  const [draftContext, setDraftContext] = useState<{ board: Board; lists: BoardList[] } | null>(
    null,
  );
  const [resetInlineDrafts, setResetInlineDrafts] = useState(0);
  const closeNavigation = useCallback(() => setNavOpen(false), []);
  const navigation = useMobileNavigation(navOpen, closeNavigation);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [discard, setDiscard] = useState<(() => void) | null>(null),
    [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationChoice | null>(null);
  const [moveErrorId, setMoveErrorId] = useState<string | null>(null);
  const taskEditor = useTaskEditor(async (listId) => {
    const [list, membership] = await Promise.all([
      readTaskList(account.id, listId),
      readListPlacement(account.id, listId),
    ]);
    return { list, boardId: membership.boardId };
  }, setNotice);
  const editorDirty = taskEditor.dirty;
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
    onRefresh: changed,
    onError: (error) => {
      setNotice(error instanceof Error ? error.message : 'couldn’t move this task.');
      setMoveErrorId(error instanceof TaskMoveError ? (error.operationId ?? null) : null);
    },
    confirmChildren: (title, count) =>
      new Promise<boolean>((resolve) => {
        setConfirmation({
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
  const repeatWork = useRecurrenceWork(account.id, account.state === 'connected', changed);
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
  );
  const boardData = useBoardData({
    accountId: account.id,
    version: topologyVersion,
    retainedBoard: draftContext?.board ?? null,
    onNotice: setNotice,
  });
  const { boards, board, lists, boardId, startBoardId, failedBoardLookup } = boardData;
  const { preferences: viewPreferences, update: updateBoardView } = useBoardViewPreferences(
    account.id,
    board?.id ?? null,
  );
  const view = viewPreferences.view;
  const setView = (next: BoardViewPreferences['view']) =>
    guard(() => updateBoardView({ view: next }));
  const visibleLists =
    inlineDirty && draftContext && draftContext.board.id === board?.id
      ? [
          ...draftContext.lists.map(
            (saved) => lists.items.find((item) => item.id === saved.id) ?? saved,
          ),
          ...lists.items.filter(
            (item) => !draftContext.lists.some((saved) => saved.id === item.id),
          ),
        ]
      : lists.items;
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
    if (result)
      setNotice(
        result.totalSteps > 1
          ? `${result.confirmedSteps} of ${result.totalSteps} changes saved. check the remaining changes.`
          : 'this change needs attention. check its save status.',
      );
    return false;
  };
  const boardManagement = useBoardManagement(board, submit, {
    account,
    clockOffset,
    onChanged: changed,
    onNotice: setNotice,
    onInspect: inspection.inspect,
    onBoardDraftChange: setBoardCreationDirty,
    onListDraftChange: setListCreationDirty,
  });
  const guard = useCallback(
    (action: () => void) => {
      if (editorDirty || templateDirty || transferDirty || inlineDirty) setDiscard(() => action);
      else action();
    },
    [editorDirty, templateDirty, transferDirty, inlineDirty],
  );
  const guardAccount = (action: () => void) => {
    if (
      movingTasks ||
      boardManagement.placement.busy ||
      boardManagement.creation.isSaving() ||
      boardManagement.listCreation.isSaving()
    )
      setNotice('wait for your changes to finish saving before leaving this account.');
    else if (boardCreationDirty || listCreationDirty) setDiscard(() => action);
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
        templateDirty ||
        transferDirty ||
        inlineDirty ||
        boardCreationDirty ||
        listCreationDirty ||
        movingTasks ||
        boardManagement.placement.busy
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [
    editorDirty,
    templateDirty,
    transferDirty,
    inlineDirty,
    boardCreationDirty,
    listCreationDirty,
    movingTasks,
    boardManagement.placement.busy,
  ]);
  const openTask = (task: Task) => {
    const list = lists.items.find((item) => item.id === task.listId);
    guard(() => taskEditor.open(task, list ? { list, boardId: list.boardId } : undefined));
  };
  const { toggleComplete, deleteTask, deleteList, reschedule } = createTaskActions({
    accountId: account.id,
    submit,
    confirm: setConfirmation,
    onNotice: setNotice,
    onChanged: changed,
    onRepeat: repeatWork.run,
    onReopen: completion.openReopen,
    onTaskDeleted: () => {
      taskEditor.close();
      taskMenu.close();
    },
    onListDeleteReady: boardManagement.closeListMenu,
  });

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
  const preferences = useAccountPreferences({
    account,
    clockOffset,
    onChanged: () => {
      changed();
      onAccountsChanged();
    },
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
      commands.busy ||
      repeatWork.busy ||
      movingTasks ||
      boardManagement.placement.busy ||
      boardManagement.creation.busy ||
      boardManagement.listCreation.busy,
    error: sync.error,
    status: sync.status,
    onRefresh: () =>
      void sync.refresh(
        'manual',
        lists.items.map((list) => list.id),
      ),
  };
  return (
    <div
      className={`workspace${navOpen ? ' workspace--nav-open' : ''}${!revealed ? ' workspace--loading' : ''}`}
      inert={!revealed}
      aria-busy={!revealed || undefined}
    >
      {!revealed && (
        <WorkspaceSkeleton
          theme={theme}
          accountInitial={Array.from(account.displayName.trim())[0] ?? '?'}
        />
      )}
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
          resource: boards,
          selectedBoardId:
            quick === 'all' && !(searchScope === 'account' && search) ? (board?.id ?? null) : null,
          writable: localWritable,
          creation: boardManagement.creation,
          onCreate: boardManagement.createBoard,
          onSelect: (item) =>
            guard(() => {
              boardData.selectBoard(item);
              setQuick('all');
              setSearchScope('board');
              setSearch('');
              setQuery('');
              setNavOpen(false);
            }),
          onReorder: (command) => {
            void submit(command, 'local');
          },
        }}
      />
      <main className="workspace__main" inert={navOpen || undefined}>
        {board?.backgroundUrl && (
          <img
            key={board.backgroundUrl}
            className="workspace__background"
            src={board.backgroundUrl}
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
          board={board}
          onBoardOptions={(anchor) => {
            boardManagement.openBoardMenu(anchor);
          }}
          query={query}
          onQuery={(value) => {
            if (inlineDirty && searchScope === 'account') guard(() => setQuery(value));
            else setQuery(value);
          }}
          onScope={(value) => guard(() => setSearchScope(value))}
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
              onConnect={() => guardAccount(() => onAuthorize('link'))}
              onManage={() => guard(() => setAccountLifecycleOpen(true))}
              onSignOut={() => guardAccount(onSignOut)}
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
                      error instanceof Error ? error.message : 'the server is still unavailable.',
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
              <button onClick={() => onAuthorize('reconnect', account.id)}>reconnect</button>
            )}
          </div>
        )}
        {(commands.error || repeatWork.error || notice) && (
          <div className="workspace__notice" role={commands.error ? 'alert' : 'status'}>
            <span>{commands.error || repeatWork.error || notice}</span>
            {(((commands.errorDetails?.operationId || commands.latest?.id) && commands.error) ||
              moveErrorId) && (
              <button
                onClick={() => {
                  inspection.inspect(
                    moveErrorId ??
                      commands.errorDetails?.operationId ??
                      commands.latest?.id ??
                      null,
                  );
                }}
              >
                check save
              </button>
            )}
            <button
              aria-label="dismiss message"
              onClick={() => {
                commands.clearError();
                setNotice('');
                setMoveErrorId(null);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <WorkspaceViews
          account={account}
          board={board}
          boardId={boardId}
          boardsError={boards.error}
          failedBoardLookup={failedBoardLookup}
          awaitingBoard={awaitingBoard}
          lists={lists}
          visibleLists={visibleLists}
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
          pendingTaskIds={commands.pendingTaskIds}
          moveQueue={moveQueue}
          resetInlineDrafts={resetInlineDrafts}
          listCreation={
            boardManagement.listCreation.open &&
            boardManagement.listCreation.boardId === board?.id ? (
              <InlineListCreate controller={boardManagement.listCreation} writable={writable} />
            ) : null
          }
          onInitialReady={onInitialReady}
          actions={{
            onChanged: changed,
            onAddList: boardManagement.createList,
            onInspect: inspection.inspect,
            onDraftChange: (dirty) => {
              if (dirty && board) setDraftContext({ board, lists: visibleLists });
              if (!dirty) setDraftContext(null);
              setInlineDirty(dirty);
            },
            onOpenTask: openTask,
            onToggleComplete: (task, completed) => void toggleComplete(task, completed),
            onTaskMenu: taskMenu.open,
            onListMenu: boardManagement.openListMenu,
            onOpenBoard: (id) =>
              guard(() => {
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
            onReschedule: (intent) => void reschedule(intent),
          }}
        />
      </main>
      <TaskEditorFlow
        controller={taskEditor}
        account={account}
        boardId={board?.id ?? null}
        labels={labels.items}
        version={version}
        clockOffset={clockOffset}
        guard={guard}
        onChanged={changed}
        onAccountsChanged={onAccountsChanged}
        onInspect={inspection.inspect}
        onOpenTask={openTask}
        onToggleComplete={(task, completed) => void toggleComplete(task, completed)}
        onDelete={(task) => void deleteTask(task)}
      />
      <TaskCompletionDialogs
        controller={completion}
        account={account}
        clockOffset={clockOffset}
        onChanged={changed}
        onRepeat={repeatWork.run}
        onInspect={inspection.inspect}
      />
      <TransferDialog
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
      {confirmation && (
        <Confirmation
          choice={confirmation}
          clockOffset={clockOffset}
          error={commands.error}
          onClose={() => setConfirmation(null)}
        />
      )}
      <BoardManagement
        controller={boardManagement}
        account={account}
        board={board}
        boards={boards.items}
        lists={visibleLists}
        clockOffset={clockOffset}
        preferences={viewPreferences}
        startBoardId={startBoardId}
        loadedListCount={lists.items.length}
        writable={writable}
        localWritable={localWritable}
        submit={submit}
        guard={guard}
        onPrompt={setPrompt}
        onPreferences={updateBoardView}
        onStartBoard={boardData.setStartBoard}
        onChanged={changed}
        onHistory={() => {
          historyDialog.open();
        }}
        onCompleted={() => setView('completed')}
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
                  setInlineDirty(false);
                  if (!boardManagement.creation.isSaving() && !boardManagement.creation.locked)
                    boardManagement.creation.discard();
                  if (
                    !boardManagement.listCreation.isSaving() &&
                    !boardManagement.listCreation.locked
                  ) {
                    boardManagement.listCreation.discard();
                    setListCreationDirty(false);
                  }
                  setResetInlineDrafts((value) => value + 1);
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
        submit={submit}
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
            <TaskMovePicker controller={boardManagement.placement} embedded />
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
    </div>
  );
}
