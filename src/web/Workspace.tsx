import { ListOptions } from '../modules/boards/client/ListOptions';
import { BoardNavigation } from '../modules/boards/client/BoardNavigation';
import { TaskOptions } from '../modules/tasks/client/TaskOptions';
import { createTaskActions } from '../modules/tasks/client/task-actions';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Skeleton } from '../ui/Skeleton';
import { Brand } from '../ui/Brand';
import { BoardSkeleton } from '../modules/boards/components/BoardSkeleton';
import { WorkspaceSkeleton } from './WorkspaceSkeleton';
import { initialWorkspaceReady } from './workspace-startup';
import type { InitialViewReadiness } from '../client/readiness';
import { Icon } from '../ui/Icon';
import { Dialog } from '../ui/Dialog';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import { BoardMembershipSchema, type Board, type BoardList } from '../modules/boards/contracts';
import {
  TaskSchema,
  TaskListSchema,
  type Task,
  type TaskFilter,
  type TaskList,
  type TaskSort,
} from '../modules/tasks/contracts';
import { LabelPageSchema } from '../modules/tasks/query-contract';
import { accountToday } from '../modules/tasks/planning';
import { checkServerConnection, request } from '../client/http';
import { useServerConnection } from '../client/useServerConnection';
import { usePagedResource } from '../client/usePagedResource';
import { PromptDialog, type Prompt } from '../client/PromptDialog';
import { useCommands } from '../modules/tasks/client/useCommands';
import { useWorkspaceSync } from '../modules/tasks/client/useWorkspaceSync';
import { BoardWorkspace } from '../modules/boards/client/BoardWorkspace';
import { CalendarWorkspace } from '../modules/boards/client/CalendarWorkspace';
import { CompletedWorkspace } from '../modules/boards/client/CompletedWorkspace';
import { HistoryPanel } from '../modules/history/client/HistoryPanel';
import { TaskEditorWorkspace } from '../modules/tasks/client/TaskEditorWorkspace';
import { Confirmation, type ConfirmationChoice } from '../client/Confirmation';
import { LabelManager } from '../modules/tasks/client/LabelManager';
import { TaskCollectionWorkspace } from '../modules/tasks/client/TaskCollectionWorkspace';
import { useRecurrenceWork } from '../modules/tasks/client/useRecurrenceWork';
import { ReopenDialog } from '../modules/tasks/client/ReopenDialog';
import { TaskMoveDialog } from '../modules/boards/client/TaskMoveDialog';
import { BoardOptions } from '../modules/boards/client/BoardOptions';
import { DuplicateDialog } from '../modules/boards/client/DuplicateDialog';
import { CompletedDeletionDialog } from '../modules/tasks/client/CompletedDeletionDialog';
import { AccountMenu } from '../modules/accounts/client/AccountMenu';
import { ThemeToggle } from './ThemeToggle';
import { WorkspaceSettings } from './WorkspaceSettings';
import { WorkspaceViewMenu } from '../modules/boards/client/WorkspaceViewMenu';
import { SyncControl } from '../modules/tasks/client/SyncControl';
import { Select } from '../ui/Select';
import { ChangeStatus } from '../modules/tasks/client/ChangeStatus';
import { TaskMoveError } from '../modules/tasks/client/save-task-move';
import { useTaskMoveQueue } from '../modules/tasks/client/useTaskMoveQueue';
import { OperationPageSchema } from '../modules/tasks/operation-contract';
import { OperationResolutionDialog } from '../modules/tasks/client/OperationResolutionDialog';
import { AccountLifecycleDialog } from '../modules/accounts/client/AccountLifecycleDialog';
import { portabilityLanding } from './landing';
import { usePlanningToday } from '../modules/tasks/client/usePlanningToday';
import { useMobileNavigation } from './useMobileNavigation';
import type { ReopenPreview } from '../modules/tasks/recurrence-contract';
import type { ResolvedTheme } from './theme';
import type { BoardViewPreferences } from '../modules/boards/client/view-preferences';
import { useBoardData } from '../modules/boards/client/useBoardData';
import { useBoardViewPreferences } from '../modules/boards/client/useBoardViewPreferences';
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

type Editor = {
  task: Task | null;
  list: TaskList;
  initialDay?: string | null;
  parent?: Task | null;
  boardId?: string;
};
const TemplateWorkspace = lazy(() =>
  import('../modules/boards/client/templates/TemplateWorkspace').then((module) => ({
    default: module.TemplateWorkspace,
  })),
);
const TransferWorkspace = lazy(() =>
  import('../modules/transfer/client/TransferWorkspace').then((module) => ({
    default: module.TransferWorkspace,
  })),
);

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
  const [quick, setQuick] = useState<'all' | 'today' | 'starred'>('all');
  const [templatesOpen, setTemplatesOpen] = useState(false),
    [templateDirty, setTemplateDirty] = useState(false);
  const [inspectedOperation, setInspectedOperation] = useState<string | null>(null),
    [resolvingOperation, setResolvingOperation] = useState<string | null>(null);
  const [accountLifecycleOpen, setAccountLifecycleOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(
      () => portabilityLanding()?.accountId === account.id,
    ),
    [transferDirty, setTransferDirty] = useState(false);
  const [transferInitialTab] = useState(() => portabilityLanding()?.tab ?? 'import');
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState<TaskSort>('manual'),
    [filter, setFilter] = useState<TaskFilter>({});
  const [searchScope, setSearchScope] = useState<'board' | 'account'>('board');
  const [navOpen, setNavOpen] = useState(false),
    [activity, setActivity] = useState(false),
    [history, setHistory] = useState(false);
  const [historyTask, setHistoryTask] = useState<Task | null>(null);
  const [inlineDirty, setInlineDirty] = useState(false);
  const [draftContext, setDraftContext] = useState<{ board: Board; lists: BoardList[] } | null>(
    null,
  );
  const [resetInlineDrafts, setResetInlineDrafts] = useState(0);
  const [taskMenuAnchor, setTaskMenuAnchor] = useState<HTMLElement | null>(null);
  const [listMenuAnchor, setListMenuAnchor] = useState<HTMLElement | null>(null);
  const [boardMenuAnchor, setBoardMenuAnchor] = useState<HTMLElement | null>(null);
  const closeNavigation = useCallback(() => setNavOpen(false), []);
  const navigation = useMobileNavigation(navOpen, closeNavigation);
  const [prompt, setPrompt] = useState<Prompt | null>(null),
    [editor, setEditor] = useState<Editor | null>(null),
    [editorDirty, setEditorDirty] = useState(false);
  const [taskMenu, setTaskMenu] = useState<Task | null>(null),
    [listMenu, setListMenu] = useState<BoardList | null>(null),
    [boardMenu, setBoardMenu] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null),
    [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationChoice | null>(null),
    [labelsOpen, setLabelsOpen] = useState(false);
  const [moveErrorId, setMoveErrorId] = useState<string | null>(null);
  const [reopen, setReopen] = useState<{ task: Task; preview: ReopenPreview } | null>(null);
  const [movingTask, setMovingTask] = useState<Task | null>(null);
  const [copying, setCopying] = useState<
    { kind: 'list'; list: BoardList } | { kind: 'task'; task: Task; boardId: string } | null
  >(null);
  const [completedDeletionList, setCompletedDeletionList] = useState<TaskList | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const changed = useCallback(() => setVersion((value) => value + 1), []);
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
  const syncChanged = useCallback(() => {
    changed();
    void repeatWork.run();
  }, [changed, repeatWork.run]);
  const sync = useWorkspaceSync(account.id, syncChanged);
  const base = `/api/accounts/${encodeURIComponent(account.id)}`;
  const boardData = useBoardData({
    accountId: account.id,
    version,
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
  const unfinished = usePagedResource(
    `${account.id}:unfinished-saves`,
    (cursor, signal) =>
      request(
        `${base}/operations?active=1&limit=10${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        OperationPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  const labels = usePagedResource(
    `${account.id}:labels`,
    (cursor, signal) =>
      request(
        `${base}/labels${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        LabelPageSchema,
        { signal },
      ),
    (label) => label.id,
    version,
  );
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
  const guard = useCallback(
    (action: () => void) => {
      if (editorDirty || templateDirty || transferDirty || inlineDirty) setDiscard(() => action);
      else action();
    },
    [editorDirty, templateDirty, transferDirty, inlineDirty],
  );
  const guardAccount = (action: () => void) => {
    if (movingTasks) setNotice('wait for your task moves to finish before leaving this account.');
    else guard(action);
  };
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
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (sync.status?.initialized) onAccountsChanged();
  }, [sync.status?.initialized, onAccountsChanged]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (editorDirty || templateDirty || transferDirty || inlineDirty || movingTasks) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [editorDirty, templateDirty, transferDirty, inlineDirty, movingTasks]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[role=combobox],[contenteditable=true],dialog,[popover]',
        )
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const openTask = (task: Task) => {
    const list = lists.items.find((item) => item.id === task.listId);
    if (list)
      guard(() => {
        setEditor({ task, list, boardId: list.boardId });
        setEditorDirty(false);
      });
    else
      guard(() => {
        void Promise.all([
          request(`${base}/lists/${encodeURIComponent(task.listId)}`, TaskListSchema),
          request(
            `${base}/lists/${encodeURIComponent(task.listId)}/placement`,
            BoardMembershipSchema,
          ),
        ])
          .then(([resolved, membership]) => {
            setEditor({ task, list: resolved, boardId: membership.boardId });
            setEditorDirty(false);
          })
          .catch((error) =>
            setNotice(
              error instanceof Error ? error.message : 'this task’s list could not be opened.',
            ),
          );
      });
  };
  const { toggleComplete, deleteTask, deleteList, reschedule } = createTaskActions({
    accountId: account.id,
    submit,
    confirm: setConfirmation,
    onNotice: setNotice,
    onChanged: changed,
    onRepeat: repeatWork.run,
    onReopen: setReopen,
    onTaskDeleted: () => {
      setEditor(null);
      setEditorDirty(false);
      setTaskMenu(null);
    },
    onListDeleteReady: () => setListMenu(null),
  });
  function newBoard() {
    setPrompt({
      title: 'new board',
      label: 'board name',
      initial: '',
      submit: (value, identity) =>
        submit({ kind: 'board.create', input: { title: value } }, 'local', identity),
    });
  }
  function newList() {
    if (board)
      setPrompt({
        title: 'new list',
        label: 'list name',
        initial: '',
        submit: (value, identity) =>
          submit(
            { kind: 'list.create', title: value, boardId: board.id, boardRevision: board.revision },
            'provider',
            identity,
          ),
      });
  }

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
  const [initialView, setInitialView] = useState<{
    key: string;
    state: InitialViewReadiness;
  } | null>(null);
  const onInitialReady = useCallback(
    (state: InitialViewReadiness) => {
      setInitialView((previous) =>
        previous?.key === initialViewKey &&
        previous.state.version === state.version &&
        previous.state.settled === state.settled &&
        previous.state.baselineComplete === state.baselineComplete &&
        previous.state.failed === state.failed
          ? previous
          : { key: initialViewKey, state },
      );
    },
    [initialViewKey],
  );
  const [revealed, setRevealed] = useState(false);
  const initialReady = initialWorkspaceReady({
    topologyReady: sync.initialTopologyReady,
    foregroundSettled: sync.initialForegroundSettled,
    metadataSettled:
      boards.settled &&
      (board
        ? lists.settled && labels.settled
        : Boolean(boards.error || failedBoardLookup) || !awaitingBoard),
    metadataFailed: Boolean(boards.error || lists.error || labels.error || failedBoardLookup),
    viewRequired: Boolean(board) && lists.status !== 'error',
    version,
    view: initialView?.key === initialViewKey ? initialView.state : null,
  });
  useEffect(() => {
    if (initialReady) setRevealed(true);
  }, [initialReady]);
  return (
    <div
      className={`workspace${navOpen ? ' workspace--nav-open' : ''}${!revealed ? ' workspace--loading' : ''}`}
      inert={!revealed}
      aria-busy={!revealed || undefined}
    >
      {!revealed && <WorkspaceSkeleton theme={theme} />}
      <aside
        ref={navigation.drawer}
        className="workspace__sidebar"
        aria-label="workspace navigation"
        role={navOpen ? 'dialog' : undefined}
        aria-modal={navOpen || undefined}
      >
        <Brand />
        <nav className="workspace__navigation">
          <button
            className={quick === 'today' ? 'active' : ''}
            onClick={() => {
              guard(() => {
                setQuick('today');
                updateBoardView({ view: 'board' });
                setNavOpen(false);
              });
            }}
          >
            <Icon name="sun" size={16} />
            today
          </button>
          <button
            className={quick === 'starred' ? 'active' : ''}
            onClick={() => {
              guard(() => {
                setQuick('starred');
                updateBoardView({ view: 'board' });
                setNavOpen(false);
              });
            }}
          >
            <Icon name="star" size={16} />
            starred
          </button>
        </nav>
        <BoardNavigation
          resource={boards}
          selectedBoardId={
            quick === 'all' && !(searchScope === 'account' && search) ? (board?.id ?? null) : null
          }
          writable={localWritable}
          onCreate={() => {
            setNavOpen(false);
            newBoard();
          }}
          onSelect={(item) =>
            guard(() => {
              boardData.selectBoard(item);
              setQuick('all');
              setSearchScope('board');
              setSearch('');
              setQuery('');
              setNavOpen(false);
            })
          }
          onReorder={(command) => {
            void submit(command, 'local');
          }}
        />
      </aside>
      {navOpen && (
        <button
          className="workspace__nav-backdrop"
          aria-label="close navigation"
          onClick={() => setNavOpen(false)}
        />
      )}
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
        <header className="workspace__topbar">
          <div className="workspace__title">
            <button
              ref={navigation.trigger}
              className="workspace__mobile-menu"
              aria-label="open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <h1
              aria-busy={awaitingBoard || undefined}
              aria-label={
                awaitingBoard && quick === 'all' && !(searchScope === 'account' && search)
                  ? 'loading board'
                  : undefined
              }
            >
              {quick === 'today'
                ? 'today'
                : quick === 'starred'
                  ? 'starred'
                  : searchScope === 'account' && search
                    ? 'search results'
                    : (board?.title ??
                      (awaitingBoard ? (
                        <Skeleton className="workspace-skeleton__title" />
                      ) : (
                        'boards'
                      )))}
            </h1>
            {awaitingBoard && quick === 'all' && !(searchScope === 'account' && search) && (
              <span className="workspace__icon-button" aria-hidden="true">
                <Icon name="more" />
              </span>
            )}
            {board && quick === 'all' && !(searchScope === 'account' && search) && (
              <button
                className="workspace__icon-button"
                aria-label={`options for ${board.title}`}
                onClick={(event) => {
                  setBoardMenuAnchor(event.currentTarget);
                  setBoardMenu(true);
                }}
              >
                <Icon name="more" />
              </button>
            )}
          </div>
          <div className="workspace__search-controls">
            <label className="workspace__search">
              <Icon name="search" size={16} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  const value = event.target.value;
                  if (inlineDirty && searchScope === 'account') guard(() => setQuery(value));
                  else setQuery(value);
                }}
                placeholder="search tasks"
                aria-label="search tasks"
              />
              <kbd>/</kbd>
            </label>
            {query && (
              <Select
                aria-label="search scope"
                value={searchScope}
                className="workspace__search-scope"
                onChange={(value) => guard(() => setSearchScope(value as 'board' | 'account'))}
                options={[
                  { value: 'board', label: 'this board' },
                  { value: 'account', label: 'all boards' },
                ]}
              />
            )}
            <WorkspaceViewMenu
              allowLayout={quick === 'all' && !(searchScope === 'account' && search)}
              view={view}
              sort={sort}
              filter={filter}
              lists={visibleLists}
              labels={labels.items}
              today={today}
              moreLists={!!lists.nextCursor}
              moreLabels={!!labels.nextCursor}
              onView={setView}
              onSort={setSort}
              onFilter={(next) => guard(() => setFilter(next))}
              onClear={() =>
                guard(() => {
                  setFilter({});
                  setSearch('');
                  setQuery('');
                })
              }
              onMoreLists={() => void lists.loadMore()}
              onMoreLabels={() => void labels.loadMore()}
            />
          </div>
          <div className="workspace__global-controls">
            <SyncControl
              unfinished={unfinished.items}
              moreUnfinished={!!unfinished.nextCursor}
              unfinishedLoading={unfinished.status === 'loading'}
              unfinishedError={unfinished.error}
              onMoreUnfinished={() => void unfinished.loadMore()}
              onRetryUnfinished={() => void unfinished.reload()}
              onInspectChange={(id) => {
                setInspectedOperation(id);
                setActivity(true);
              }}
              connected={account.state === 'connected'}
              reachable={connection === 'reachable'}
              busy={sync.busy || commands.busy || repeatWork.busy || movingTasks}
              error={sync.error}
              status={sync.status}
              onRefresh={() =>
                void sync.refresh(
                  'manual',
                  lists.items.map((list) => list.id),
                )
              }
            />
            <ThemeToggle theme={theme} onTheme={onTheme} />
            <WorkspaceSettings
              account={account}
              clockOffset={clockOffset}
              onChanged={() => {
                changed();
                onAccountsChanged();
              }}
              onTransfer={() => guard(() => setTransferOpen(true))}
              onTemplates={() => guard(() => setTemplatesOpen(true))}
            />
            <AccountMenu
              account={account}
              accounts={accounts}
              onSelect={(id) => guardAccount(() => onSelectAccount(id))}
              onConnect={() => guardAccount(() => onAuthorize('link'))}
              onManage={() => guard(() => setAccountLifecycleOpen(true))}
              onSignOut={() => guardAccount(onSignOut)}
            />
          </div>
        </header>
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
                  setInspectedOperation(
                    moveErrorId ??
                      commands.errorDetails?.operationId ??
                      commands.latest?.id ??
                      null,
                  );
                  setActivity(true);
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
        {board &&
          quick === 'all' &&
          !(searchScope === 'account' && search) &&
          (view === 'board' || view === 'list') && (
            <BoardWorkspace
              key={`${account.id}:${board.id}`}
              account={account}
              board={board}
              lists={visibleLists}
              today={today}
              labels={labels.items}
              filter={activeFilter}
              query={search}
              sort={sort}
              version={version}
              onInitialReady={onInitialReady}
              layout={view === 'list' ? 'stacked' : 'kanban'}
              showCounts={viewPreferences.showCounts}
              showCompleted={
                viewPreferences.showCompleted ||
                (!!filter.completion && filter.completion !== 'open')
              }
              showNotes={viewPreferences.showNotes}
              providerActionsEnabled={writable}
              filtered={!!search || quick !== 'all' || Object.keys(filter).length > 0}
              status={lists.status}
              pendingTaskIds={commands.pendingTaskIds}
              errorMessage={lists.error}
              onRetry={() => void lists.reload()}
              onAddList={newList}
              {...(lists.nextCursor ? { onLoadMoreLists: () => void lists.loadMore() } : {})}
              clockOffset={clockOffset}
              onTaskCreated={changed}
              onDraftChange={(dirty) => {
                if (dirty && board) setDraftContext({ board, lists: visibleLists });
                if (!dirty) setDraftContext(null);
                setInlineDirty(dirty);
              }}
              resetDrafts={resetInlineDrafts}
              onInspectCreate={(id) => {
                setInspectedOperation(id);
                setActivity(true);
              }}
              onOpenTask={openTask}
              onToggleComplete={(task, completed) => void toggleComplete(task, completed)}
              onTaskMenu={(task, anchor) => {
                setTaskMenuAnchor(anchor);
                setTaskMenu(task);
              }}
              onListMenu={(list, anchor) => {
                setListMenuAnchor(anchor);
                setListMenu(visibleLists.find((item) => item.id === list.id) ?? null);
              }}
              moveQueue={moveQueue}
            />
          )}
        {board &&
          (quick !== 'all' || (searchScope === 'account' && !!search)) &&
          (view === 'board' || view === 'list') && (
            <TaskCollectionWorkspace
              account={account}
              today={today}
              labels={labels.items}
              query={search}
              filter={activeFilter}
              sort={sort}
              version={version}
              onInitialReady={onInitialReady}
              onOpenTask={openTask}
              onToggleComplete={(task, completed) => void toggleComplete(task, completed)}
              onTaskMenu={(task, anchor) => {
                setTaskMenuAnchor(anchor);
                setTaskMenu(task);
              }}
              onOpenBoard={(id) =>
                guard(() => {
                  boardData.selectBoardId(id);
                  setQuick('all');
                  setSearchScope('board');
                  setSearch('');
                  setQuery('');
                })
              }
            />
          )}
        {board && view === 'calendar' && (
          <CalendarWorkspace
            key={`${account.id}:${board.id}`}
            account={account}
            board={board}
            lists={visibleLists}
            today={today}
            filter={activeFilter}
            query={search}
            sort={sort}
            version={version}
            onInitialReady={onInitialReady}
            providerActionsEnabled={writable}
            onOpenTask={openTask}
            onTaskMenu={(task, anchor) => {
              setTaskMenuAnchor(anchor);
              setTaskMenu(task);
            }}
            onCreateTask={(intent) => {
              if (intent.accountId !== account.id) return;
              guard(() => {
                const loaded = lists.items.find((list) => list.id === intent.listId);
                if (loaded) {
                  setEditor({
                    task: null,
                    list: loaded,
                    boardId: loaded.boardId,
                    initialDay: intent.scheduledDay,
                  });
                  setEditorDirty(false);
                  return;
                }
                void Promise.all([
                  request(`${base}/lists/${encodeURIComponent(intent.listId)}`, TaskListSchema),
                  request(
                    `${base}/lists/${encodeURIComponent(intent.listId)}/placement`,
                    BoardMembershipSchema,
                  ),
                ])
                  .then(([list, membership]) => {
                    setEditor({
                      task: null,
                      list,
                      boardId: membership.boardId,
                      initialDay: intent.scheduledDay,
                    });
                    setEditorDirty(false);
                  })
                  .catch((error) =>
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : 'the selected list could not be opened.',
                    ),
                  );
              });
            }}
            onReschedule={(intent) => void reschedule(intent)}
          />
        )}
        {board && view === 'completed' && (
          <CompletedWorkspace
            clockOffset={clockOffset}
            key={`${account.id}:${board.id}`}
            account={account}
            board={board}
            lists={visibleLists}
            query={search}
            filter={activeFilter}
            version={version}
            onInitialReady={onInitialReady}
            onOpenTask={openTask}
            onTaskMenu={(task, anchor) => {
              setTaskMenuAnchor(anchor);
              setTaskMenu(task);
            }}
          />
        )}
        {!board &&
          (awaitingBoard ? (
            <div className="board-surface">
              <div className="board-surface__scroll">
                <BoardSkeleton
                  showAddList={quick === 'all' && !(searchScope === 'account' && search)}
                />
              </div>
            </div>
          ) : (
            <div className="workspace__empty">
              <Icon name="board" size={26} />
              <h2>
                {failedBoardLookup === boardId && boardId
                  ? 'couldn’t load this board'
                  : boards.error
                    ? 'couldn’t load your boards'
                    : 'no boards yet'}
              </h2>
              {boards.error ? (
                <p role="alert">{boards.error}</p>
              ) : (
                !failedBoardLookup && (
                  <p>your google lists will appear here when the first refresh is ready.</p>
                )
              )}
              {(boards.error || (boardId && failedBoardLookup === boardId)) && (
                <button className="workspace__retry-board" onClick={changed}>
                  try again
                </button>
              )}
            </div>
          ))}
      </main>
      {editor && (
        <TaskEditorWorkspace
          key={`${account.id}:${editor.task?.id ?? `new:${editor.list.id}:${editor.parent?.id ?? ''}`}`}
          account={account}
          selection={editor}
          boardId={editor.boardId ?? board?.id ?? null}
          labels={labels.items}
          version={version}
          clockOffset={clockOffset}
          onChanged={changed}
          onClose={() =>
            guard(() => {
              setEditor(null);
              setEditorDirty(false);
            })
          }
          onSaved={() => {
            setEditor(null);
            setEditorDirty(false);
            changed();
            onAccountsChanged();
          }}
          onInspectChange={(id) => {
            setInspectedOperation(id);
            setActivity(true);
          }}
          onDirtyChange={setEditorDirty}
          onOpenTask={openTask}
          onToggleComplete={(task, completed) => void toggleComplete(task, completed)}
          onDelete={(task) => void deleteTask(task)}
          onCreateSubtask={(task) =>
            guard(() => {
              setEditor({
                task: null,
                list: editor.list,
                parent: task,
                ...(editor.boardId ? { boardId: editor.boardId } : {}),
              });
              setEditorDirty(false);
            })
          }
          onManageLabels={() => setLabelsOpen(true)}
        />
      )}
      {completedDeletionList && (
        <CompletedDeletionDialog
          key={`${account.id}:${completedDeletionList.id}`}
          account={account}
          list={completedDeletionList}
          clockOffset={clockOffset}
          onClose={() => setCompletedDeletionList(null)}
          onChanged={changed}
          onInspect={(id) => {
            setCompletedDeletionList(null);
            setInspectedOperation(id);
            setActivity(true);
          }}
        />
      )}
      {transferOpen && (
        <Dialog
          title="import, export and transfer"
          wide
          onClose={() =>
            guard(() => {
              setTransferOpen(false);
              setTransferDirty(false);
            })
          }
        >
          <Suspense
            fallback={<div className="dialog__body">opening your files and transfers…</div>}
          >
            <TransferWorkspace
              account={account}
              accounts={accounts}
              clockOffset={clockOffset}
              version={version}
              initialTab={transferInitialTab}
              onChanged={changed}
              onDirtyChange={setTransferDirty}
              onOpenOperation={(id) => {
                setInspectedOperation(id);
                setActivity(true);
              }}
              onOpenTask={(reference) => {
                if (reference.accountId !== account.id) {
                  setNotice('choose the destination account to inspect its copied task.');
                  return;
                }
                void request(`${base}/tasks/${encodeURIComponent(reference.taskId)}`, TaskSchema)
                  .then(openTask)
                  .catch((error) =>
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : 'this result is no longer available.',
                    ),
                  );
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {templatesOpen && (
        <Dialog
          title="templates"
          wide
          onClose={() =>
            guard(() => {
              setTemplatesOpen(false);
              setTemplateDirty(false);
            })
          }
        >
          <Suspense fallback={<div className="dialog__body">opening templates…</div>}>
            <TemplateWorkspace
              account={account}
              clockOffset={clockOffset}
              version={version}
              onChanged={changed}
              onDirtyChange={setTemplateDirty}
              onOpenOperation={(id) => {
                setInspectedOperation(id);
                setActivity(true);
              }}
              onRefreshInventory={() =>
                void sync.refresh(
                  'manual',
                  lists.items.map((list) => list.id),
                )
              }
            />
          </Suspense>
        </Dialog>
      )}
      {confirmation && (
        <Confirmation
          choice={confirmation}
          clockOffset={clockOffset}
          error={commands.error}
          onClose={() => setConfirmation(null)}
        />
      )}
      {labelsOpen && (
        <LabelManager
          account={account}
          version={version}
          clockOffset={clockOffset}
          onChanged={changed}
          onClose={() => setLabelsOpen(false)}
        />
      )}
      {reopen && (
        <ReopenDialog
          accountId={account.id}
          title={reopen.task.title}
          preview={reopen.preview}
          clockOffset={clockOffset}
          onClose={() => setReopen(null)}
          onAdmitted={() => {
            changed();
            void repeatWork.run();
          }}
        />
      )}
      {movingTask && board && (
        <TaskMoveDialog
          account={account}
          task={movingTask}
          initialBoardId={board.id}
          clockOffset={clockOffset}
          onChanged={changed}
          onClose={() => setMovingTask(null)}
        />
      )}
      {copying && (
        <DuplicateDialog
          account={account}
          source={copying}
          clockOffset={clockOffset}
          onChanged={changed}
          onClose={() => setCopying(null)}
          onInspect={(id) => {
            setCopying(null);
            setInspectedOperation(id);
            setActivity(true);
          }}
          onRefresh={() =>
            void sync.refresh(
              'manual',
              lists.items.map((list) => list.id),
            )
          }
        />
      )}
      {history && (
        <HistoryPanel
          clockOffset={clockOffset}
          account={account}
          board={board}
          task={historyTask}
          lists={lists.items}
          version={version}
          onClose={() => setHistory(false)}
          onOpenTask={(reference) => {
            if (reference.accountId !== account.id) return;
            void request(`${base}/tasks/${encodeURIComponent(reference.taskId)}`, TaskSchema)
              .then((task) => {
                setHistory(false);
                openTask(task);
              })
              .catch((error) =>
                setNotice(
                  error instanceof Error
                    ? error.message
                    : 'this task is no longer available. its recorded history is retained.',
                ),
              );
          }}
        />
      )}
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
                  setEditorDirty(false);
                  setInlineDirty(false);
                  setResetInlineDrafts((value) => value + 1);
                  setTemplateDirty(false);
                  setTransferDirty(false);
                  setEditor(null);
                  next();
                }}
              >
                discard draft
              </button>
            </footer>
          </div>
        </Dialog>
      )}
      {boardMenu && board && boardMenuAnchor && (
        <BoardOptions
          anchor={boardMenuAnchor}
          onHistory={() => {
            setBoardMenu(false);
            setHistoryTask(null);
            setHistory(true);
          }}
          onCompleted={() => {
            setBoardMenu(false);
            setView('completed');
          }}
          account={account}
          board={board}
          boards={boards.items}
          clockOffset={clockOffset}
          preferences={viewPreferences}
          startBoardId={startBoardId}
          onPreferences={updateBoardView}
          onStartBoard={boardData.setStartBoard}
          onChanged={changed}
          onClose={() => setBoardMenu(false)}
          onDelete={() =>
            guard(() => {
              setBoardMenu(false);
              setPrompt({
                title: `delete ${board.title}?`,
                label: 'type the board name',
                initial: '',
                destructive: true,
                description:
                  'its lists and tasks will move to your main board. google content is preserved.',
                submit: (value, identity) =>
                  value === board.title
                    ? submit(
                        {
                          kind: 'board.delete',
                          boardId: board.id,
                          revision: board.revision,
                          confirmed: true,
                        },
                        'local',
                        identity,
                      )
                    : Promise.resolve(false),
              });
            })
          }
        />
      )}
      {listMenu && listMenuAnchor && (
        <ListOptions
          list={listMenu}
          anchor={listMenuAnchor}
          boards={boards.items}
          lists={visibleLists}
          loadedListCount={lists.items.length}
          writable={writable}
          localWritable={localWritable}
          submit={submit}
          guard={guard}
          onPrompt={setPrompt}
          onClose={() => setListMenu(null)}
          onDuplicate={(list) => setCopying({ kind: 'list', list })}
          onDeleteCompleted={setCompletedDeletionList}
          onDelete={deleteList}
        />
      )}
      {taskMenu && taskMenuAnchor && (
        <TaskOptions
          task={taskMenu}
          anchor={taskMenuAnchor}
          writable={writable}
          localWritable={localWritable}
          submit={submit}
          onClose={() => setTaskMenu(null)}
          onHistory={(task) => {
            setHistoryTask(task);
            setTaskMenu(null);
            setHistory(true);
          }}
          onOpen={(task) => {
            openTask(task);
            setTaskMenu(null);
          }}
          onDuplicate={(task) => {
            setCopying({ kind: 'task', task, boardId: board?.id ?? '' });
            setTaskMenu(null);
          }}
          onMove={(task) => {
            setMovingTask(task);
            setTaskMenu(null);
          }}
          onToggleComplete={(task) => {
            void toggleComplete(task, !task.completed);
            setTaskMenu(null);
          }}
          onDelete={(task) => void deleteTask(task)}
        />
      )}
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
      {activity && inspectedOperation && (
        <Dialog title="change status" onClose={() => setActivity(false)}>
          <ChangeStatus
            account={account}
            operationId={inspectedOperation}
            version={version}
            clockOffset={clockOffset}
            onChanged={changed}
            onClose={() => setActivity(false)}
            onResolve={setResolvingOperation}
            onOpenTask={(id) =>
              void request(`${base}/tasks/${encodeURIComponent(id)}`, TaskSchema)
                .then((task) => {
                  setActivity(false);
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
              void request(
                `${base}/lists/${encodeURIComponent(id)}/placement`,
                BoardMembershipSchema,
              )
                .then((placement) =>
                  guard(() => {
                    boardData.selectBoardId(placement.boardId);
                    setQuick('all');
                    setActivity(false);
                  }),
                )
                .catch((error) =>
                  setNotice(
                    error instanceof Error ? error.message : 'this list is no longer available.',
                  ),
                )
            }
          />
        </Dialog>
      )}
      {resolvingOperation && (
        <OperationResolutionDialog
          account={account}
          operationId={resolvingOperation}
          onClose={() => setResolvingOperation(null)}
          onResolved={() => {
            const id = resolvingOperation;
            setResolvingOperation(null);
            changed();
            void commands.advance(id);
          }}
        />
      )}
    </div>
  );
}
