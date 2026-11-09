import { useEffect, useMemo, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Board } from '../../contracts/board';
import {
  groupCompletedTasks,
  sevenDayCompletionSummary,
} from '../../../history/model/completion/completed';
import type { Label, Task, TaskFilter, TaskList } from '../../../tasks/contracts/task';
import { selectCollectionTasks } from '../../../tasks/browser/queries/collection-selection';
import { useTaskListContexts } from '../../../tasks/browser/queries/useTaskListContexts';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import {
  taskChangeAcknowledged,
  projectTaskCollection,
  type PendingTaskChange,
} from '../../../tasks/browser/changes/useTaskChanges';
import { usePlanningToday } from '../../../tasks/browser/planning/usePlanningToday';
import { Select } from '../../../../shared/ui/select/Select';
import { CompletedSummary } from './CompletedSummary';
import { CompletedTaskGroups } from './CompletedTaskGroups';
import type { QueuedTaskMove } from '../../../tasks/browser/movement/task-move-model';
import './CompletedWorkspace.css';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';
import { taskBelongsToBoard } from '../view/task-board-scope';

export interface CompletedWorkspaceProps {
  account: ConnectionSummary;
  board: Board | null;
  lists: readonly TaskList[];
  labels?: readonly Label[];
  scope?: 'board' | 'account';
  onScopeChange?(scope: 'board' | 'account'): void;
  query: string;
  filter: TaskFilter;
  version: number;
  clockOffset: number;
  onOpenTask: (task: Task) => void;
  onReturn(): void;
  onClearFilters(): void;
  onTaskMenu?: (task: Task, anchor: HTMLButtonElement) => void;
  onInitialReady?: (state: InitialViewReadiness) => void;
  edits?: readonly PendingTaskChange[];
  moves?: readonly QueuedTaskMove[];
  onEditRead?(id: string | number): void;
}
export function CompletedWorkspace({
  account,
  board,
  lists: knownLists,
  labels = [],
  scope: controlledScope,
  onScopeChange,
  query,
  filter,
  version,
  clockOffset,
  onOpenTask,
  onReturn,
  onClearFilters,
  onTaskMenu,
  onInitialReady,
  edits = [],
  moves = [],
  onEditRead,
}: CompletedWorkspaceProps) {
  const today = usePlanningToday(account.planningZone, clockOffset);
  const now = useMemo(() => new Date(Date.now() + clockOffset).toISOString(), [today, clockOffset]);
  const [localScope, setLocalScope] = useState<'board' | 'account'>(board ? 'board' : 'account');
  const scope = controlledScope ?? localScope;
  const setScope = onScopeChange ?? setLocalScope;
  const selectionKey = `${account.id}:${scope}:${board?.id ?? ''}`;
  const [selection, setSelection] = useState({ key: selectionKey, listId: '' });
  const listId = selection.key === selectionKey ? selection.listId : '';
  const valid = scope === 'account' || !board || board.accountId === account.id;
  const input = useMemo(
    () =>
      valid
        ? {
            ...(scope === 'board' && board ? { boardId: board.id } : {}),
            query,
            sort: 'updated' as const,
            ...(listId ? { listIds: [listId] } : {}),
            filter: { ...filter, completion: 'completed' as const },
          }
        : null,
    [valid, scope, board?.id, query, listId, filter],
  );
  const tasks = useTaskQuery(account.id, input, version);
  const readVersion = tasks.settled && tasks.status === 'ready' ? version : undefined;
  const projected = projectTaskCollection(
    tasks.page.items,
    edits,
    readVersion,
    (task) => task.accountId === account.id,
    moves,
  );
  const context = useTaskListContexts(
    account.id,
    projected.map((task) => task.listId),
    version,
    knownLists,
  );
  const lists = context.items;
  useEffect(() => {
    for (const edit of edits) {
      if (edit.input.accountId === account.id && taskChangeAcknowledged(edit, readVersion))
        onEditRead?.(edit.id);
    }
  }, [account.id, edits, readVersion, onEditRead]);
  useEffect(() => {
    onInitialReady?.({
      version,
      settled: !input || (tasks.settled && context.settled),
      baselineComplete: !input || tasks.page.providerCoverage.complete,
      failed: tasks.status === 'error' || Boolean(context.error),
    });
  }, [
    version,
    input,
    tasks.settled,
    tasks.page.providerCoverage.complete,
    tasks.status,
    context.settled,
    context.error,
    onInitialReady,
  ]);
  const selected = selectCollectionTasks(
    projected.filter(
      (task) =>
        (scope === 'account' ||
          !board ||
          taskBelongsToBoard(task, board.id, knownLists, context.contexts, tasks.page.items)) &&
        (!listId || task.listId === listId),
    ),
    {
      accountId: account.id,
      today,
      query,
      filter: { ...filter, completion: 'completed' },
      lists,
      labels,
    },
    tasks.page.matchedTaskIds,
    edits,
    readVersion,
    new Set(moves.map((move) => move.intent.taskId)),
  );
  const matched = new Set(selected.matchedTaskIds);
  const rows = selected.tasks;
  const options = {
    accountId: account.id,
    zone: account.planningZone,
    weekStart: account.weekStart,
    now,
    lists,
  };
  const groups = groupCompletedTasks(rows, options).flatMap((group) => {
    const items = group.items.filter((item) => matched.has(item.task.id));
    return items.length ? [{ ...group, items }] : [];
  });
  const summary = sevenDayCompletionSummary(
    rows.filter((task) => matched.has(task.id)),
    options,
  );
  const complete = tasks.loaded && tasks.page.coverage.complete && tasks.page.nextCursor === null;
  const choices = lists.filter((list) => list.accountId === account.id);
  const listName = (id: string) =>
    choices.find((list) => list.id === id)?.title.trim() || 'list not loaded';
  const hasFilters = Boolean(
    query.trim() || listId || Object.keys(filter).some((key) => key !== 'completion'),
  );
  return (
    <section className="completed-workspace" aria-label="completed tasks">
      <div className="completed-workspace__content">
        <header className="completed-workspace__header">
          <div className="completed-workspace__heading">
            <button
              type="button"
              className="completed-workspace__back"
              aria-label="back to board"
              onClick={onReturn}
            >
              <Icon name="left" size={14} /> board
            </button>
            <h2>completed</h2>
          </div>
          <div className="completed-workspace__filters">
            {board && (
              <Select
                aria-label="completed task scope"
                value={scope}
                onChange={(value) => setScope(value as 'board' | 'account')}
                options={[
                  { value: 'board', label: 'this board' },
                  { value: 'account', label: 'all boards' },
                ]}
              />
            )}
            <Select
              aria-label="filter completed tasks by list"
              value={listId}
              onChange={(value) => setSelection({ key: selectionKey, listId: value })}
              options={[
                { value: '', label: 'all lists' },
                ...choices.map((list) => ({
                  value: list.id,
                  label: list.title.trim() || 'untitled list',
                })),
              ]}
            />
          </div>
        </header>
        <div className="completed-workspace__paper">
          {complete && <CompletedSummary summary={summary} today={today} listName={listName} />}
          <div className="completed-workspace__body">
            {context.error && (
              <div
                className="completed-workspace__notice completed-workspace__notice--error"
                role="alert"
              >
                <p>{context.error}</p>
                <button type="button" onClick={context.retry}>
                  retry list names
                </button>
              </div>
            )}
            {!valid && (
              <p
                className="completed-workspace__notice completed-workspace__notice--error"
                role="alert"
              >
                this board belongs to a different account.
              </p>
            )}
            {valid && !tasks.loaded && tasks.status === 'loading' && (
              <p className="completed-workspace__notice" role="status">
                loading completed tasks…
              </p>
            )}
            {valid && tasks.status === 'error' && (
              <div
                className="completed-workspace__notice completed-workspace__notice--error"
                role="alert"
              >
                <p>{tasks.error}</p>
                <button
                  type="button"
                  onClick={() => {
                    void tasks.reload();
                  }}
                >
                  try again
                </button>
              </div>
            )}
            {valid && tasks.loaded && tasks.status !== 'error' && !groups.length && (
              <div className="completed-workspace__empty">
                <p>
                  {!complete
                    ? 'no matching completed tasks loaded yet.'
                    : hasFilters
                      ? 'no completed tasks match these filters.'
                      : 'no completed tasks yet.'}
                </p>
                {hasFilters && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelection({ key: selectionKey, listId: '' });
                      onClearFilters();
                    }}
                  >
                    clear filters
                  </button>
                )}
              </div>
            )}
            <CompletedTaskGroups
              groups={groups}
              timeZone={account.planningZone}
              listName={listName}
              onOpenTask={onOpenTask}
              {...(onTaskMenu ? { onTaskMenu } : {})}
            />
            {tasks.page.nextCursor && (
              <button
                className="completed-workspace__more"
                type="button"
                disabled={tasks.status === 'loading'}
                onClick={() => {
                  void tasks.loadMore();
                }}
              >
                more completed tasks <Icon name="down" size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
