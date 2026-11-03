import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { z } from 'zod';
import { Brand } from '../ui/Brand';
import { Icon } from '../ui/Icon';
import { Dialog } from '../ui/Dialog';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import {
  BoardMembershipSchema,
  BoardSchema,
  type Board,
  type BoardList,
} from '../modules/boards/contracts';
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
import { OperationPageSchema, OperationSummarySchema } from '../modules/tasks/operation-contract';
import { checkServerConnection, request, RequestError } from './http';
import { useServerConnection } from './useServerConnection';
import { BoardPageSchema, BoardListPageSchema } from './schemas';
import { usePagedResource } from './usePagedResource';
import { newOperationId, useCommands } from './useCommands';
import { useWorkspaceSync } from './useWorkspaceSync';
import { BoardWorkspace } from './BoardWorkspace';
import { CalendarWorkspace } from './CalendarWorkspace';
import { CompletedWorkspace } from './CompletedWorkspace';
import { HistoryPanel } from './HistoryPanel';
import { TaskEditorWorkspace } from './TaskEditorWorkspace';
import { Confirmation, type ConfirmationChoice } from './Confirmation';
import {
  TaskConsequencesSchema,
  ListConsequencesSchema,
} from '../modules/tasks/consequence-contract';
import { LabelManager } from './LabelManager';
import { TaskCollectionWorkspace } from './TaskCollectionWorkspace';
import { useRecurrenceWork } from './useRecurrenceWork';
import { ReopenDialog } from './ReopenDialog';
import { TaskMoveDialog } from './TaskMoveDialog';
import { BoardOptions } from './BoardOptions';
import { DuplicateDialog } from './DuplicateDialog';
import { CompletedDeletionDialog } from './CompletedDeletionDialog';
import { TaskFiltersDialog } from './TaskFiltersDialog';
import { OperationsPanel } from './OperationsPanel';
import { OperationResolutionDialog } from './OperationResolutionDialog';
import { AccountLifecycleDialog } from './AccountLifecycleDialog';
import { portabilityLanding } from './landing';
import { usePlanningToday } from './usePlanningToday';
import { useMobileNavigation } from './useMobileNavigation';
import {
  RecurrenceAdvanceSchema,
  RecurrenceStatusSchema,
  ReopenPreviewSchema,
  type ReopenPreview,
} from '../modules/tasks/recurrence-contract';
import type { Theme } from './theme';
import {
  defaultBoardView,
  readBoardView,
  readStartBoard,
  saveBoardView,
  saveStartBoard,
  type BoardViewPreferences,
} from '../modules/boards/view-preferences';
import './Workspace.css';

export interface WorkspaceProps {
  account: ConnectionSummary;
  accounts: readonly ConnectionSummary[];
  clockOffset: number;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSelectAccount: (id: string) => void;
  onAuthorize: (purpose: 'link' | 'reconnect', accountId?: string) => void;
  onAccountsChanged: () => void;
  onSignOut: () => void;
}
type Prompt = {
  title: string;
  label: string;
  initial: string;
  description?: string;
  destructive?: boolean;
  submit: (value: string, identity: string) => Promise<boolean>;
};
type Editor = {
  task: Task | null;
  list: TaskList;
  initialDay?: string | null;
  parent?: Task | null;
  boardId?: string;
};
const TemplateWorkspace = lazy(() =>
  import('./TemplateWorkspace').then((module) => ({ default: module.TemplateWorkspace })),
);
const TransferWorkspace = lazy(() =>
  import('./TransferWorkspace').then((module) => ({ default: module.TransferWorkspace })),
);

function PromptDialog({
  prompt,
  onClose,
  clockOffset,
}: {
  prompt: Prompt;
  onClose: () => void;
  clockOffset: number;
}) {
  const [value, setValue] = useState(prompt.initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [identity] = useState(() => newOperationId(clockOffset));
  return (
    <Dialog title={prompt.title} onClose={onClose} pending={pending}>
      <form
        className="dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError('');
          void prompt
            .submit(value, identity)
            .then((done) => {
              if (done) onClose();
              else
                setError(
                  'this change has not been confirmed. inspect its operation before trying again.',
                );
            })
            .catch((error) =>
              setError(
                error instanceof Error ? error.message : 'this change could not be submitted.',
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        {prompt.description && <p>{prompt.description}</p>}
        <label>
          {prompt.label}
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            maxLength={1024}
            autoFocus
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose} disabled={pending}>
            cancel
          </button>
          <button
            type="submit"
            className={`primary${prompt.destructive ? ' danger' : ''}`}
            disabled={pending}
          >
            {pending ? 'saving…' : prompt.destructive ? 'delete' : 'save'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
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
  const [version, setVersion] = useState(0),
    [boardId, setBoardId] = useState<string | null>(() => readStartBoard(account.id));
  const [storedView, setStoredView] = useState<{
      boardId: string;
      value: BoardViewPreferences;
    } | null>(null),
    [quick, setQuick] = useState<'all' | 'today' | 'starred'>('all');
  const [startBoardId, setStartBoardId] = useState<string | null>(() => readStartBoard(account.id));
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
    [settings, setSettings] = useState(false),
    [activity, setActivity] = useState(false),
    [history, setHistory] = useState(false),
    [filtersOpen, setFiltersOpen] = useState(false);
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
  const [reopen, setReopen] = useState<{ task: Task; preview: ReopenPreview } | null>(null);
  const [movingTask, setMovingTask] = useState<Task | null>(null);
  const [copying, setCopying] = useState<
    { kind: 'list'; list: BoardList } | { kind: 'task'; task: Task; boardId: string } | null
  >(null);
  const [completedDeletionList, setCompletedDeletionList] = useState<TaskList | null>(null);
  const [resolvedBoard, setResolvedBoard] = useState<Board | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const changed = useCallback(() => setVersion((value) => value + 1), []);
  const commands = useCommands(account.id, clockOffset, changed);
  const repeatWork = useRecurrenceWork(account.id, account.state === 'connected', changed);
  const syncChanged = useCallback(() => {
    changed();
    void repeatWork.run();
  }, [changed, repeatWork.run]);
  const sync = useWorkspaceSync(account.id, syncChanged);
  const base = `/api/accounts/${encodeURIComponent(account.id)}`;
  const boards = usePagedResource(
    `${account.id}:boards`,
    (cursor, signal) =>
      request(
        `${base}/boards${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardPageSchema,
        { signal },
      ),
    (board) => board.id,
    version,
  );
  const board = boardId
    ? (boards.items.find((item) => item.id === boardId) ??
      (resolvedBoard?.id === boardId ? resolvedBoard : null))
    : (boards.items.find((item) => item.isMain) ?? null);
  const viewPreferences = board
    ? storedView?.boardId === board.id
      ? storedView.value
      : readBoardView(account.id, board.id)
    : defaultBoardView;
  const view = viewPreferences.view;
  const updateBoardView = (patch: Partial<BoardViewPreferences>) => {
    if (!board) return;
    const next = { ...viewPreferences, ...patch };
    setStoredView({ boardId: board.id, value: next });
    saveBoardView(account.id, board.id, next);
  };
  const setView = (next: BoardViewPreferences['view']) => updateBoardView({ view: next });
  useEffect(() => {
    if (!boardId || boards.items.some((item) => item.id === boardId)) {
      setResolvedBoard(null);
      return;
    }
    const controller = new AbortController();
    void request(`${base}/boards/${encodeURIComponent(boardId)}`, BoardSchema, {
      signal: controller.signal,
    })
      .then(setResolvedBoard)
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof RequestError && error.code === 'not_found') {
          setBoardId(null);
          if (startBoardId === boardId) {
            saveStartBoard(account.id, null);
            setStartBoardId(null);
          }
          setNotice('that board is no longer available. opening the main board.');
        } else setNotice(error instanceof Error ? error.message : 'this board could not load.');
      });
    return () => controller.abort();
  }, [base, boardId, boards.items, version, startBoardId, account.id]);
  const lists = usePagedResource(
    board ? `${account.id}:${board.id}:lists` : null,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(board!.id)}/lists${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
        BoardListPageSchema,
        { signal },
      ),
    (list) => list.id,
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
      if (editorDirty || templateDirty || transferDirty) setDiscard(() => action);
      else action();
    },
    [editorDirty, templateDirty, transferDirty],
  );
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
        `${result.state.replaceAll('_', ' ')} · ${result.confirmedSteps}/${result.totalSteps} steps confirmed`,
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
      if (editorDirty || templateDirty || transferDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [editorDirty, templateDirty, transferDirty]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,select,[contenteditable=true],dialog')
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'n' && !event.metaKey && !event.ctrlKey && writable && lists.items[0]) {
        event.preventDefault();
        guard(() => setEditor({ task: null, list: lists.items[0]! }));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [lists.items, writable, guard]);
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
  const toggleComplete = async (task: Task, completed: boolean) => {
    if (!completed) {
      if (task.repeatRule || task.seriesId) {
        try {
          const status = await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence`,
            RecurrenceStatusSchema.nullable(),
          );
          if (!status?.occurrenceId) {
            await submit(
              { kind: 'task.reopen', taskId: task.id, revision: task.revision },
              'provider',
            );
            return;
          }
          await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence/advance`,
            RecurrenceAdvanceSchema,
            { method: 'POST', body: {} },
          );
          const preview = await request(
            `${base}/tasks/${encodeURIComponent(task.id)}/recurrence/reopen-preview`,
            ReopenPreviewSchema,
          );
          setReopen({ task, preview });
        } catch (error) {
          setNotice(
            error instanceof Error ? error.message : 'the repeat occurrence could not be checked.',
          );
        }
      } else
        await submit({ kind: 'task.reopen', taskId: task.id, revision: task.revision }, 'provider');
      return;
    }
    try {
      const preview = await request(
        `${base}/tasks/${encodeURIComponent(task.id)}/consequences`,
        TaskConsequencesSchema,
      );
      if (preview.revision !== task.revision) {
        setNotice('this task changed. review its current values before completing it.');
        changed();
        return;
      }
      if (!preview.coverageComplete) {
        setNotice('refresh the complete list before completing this task and its checklist.');
        return;
      }
      const command = {
        kind: 'task.complete',
        taskId: task.id,
        revision: preview.revision,
        ...(preview.openBlockerCount || preview.openBlockedSubtaskCount
          ? { confirmBlocked: true }
          : {}),
        confirmOpenSubtaskCount: preview.openSubtaskCount,
      };
      if (
        preview.openSubtaskCount ||
        preview.openBlockerCount ||
        preview.openBlockedSubtaskCount ||
        preview.unknownBlockerCount
      ) {
        setConfirmation({
          title: `complete ${preview.title || 'this task'}?`,
          message: [
            preview.openSubtaskCount
              ? `${preview.openSubtaskCount} open subtasks will also complete.`
              : '',
            preview.openBlockerCount
              ? `this task has ${preview.openBlockerCount} open blockers.`
              : '',
            preview.openBlockedSubtaskCount
              ? `${preview.openBlockedSubtaskCount} open subtasks are blocked.`
              : '',
            preview.unknownBlockerCount
              ? `${preview.unknownBlockerCount} blockers have an unresolved identity.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          confirmLabel: 'complete',
          onConfirm: async (identity) => {
            const done = await submit(command, 'provider', identity);
            if (done) void repeatWork.run();
            return done;
          },
        });
      } else if (await submit(command, 'provider')) void repeatWork.run();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'completion could not be checked.');
    }
  };
  const moveTask = async (intent: {
    accountId: string;
    taskId: string;
    revision: number;
    destinationListId: string;
    previousTaskId: string | null;
  }) => {
    if (intent.accountId !== account.id || !writable) return;
    const destination = lists.items.find((item) => item.id === intent.destinationListId);
    if (!destination) return;
    try {
      const preview = await request(
        `${base}/tasks/${encodeURIComponent(intent.taskId)}/consequences`,
        TaskConsequencesSchema,
      );
      if (preview.revision !== intent.revision || !preview.coverageComplete) {
        changed();
        setNotice('refresh this task and its complete checklist before moving it.');
        return;
      }
      const command = {
        kind: 'task.move',
        taskId: intent.taskId,
        revision: intent.revision,
        listId: destination.id,
        listRevision: destination.revision,
        parentId: null,
        previousId: intent.previousTaskId,
        confirmSubtaskCount: preview.subtaskCount,
      };
      if (preview.subtaskCount)
        setConfirmation({
          title: `move ${preview.title || 'this task'}?`,
          message: `this moves the original task and its ${preview.subtaskCount} subtasks together to ${destination.title || 'the selected list'}.`,
          confirmLabel: 'move checklist',
          onConfirm: (identity) => submit(command, 'provider', identity),
        });
      else await submit(command, 'provider');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'this move could not be checked.');
    }
  };
  const deleteTask = async (task: Task) => {
    try {
      const preview = await request(
        `${base}/tasks/${encodeURIComponent(task.id)}/consequences`,
        TaskConsequencesSchema,
      );
      if (preview.revision !== task.revision || !preview.coverageComplete) {
        setNotice('refresh this task and its complete checklist before deleting it.');
        changed();
        return;
      }
      setConfirmation({
        title: `delete ${preview.title || 'this task'}?`,
        message: `this removes the task${preview.subtaskCount ? ` and ${preview.subtaskCount} subtasks` : ''} from google tasks.${preview.assignmentSource ? ' its source assignment will also be removed.' : ''} this cannot be undone in lanes.`,
        confirmLabel: 'delete task',
        onConfirm: async (identity) => {
          const done = await submit(
            {
              kind: 'task.delete',
              taskId: task.id,
              revision: preview.revision,
              confirm: true,
              confirmSubtaskCount: preview.subtaskCount,
              ...(preview.assignmentSource ? { confirmAssignment: true } : {}),
            },
            'provider',
            identity,
          );
          if (done) {
            setEditor(null);
            setEditorDirty(false);
            setTaskMenu(null);
          }
          return done;
        },
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'deletion could not be checked.');
    }
  };
  const deleteList = async (list: BoardList) => {
    try {
      const preview = await request(
        `${base}/lists/${encodeURIComponent(list.id)}/consequences`,
        ListConsequencesSchema,
      );
      if (preview.isDefault || preview.revision !== list.revision || !preview.coverageComplete) {
        setNotice(
          'the default list stays. other lists need a complete fresh inventory before deletion.',
        );
        return;
      }
      setListMenu(null);
      setConfirmation({
        title: `delete ${preview.title || 'this list'}?`,
        message: `this removes the google tasks list and ${preview.taskCount} tasks.${preview.assignedTaskCount ? ` ${preview.assignedTaskCount} source assignments will also be removed.` : ''} its google content cannot be restored through lanes.`,
        confirmLabel: 'delete list',
        onConfirm: (identity) =>
          submit(
            {
              kind: 'list.delete',
              listId: list.id,
              revision: preview.revision,
              confirm: true,
              confirmTaskCount: preview.taskCount,
              ...(preview.assignedTaskCount ? { confirmAssignments: true } : {}),
            },
            'provider',
            identity,
          ),
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'deletion could not be checked.');
    }
  };
  const reschedule = async (intent: {
    accountId: string;
    taskId: string;
    revision: number;
    scheduledDay: string | null;
  }) => {
    if (intent.accountId !== account.id) return;
    try {
      const task = await request(`${base}/tasks/${encodeURIComponent(intent.taskId)}`, TaskSchema);
      if (task.revision !== intent.revision) {
        setNotice('this task changed. review its current date before moving it.');
        changed();
        return;
      }
      const command = {
        kind: 'task.edit',
        taskId: task.id,
        revision: task.revision,
        patch: { scheduledDay: intent.scheduledDay },
      };
      if (intent.scheduledDay === null && (task.scheduledTime || task.repeatRule))
        setConfirmation({
          title: `remove the date from ${task.title || 'this task'}?`,
          message:
            'its local time and repeat rule will also be removed. an unscheduled task cannot keep either.',
          confirmLabel: 'remove date',
          onConfirm: (identity) => submit(command, 'provider', identity),
        });
      else await submit(command, 'provider');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'the task could not be rescheduled.');
    }
  };
  function newBoard() {
    setPrompt({
      title: 'a new board',
      label: 'board name',
      initial: '',
      submit: (value, identity) =>
        submit({ kind: 'board.create', input: { title: value } }, 'local', identity),
    });
  }
  function newList() {
    if (board)
      setPrompt({
        title: 'a new list',
        label: 'list name',
        initial: '',
        description: `a google tasks list in ${board.title}.`,
        submit: (value, identity) =>
          submit(
            { kind: 'list.create', title: value, boardId: board.id, boardRevision: board.revision },
            'provider',
            identity,
          ),
      });
  }

  return (
    <div className={`workspace${navOpen ? ' workspace--nav-open' : ''}`}>
      <aside
        ref={navigation.drawer}
        className="workspace__sidebar"
        aria-label="workspace navigation"
        role={navOpen ? 'dialog' : undefined}
        aria-modal={navOpen || undefined}
      >
        <Brand />
        <button
          className="workspace__quick-add"
          disabled={!writable || !lists.items.length || commands.busy}
          onClick={() =>
            guard(() => {
              setNavOpen(false);
              setEditor({ task: null, list: lists.items[0]! });
            })
          }
        >
          <Icon name="plus" size={16} />
          new task<kbd>n</kbd>
        </button>
        <nav className="workspace__navigation">
          <button
            className={quick === 'today' ? 'active' : ''}
            onClick={() => {
              setQuick('today');
              setView('board');
              setNavOpen(false);
            }}
          >
            <Icon name="sun" size={16} />
            today
          </button>
          <button
            className={quick === 'starred' ? 'active' : ''}
            onClick={() => {
              setQuick('starred');
              setView('board');
              setNavOpen(false);
            }}
          >
            <Icon name="star" size={16} />
            starred
          </button>
        </nav>
        <div className="workspace__section-label">
          <span>your boards</span>
          <button
            aria-label="new board"
            disabled={!localWritable}
            onClick={() => {
              setNavOpen(false);
              newBoard();
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <nav className="workspace__boards" aria-label="boards">
          {boards.items.map((item) => (
            <button
              key={item.id}
              className={board?.id === item.id && quick === 'all' ? 'active' : ''}
              onClick={() =>
                guard(() => {
                  setBoardId(item.id);
                  setQuick('all');
                  setNavOpen(false);
                })
              }
            >
              <span className="workspace__board-symbol">
                {item.emoji ?? <Icon name="board" size={15} />}
              </span>
              <span>{item.title || 'untitled board'}</span>
              {item.isMain && <span className="workspace__main-dot" title="main board" />}
            </button>
          ))}
          {boards.status === 'loading' && !boards.items.length && (
            <p className="workspace__nav-note">loading boards…</p>
          )}
          {boards.error && <button onClick={() => void boards.reload()}>retry boards</button>}
          {boards.nextCursor && (
            <button className="workspace__nav-note" onClick={() => void boards.loadMore()}>
              more boards
              <Icon name="down" size={12} />
            </button>
          )}
        </nav>
        <div className="workspace__sidebar-bottom">
          <button
            onClick={() =>
              guard(() => {
                setNavOpen(false);
                setTransferOpen(true);
              })
            }
          >
            <Icon name="arrow" size={15} />
            import & export
          </button>
          <button
            onClick={() =>
              guard(() => {
                setNavOpen(false);
                setTemplatesOpen(true);
              })
            }
          >
            <Icon name="copy" size={15} />
            templates
          </button>
          <button
            onClick={() => {
              setNavOpen(false);
              setHistory(true);
            }}
          >
            <Icon name="history" size={15} />
            history
          </button>
          <button
            onClick={() => {
              setNavOpen(false);
              setActivity(true);
            }}
          >
            <Icon name="sync" size={15} />
            operations
          </button>
          <button
            onClick={() => {
              setNavOpen(false);
              setSettings(true);
            }}
          >
            <Icon name="settings" size={15} />
            settings
          </button>
        </div>
        <div className="workspace__account">
          <span className="workspace__avatar">
            {account.displayName.slice(0, 1).toLocaleLowerCase()}
          </span>
          <label>
            <span className="sr-only">google account</span>
            <select
              value={account.id}
              onChange={(event) => guard(() => onSelectAccount(event.target.value))}
            >
              {accounts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.displayName} · {item.email}
                </option>
              ))}
            </select>
            <small title={account.email}>{account.email}</small>
          </label>
          <Icon name="down" size={12} />
        </div>
      </aside>
      {navOpen && (
        <button
          className="workspace__nav-backdrop"
          aria-label="close navigation"
          onClick={() => setNavOpen(false)}
        />
      )}
      <main
        className="workspace__main"
        inert={navOpen || undefined}
        style={{ '--board-tint': board?.color ?? '#f1f0e9' } as CSSProperties}
      >
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
        <header className="workspace__header">
          <div className="workspace__heading">
            <button
              ref={navigation.trigger}
              className="workspace__mobile-menu"
              aria-label="open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <div className="workspace__heading-copy">
              <span className="workspace__eyebrow">a place for your things</span>
              <h1>
                {quick === 'all' && board?.emoji && (
                  <span className="workspace__board-emoji" aria-hidden="true">
                    {board.emoji}
                  </span>
                )}
                {quick === 'today'
                  ? 'today'
                  : quick === 'starred'
                    ? 'starred'
                    : (board?.title ?? 'your workspace')}
              </h1>
            </div>
            {board && (
              <button
                className="workspace__board-menu"
                aria-label={`options for ${board.title}`}
                onClick={() => setBoardMenu(true)}
              >
                <Icon name="more" />
              </button>
            )}
            <span className="workspace__account-scope" title={account.email}>
              {account.email}
            </span>
            <button
              className="workspace__primary"
              disabled={!writable || !board || commands.busy}
              onClick={newList}
            >
              <Icon name="plus" size={15} />
              new list
            </button>
          </div>
          <div className="workspace__toolbar">
            <div className="workspace__views" aria-label="workspace view">
              {(['board', 'list', 'calendar'] as const).map((mode) => (
                <button aria-pressed={view === mode} key={mode} onClick={() => setView(mode)}>
                  <Icon
                    name={mode === 'board' ? 'board' : mode === 'list' ? 'list' : 'calendar'}
                    size={14}
                  />
                  {mode}
                </button>
              ))}
            </div>
            <span className="workspace__toolbar-divider" />
            <button
              className={`workspace__tool${Object.keys(filter).length ? ' active' : ''}`}
              onClick={() => setFiltersOpen(true)}
            >
              <Icon name="filter" size={14} />
              filter
            </button>
            <label className="workspace__sort">
              <Icon name="sort" size={14} />
              <span className="sr-only">sort tasks</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as TaskSort)}>
                <option value="manual">manual</option>
                <option value="scheduled">scheduled</option>
                <option value="priority">priority</option>
                <option value="title">title</option>
                <option value="updated">updated</option>
              </select>
            </label>
            <label className="workspace__search">
              <Icon name="search" size={15} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="find something"
                aria-label="search tasks"
              />
              <kbd>/</kbd>
            </label>
            {query && (
              <label className="workspace__search-scope">
                <span className="sr-only">search scope</span>
                <select
                  value={searchScope}
                  onChange={(event) => setSearchScope(event.target.value as 'board' | 'account')}
                >
                  <option value="board">this board</option>
                  <option value="account">all boards</option>
                </select>
              </label>
            )}
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
        {(commands.error || sync.error || repeatWork.error || notice) && (
          <div
            className="workspace__notice"
            role={commands.error || sync.error ? 'alert' : 'status'}
          >
            <span>{commands.error || sync.error || repeatWork.error || notice}</span>
            <button
              onClick={() => {
                setInspectedOperation(
                  commands.errorDetails?.operationId ?? commands.latest?.id ?? null,
                );
                commands.clearError();
                setNotice('');
                setActivity(true);
              }}
            >
              inspect
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
              lists={lists.items}
              today={today}
              labels={labels.items}
              filter={activeFilter}
              query={search}
              sort={sort}
              version={version}
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
              onOpenTask={openTask}
              onToggleComplete={(task, completed) => void toggleComplete(task, completed)}
              onTaskMenu={(task) => setTaskMenu(task)}
              onAddTask={(list) => guard(() => setEditor({ task: null, list }))}
              onListMenu={(list) =>
                setListMenu(lists.items.find((item) => item.id === list.id) ?? null)
              }
              onMoveTask={(intent) => void moveTask(intent)}
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
              onOpenTask={openTask}
              onToggleComplete={(task, completed) => void toggleComplete(task, completed)}
              onTaskMenu={(task) => setTaskMenu(task)}
              onOpenBoard={(id) =>
                guard(() => {
                  setBoardId(id);
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
            lists={lists.items}
            today={today}
            filter={activeFilter}
            query={search}
            sort={sort}
            version={version}
            providerActionsEnabled={writable}
            onOpenTask={openTask}
            onTaskMenu={(task) => setTaskMenu(task)}
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
            lists={lists.items}
            query={search}
            filter={activeFilter}
            version={version}
            onOpenTask={openTask}
            onTaskMenu={(task) => setTaskMenu(task)}
          />
        )}
        {!board && (
          <div className="workspace__empty">
            <Icon name="board" size={26} />
            <h2>
              {boards.status === 'loading' ? 'opening your boards…' : 'make room for your things.'}
            </h2>
            <p>
              {boards.error ||
                'your google lists will appear here when the first refresh is ready.'}
            </p>
          </div>
        )}
        <footer className="workspace__footer">
          <button
            onClick={() =>
              void sync.refresh(
                'manual',
                lists.items.map((list) => list.id),
              )
            }
            disabled={sync.busy}
          >
            <Icon name="sync" size={12} />
            {sync.busy ? 'refreshing…' : 'refresh'}
          </button>
          <span>
            {lists.items.length} lists loaded{lists.nextCursor ? ' · more available' : ''}
          </span>
          {lists.nextCursor && (
            <button onClick={() => void lists.loadMore()}>
              load more lists
              <Icon name="down" size={12} />
            </button>
          )}
          <button
            className="workspace__completed-link"
            onClick={() => setView(view === 'completed' ? 'board' : 'completed')}
          >
            {view === 'completed' ? 'back to board' : 'completed tasks'}
            <Icon name="right" size={12} />
          </button>
        </footer>
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
            <p>
              your unsent changes will be discarded. submitted operations keep their original
              account and destination.
            </p>
            <footer>
              <button onClick={() => setDiscard(null)}>keep editing</button>
              <button
                className="primary"
                onClick={() => {
                  const next = discard;
                  setDiscard(null);
                  setEditorDirty(false);
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
      {boardMenu && board && (
        <BoardOptions
          account={account}
          board={board}
          boards={boards.items}
          clockOffset={clockOffset}
          preferences={viewPreferences}
          startBoardId={startBoardId}
          onPreferences={updateBoardView}
          onStartBoard={(id) => {
            saveStartBoard(account.id, id);
            setStartBoardId(id);
          }}
          onChanged={changed}
          onClose={() => setBoardMenu(false)}
          onDelete={() => {
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
          }}
        />
      )}
      {listMenu && (
        <Dialog title={listMenu.title || 'list options'} onClose={() => setListMenu(null)}>
          <div className="dialog__actions">
            <button
              disabled={!writable}
              onClick={() => {
                const list = listMenu;
                setListMenu(null);
                setPrompt({
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
                const list = listMenu;
                setListMenu(null);
                setPrompt({
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
            <label className="workspace__move-list">
              move to board
              <select
                value={listMenu.boardId}
                disabled={!localWritable || listMenu.isDefault}
                onChange={(event) => {
                  void submit({
                    kind: 'list.placement',
                    listId: listMenu.id,
                    boardId: event.target.value,
                    revision: listMenu.membershipRevision,
                  }).then((done) => {
                    if (done) setListMenu(null);
                  });
                }}
              >
                {boards.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={
                !localWritable || lists.items.findIndex((list) => list.id === listMenu.id) <= 0
              }
              onClick={() => {
                const list = listMenu;
                const index = lists.items.findIndex((item) => item.id === list.id);
                void submit({
                  kind: 'list.placement',
                  listId: list.id,
                  boardId: list.boardId,
                  revision: list.membershipRevision,
                  position: index - 1,
                }).then((done) => {
                  if (done) setListMenu(null);
                });
              }}
            >
              move column earlier
            </button>
            <button
              disabled={
                !localWritable ||
                lists.items.findIndex((list) => list.id === listMenu.id) === lists.items.length - 1
              }
              onClick={() => {
                const list = listMenu;
                const index = lists.items.findIndex((item) => item.id === list.id);
                void submit({
                  kind: 'list.placement',
                  listId: list.id,
                  boardId: list.boardId,
                  revision: list.membershipRevision,
                  position: index + 1,
                }).then((done) => {
                  if (done) setListMenu(null);
                });
              }}
            >
              move column later
            </button>
            <button
              disabled={!writable}
              onClick={() => {
                setCopying({ kind: 'list', list: listMenu });
                setListMenu(null);
              }}
            >
              <Icon name="copy" size={16} />
              duplicate
            </button>
            <button
              className="danger"
              onClick={() => {
                setCompletedDeletionList(listMenu);
                setListMenu(null);
              }}
            >
              <Icon name="trash" size={16} />
              delete completed tasks
            </button>
            <button
              className="danger"
              disabled={!writable || listMenu.isDefault}
              onClick={() => void deleteList(listMenu)}
            >
              <Icon name="trash" size={16} />
              delete list
            </button>
          </div>
        </Dialog>
      )}
      {taskMenu && (
        <Dialog title={taskMenu.title || 'task options'} onClose={() => setTaskMenu(null)}>
          <div className="dialog__actions">
            <button
              onClick={() => {
                openTask(taskMenu);
                setTaskMenu(null);
              }}
            >
              <Icon name="pen" size={16} />
              open task
            </button>
            <button
              disabled={!localWritable}
              onClick={() => {
                void submit({
                  kind: 'task.patch',
                  taskId: taskMenu.id,
                  expectedRevision: taskMenu.revision,
                  patch: { starred: !taskMenu.starred },
                }).then((done) => {
                  if (done) setTaskMenu(null);
                });
              }}
            >
              <Icon name="star" size={16} />
              {taskMenu.starred ? 'remove star' : 'star task'}
            </button>
            <button
              disabled={!writable}
              onClick={() => {
                setCopying({ kind: 'task', task: taskMenu, boardId: board?.id ?? '' });
                setTaskMenu(null);
              }}
            >
              <Icon name="copy" size={16} />
              duplicate task
            </button>
            <button
              disabled={!writable || !taskMenu.capabilities.canMove}
              onClick={() => {
                setMovingTask(taskMenu);
                setTaskMenu(null);
              }}
            >
              <Icon name="arrow" size={16} />
              move, nest or promote
            </button>
            <button
              disabled={!writable}
              onClick={() => {
                void toggleComplete(taskMenu, !taskMenu.completed);
                setTaskMenu(null);
              }}
            >
              <Icon name="check" size={16} />
              {taskMenu.completed ? 'reopen' : 'complete'}
            </button>
            <button
              className="danger"
              disabled={!writable || !taskMenu.capabilities.canDelete}
              onClick={() => void deleteTask(taskMenu)}
            >
              <Icon name="trash" size={16} />
              delete task
            </button>
          </div>
        </Dialog>
      )}
      {filtersOpen && (
        <TaskFiltersDialog
          filter={filter}
          lists={lists.items}
          labels={labels.items}
          today={today}
          onChange={setFilter}
          onClear={() => {
            setFilter({});
            setQuick('all');
            setSearch('');
            setQuery('');
          }}
          onClose={() => setFiltersOpen(false)}
          moreLists={!!lists.nextCursor}
          moreLabels={!!labels.nextCursor}
          onMoreLists={() => void lists.loadMore()}
          onMoreLabels={() => void labels.loadMore()}
        />
      )}
      {settings && (
        <Dialog title="make yourself at home" onClose={() => setSettings(false)}>
          <div className="dialog__body">
            <p>{account.email}</p>
            <label>
              appearance
              <select value={theme} onChange={(event) => onTheme(event.target.value as Theme)}>
                <option value="system">system</option>
                <option value="light">light</option>
                <option value="dark">dark</option>
              </select>
            </label>
            <label>
              planning time zone
              <input
                defaultValue={account.planningZone}
                key={account.planningZone}
                onBlur={(event) => {
                  if (event.target.value !== account.planningZone)
                    void submit({
                      kind: 'account.preferences',
                      input: { revision: account.revision, planningZone: event.target.value },
                    });
                }}
                disabled={!localWritable}
              />
            </label>
            <label>
              week starts on
              <select
                value={account.weekStart}
                disabled={!localWritable}
                onChange={(event) =>
                  void submit({
                    kind: 'account.preferences',
                    input: { revision: account.revision, weekStart: Number(event.target.value) },
                  })
                }
              >
                <option value={1}>monday</option>
                <option value={7}>sunday</option>
              </select>
            </label>
            <footer>
              <button
                onClick={() => {
                  setSettings(false);
                  setAccountLifecycleOpen(true);
                }}
              >
                connection and local data
              </button>
              <button onClick={() => guard(onSignOut)}>sign out</button>
              <button className="primary" onClick={() => guard(() => onAuthorize('link'))}>
                connect another account
              </button>
            </footer>
          </div>
        </Dialog>
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
      {activity && (
        <Dialog title="operations" wide onClose={() => setActivity(false)}>
          <OperationsPanel
            account={account}
            version={version}
            clockOffset={clockOffset}
            selectedId={inspectedOperation}
            onSelect={setInspectedOperation}
            onChanged={changed}
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
                    setBoardId(placement.boardId);
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
