import type { TaskMoveIntent } from '../../../tasks/contracts/task';
import { DragDropProvider } from '@dnd-kit/react';
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Coverage } from '../../../../shared/contracts/http';
import { Icon, type IconName } from '../../../../shared/ui/icon/Icon';
import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';
import type { Label, Task, TaskList, TaskSort } from '../../../tasks/contracts/task';
import { countOpenTasks, getBlockingStates, sortTasks } from '../../../tasks/model/task';
import { TaskCard, type TaskCardProps } from '../../../tasks/browser/items/TaskCard';
import { BoardSkeleton, ColumnSkeleton } from './BoardSkeleton';
import { orderForPresentation } from './drag-model';
import { SortableTask, TaskDropZone, taskDragSensors } from './TaskDrag';
import { useBoardTaskDrag } from './useBoardTaskDrag';
import './BoardSurface.css';
import type { SubtaskSummary } from '../../../tasks/contracts/query';

export interface BoardColumn {
  readVersion?: number | undefined;
  providerComplete?: boolean | undefined;
  list: TaskList;
  tasks: readonly Task[];
  coverage: Coverage;
  status: 'loading' | 'ready' | 'error';
  orderedTaskIds?: readonly string[] | undefined;
  orderReady?: boolean | undefined;
  countLoading?: boolean | undefined;
  nextCursor: string | null;
  subtaskSummaries?: Record<string, SubtaskSummary> | undefined;
  matchedTaskIds?: readonly string[] | undefined;
  errorMessage?: string | undefined;
  completedCoverage?: Coverage | undefined;
  completedNextCursor?: string | null | undefined;
  completedLoading?: boolean | undefined;
  completedCountLoading?: boolean | undefined;
  completedError?: string | undefined;
  icon?: IconName | undefined;
  color?: string | undefined;
}

export interface BoardSurfaceProps {
  accountId: string;
  columns: readonly BoardColumn[];
  labels: readonly Label[];
  relatedTasks?: readonly Task[] | undefined;
  today: string;
  accountTimeZone: string;
  layout?: 'kanban' | 'stacked' | undefined;
  showCounts?: boolean | undefined;
  showCompleted?: boolean | undefined;
  expandCompleted?: boolean | undefined;
  showNotes?: boolean | undefined;
  filtered?: boolean | undefined;
  sort?: TaskSort | undefined;
  providerActionsEnabled?: boolean | undefined;
  localActionsEnabled?: boolean | undefined;
  onToggleStar?: TaskCardProps['onToggleStar'];
  pendingTaskIds?: ReadonlySet<string> | undefined;
  status?: 'loading' | 'ready' | 'error' | undefined;
  errorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  onAddList?: (() => void) | undefined;
  listCreation?: ReactNode;
  onLoadMoreLists?: (() => void) | undefined;
  onOpenTask: (task: Task) => void;
  onToggleComplete: TaskCardProps['onToggleComplete'];
  onTaskMenu: (task: Task, anchor: HTMLButtonElement) => void;
  onAddTask?: ((list: TaskList) => void) | undefined;
  renderTaskCreate?: ((list: TaskList) => ReactNode) | undefined;
  onListMenu: (list: TaskList, anchor: HTMLButtonElement) => void;
  onLoadMore: (list: TaskList, section: 'open' | 'completed') => void;
  onRetryList: (list: TaskList) => void;
  onMoveTask?: ((intent: TaskMoveIntent) => void) | undefined;
}

const title = (list: TaskList): string => (list.title.trim() ? list.title : 'untitled list');

function confirmedTasks(tasks: readonly Task[], accountId: string, listId?: string): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (task.accountId !== accountId || (listId !== undefined && task.listId !== listId)) continue;
    const previous = byId.get(task.id);
    if (!previous || previous.revision < task.revision) byId.set(task.id, task);
  }
  return [...byId.values()];
}

function columnEntries(column: BoardColumn, accountId: string, sort: TaskSort = 'manual'): Task[] {
  const tasks = sortTasks(confirmedTasks(column.tasks, accountId, column.list.id), sort);
  return sort === 'manual' ? orderForPresentation(tasks, column.orderedTaskIds) : tasks;
}

function columnRootIds(column: BoardColumn, accountId: string): string[] {
  return columnEntries(column, accountId)
    .filter((task) => !task.parentId && !task.completed)
    .map((task) => task.id);
}

interface ColumnProps {
  column: BoardColumn;
  options: BoardSurfaceProps;
  knownTasks: readonly Task[];
  canReorder: boolean;
  expandedTasks: ReadonlyMap<string, boolean>;
  onExpandedChange: (task: Task, expanded: boolean) => void;
}

const expansionKey = (task: Task) => `${task.accountId}:${task.id}`;

function ListColumn({
  column,
  options,
  knownTasks,
  canReorder,
  expandedTasks,
  onExpandedChange,
}: ColumnProps) {
  const [completedExpanded, setCompletedExpanded] = useState(options.expandCompleted ?? false);
  const headingId = useId();
  const completedId = useId();
  const { list } = column;
  const entries = useMemo(
    () => columnEntries(column, options.accountId, options.sort ?? 'manual'),
    [column, options.accountId, options.sort],
  );
  const blockers = useMemo(() => getBlockingStates(entries, knownTasks), [entries, knownTasks]);
  const byId = new Map(entries.map((task) => [task.id, task]));
  const children = new Map<string, Task[]>();
  for (const task of entries)
    if (task.parentId) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  const roots = entries.filter(
    (task) => !task.parentId || !byId.has(task.parentId) || byId.get(task.parentId)?.parentId,
  );
  const openCards = roots.filter(
    (task) => !task.completed || (children.get(task.id) ?? []).some((child) => !child.completed),
  );
  const completed = entries.filter((task) => task.completed);
  const matching = column.matchedTaskIds ? new Set(column.matchedTaskIds) : null;
  const openCount = countOpenTasks(
    options.filtered && matching ? entries.filter((task) => matching.has(task.id)) : entries,
    options.accountId,
  );
  const completedCoverage = column.completedCoverage ?? column.coverage;
  const canDrop = canReorder && (column.orderReady ?? column.coverage.complete);
  const rootIds = columnRootIds(column, options.accountId);
  const columnStyle =
    column.color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(column.color)
      ? ({ '--list-color': column.color } as CSSProperties)
      : undefined;
  const parentTitle = (task: Task): string | undefined =>
    task.parentId ? byId.get(task.parentId)?.title || 'parent not loaded' : undefined;
  const renderCard = (task: Task, completedRow = false) => {
    const card = (
      <TaskCard
        key={`${task.accountId}:${task.id}`}
        task={task}
        subtasks={completedRow || task.parentId ? [] : (children.get(task.id) ?? [])}
        subtaskSummary={
          completedRow || task.parentId ? undefined : column.subtaskSummaries?.[task.id]
        }
        expanded={
          expandedTasks.get(expansionKey(task)) ??
          (!!options.filtered &&
            (children.get(task.id) ?? []).some((child) => !matching || matching.has(child.id)))
        }
        onExpandedChange={(expanded) => onExpandedChange(task, expanded)}
        relatedTasks={knownTasks}
        blockingState={blockers.get(task)}
        labels={options.labels}
        today={options.today}
        accountTimeZone={options.accountTimeZone}
        pending={options.pendingTaskIds?.has(task.id) ?? false}
        {...(options.pendingTaskIds ? { pendingTaskIds: options.pendingTaskIds } : {})}
        providerActionsEnabled={options.providerActionsEnabled ?? true}
        localActionsEnabled={options.localActionsEnabled ?? false}
        onToggleStar={options.onToggleStar}
        contextOnly={!completedRow && task.completed}
        {...(parentTitle(task) ? { parentTitle: parentTitle(task)! } : {})}
        showNotes={options.showNotes ?? true}
        layout={options.layout === 'stacked' ? 'row' : 'column'}
        onOpen={options.onOpenTask}
        onToggleComplete={options.onToggleComplete}
        onMenu={options.onTaskMenu}
      />
    );
    if (completedRow || task.parentId || task.completed) return card;
    return (
      <SortableTask
        key={`${task.accountId}:${task.id}`}
        task={task}
        index={rootIds.indexOf(task.id)}
        listId={list.id}
        draggable={
          canDrop &&
          task.capabilities.canMove &&
          !task.unsupportedHierarchy &&
          !options.pendingTaskIds?.has(task.id)
        }
        droppable={canDrop}
      >
        {card}
      </SortableTask>
    );
  };

  function toggleCompleted() {
    const next = !completedExpanded;
    setCompletedExpanded(next);
    if (next && completed.length === 0 && !completedCoverage.complete && !column.completedLoading)
      options.onLoadMore(list, 'completed');
  }

  return (
    <section
      className="board-column"
      style={columnStyle}
      aria-labelledby={headingId}
      aria-busy={column.status === 'loading' || undefined}
      data-list-id={list.id}
    >
      <header className="board-column__header">
        <span className="board-column__symbol">
          <Icon name={column.icon ?? 'list'} size={18} />
        </span>
        <h2 id={headingId}>{title(list)}</h2>
        {options.showCounts !== false &&
          (column.coverage.complete && column.nextCursor === null ? (
            <span
              className="board-column__count"
              title={`${openCount} ${options.filtered ? 'matching ' : ''}open tasks, including subtasks`}
            >
              {openCount}
            </span>
          ) : column.countLoading ? (
            <Skeleton className="board-skeleton__count" />
          ) : null)}
        <button
          className="board-column__menu"
          type="button"
          aria-label={`${title(list)} list options`}
          onClick={(event) => options.onListMenu(list, event.currentTarget)}
        >
          <Icon name="more" size={16} />
        </button>
      </header>
      {column.status === 'error' && (
        <div className="board-column__error" role="alert">
          <p>{column.errorMessage ?? 'this list could not be refreshed.'}</p>
          <button type="button" onClick={() => options.onRetryList(list)}>
            try again
          </button>
        </div>
      )}
      {options.renderTaskCreate
        ? options.renderTaskCreate(list)
        : options.onAddTask && (
            <button
              className="board-column__add"
              type="button"
              disabled={options.providerActionsEnabled === false}
              onClick={() => options.onAddTask?.(list)}
            >
              <Icon name="plus" size={13} />
              add a task
            </button>
          )}
      <TaskDropZone
        listId={list.id}
        disabled={!canDrop}
        hasItems={openCards.length > 0}
        label={`open tasks in ${title(list)}`}
      >
        {openCards.map((task) => renderCard(task))}
        {entries.length === 0 && column.status === 'loading' && !column.coverage.complete && (
          <ColumnSkeleton />
        )}
        {openCards.length === 0 && column.status !== 'error' && column.coverage.complete && (
          <p className="board-column__empty">
            {options.filtered ? 'no matching tasks.' : 'no tasks.'}
          </p>
        )}
      </TaskDropZone>
      {column.nextCursor !== null && (
        <button
          className="board-column__load-more"
          type="button"
          disabled={column.status === 'loading'}
          onClick={() => options.onLoadMore(list, 'open')}
        >
          load more tasks
          <Icon name="down" size={12} />
        </button>
      )}
      {options.showCompleted !== false &&
        (completed.length > 0 ||
          column.completedError ||
          (completedExpanded && column.completedLoading)) && (
          <div className="board-column__completed">
            <button
              className="board-column__completed-toggle"
              type="button"
              aria-expanded={completedExpanded}
              aria-controls={completedId}
              onClick={toggleCompleted}
            >
              <Icon name={completedExpanded ? 'down' : 'right'} size={12} />
              completed
              {completedCoverage.complete && column.completedNextCursor == null ? (
                <span>{completed.length}</span>
              ) : column.completedCountLoading ? (
                <Skeleton className="board-skeleton__count" />
              ) : null}
            </button>
            <div id={completedId} hidden={!completedExpanded}>
              {completedExpanded && (
                <>
                  {completed.length === 0 && column.completedLoading && (
                    <p className="board-column__loading" role="status">
                      loading completed tasks…
                    </p>
                  )}
                  {column.completedError && (
                    <div className="board-column__error" role="alert">
                      <p>{column.completedError}</p>
                      <button type="button" onClick={() => options.onLoadMore(list, 'completed')}>
                        try again
                      </button>
                    </div>
                  )}
                  <div
                    role={completed.length ? 'list' : undefined}
                    aria-label={completed.length ? `completed tasks in ${title(list)}` : undefined}
                  >
                    {completed.map((task) => renderCard(task, true))}
                  </div>
                  {completed.length === 0 &&
                    completedCoverage.complete &&
                    !column.completedLoading && (
                      <p className="board-column__empty">no completed tasks.</p>
                    )}
                  {column.completedNextCursor != null && (
                    <button
                      className="board-column__load-more"
                      type="button"
                      disabled={column.completedLoading}
                      onClick={() => options.onLoadMore(list, 'completed')}
                    >
                      show more
                      <Icon name="down" size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
    </section>
  );
}

export function BoardSurface(options: BoardSurfaceProps) {
  const [expandedTasks, setExpandedTasks] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const onExpandedChange = (task: Task, expanded: boolean) => {
    setExpandedTasks((previous) => new Map(previous).set(expansionKey(task), expanded));
  };
  const sourceColumns = options.columns.filter(
    (column) => column.list.accountId === options.accountId,
  );
  const canReorder = Boolean(
    options.onMoveTask &&
    options.providerActionsEnabled !== false &&
    !options.filtered &&
    (options.sort ?? 'manual') === 'manual',
  );

  const scope = JSON.stringify([
    options.accountId,
    options.layout,
    options.sort,
    options.filtered,
    options.providerActionsEnabled,
    sourceColumns.map((column) => column.list.id),
  ]);
  const drag = useBoardTaskDrag({
    accountId: options.accountId,
    columns: sourceColumns,
    enabled: canReorder,
    scope,
    pendingTaskIds: options.pendingTaskIds,
    onMoveTask: options.onMoveTask,
  });
  const columns = drag.columns;
  const knownTasks = useMemo(
    () =>
      confirmedTasks(
        options.relatedTasks ?? columns.flatMap((column) => column.tasks),
        options.accountId,
      ),
    [options.relatedTasks, columns, options.accountId],
  );

  const status = options.status ?? 'ready';
  return (
    <DragDropProvider
      sensors={taskDragSensors}
      onBeforeDragStart={drag.onBeforeDragStart}
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDragEnd={drag.onDragEnd}
    >
      <div
        className={`board-surface${options.layout === 'stacked' ? ' board-surface--stacked' : ''}${drag.dragging ? ' board-surface--dragging' : ''}`}
      >
        <div className="board-surface__sr-only" role="status" aria-live="polite">
          {drag.announcement}
        </div>
        {status === 'error' && (
          <div className="board-surface__error" role="alert">
            <span>{options.errorMessage ?? 'this board could not be loaded.'}</span>
            {options.onRetry && (
              <button type="button" onClick={options.onRetry}>
                try again
              </button>
            )}
          </div>
        )}
        <div className="board-surface__scroll">
          {columns.length === 0 && status === 'loading' ? (
            <BoardSkeleton
              showAddList={!!options.onAddList}
              showCounts={options.showCounts !== false}
            />
          ) : columns.length === 0 && status === 'ready' ? (
            <div className="board-surface__empty">
              <Icon name="board" size={28} />
              <h2>this board is empty.</h2>
              <p>add a google tasks list to get started.</p>
              {options.listCreation ??
                (options.onAddList && (
                  <button
                    type="button"
                    disabled={options.providerActionsEnabled === false}
                    onClick={options.onAddList}
                  >
                    <Icon name="plus" size={14} />
                    new list
                  </button>
                ))}
            </div>
          ) : (
            <div className="board-surface__grid">
              {columns.map((column) => (
                <ListColumn
                  key={`${options.accountId}:${column.list.id}`}
                  column={column}
                  options={options}
                  knownTasks={knownTasks}
                  canReorder={canReorder}
                  expandedTasks={expandedTasks}
                  onExpandedChange={onExpandedChange}
                />
              ))}
              {options.onLoadMoreLists && (
                <button
                  className="board-surface__more-lists"
                  type="button"
                  disabled={status === 'loading'}
                  onClick={options.onLoadMoreLists}
                >
                  more lists
                  <Icon name="right" size={13} />
                </button>
              )}
              {options.listCreation ??
                (options.onAddList && (
                  <button
                    className="board-surface__add-list"
                    type="button"
                    disabled={options.providerActionsEnabled === false}
                    onClick={options.onAddList}
                  >
                    <Icon name="plus" size={14} />
                    new list
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </DragDropProvider>
  );
}
