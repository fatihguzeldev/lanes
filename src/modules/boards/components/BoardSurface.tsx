import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { Coverage } from '../../../contracts/http';
import { Icon, type IconName } from '../../../ui/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import type { Label, Task, TaskList, TaskSort } from '../../tasks/contracts';
import { countOpenTasks, getBlockingStates, sortTasks } from '../../tasks/model';
import { TaskCard } from '../../tasks/components/TaskCard';
import { BoardSkeleton, ColumnSkeleton } from './BoardSkeleton';
import './BoardSurface.css';
import type { SubtaskSummary } from '../../tasks/query-contract';

export interface BoardColumn {
  list: TaskList;
  tasks: readonly Task[];
  coverage: Coverage;
  status: 'loading' | 'ready' | 'error';
  nextCursor: string | null;
  subtaskSummaries?: Record<string, SubtaskSummary> | undefined;
  matchedTaskIds?: readonly string[] | undefined;
  errorMessage?: string | undefined;
  completedCoverage?: Coverage | undefined;
  completedNextCursor?: string | null | undefined;
  completedLoading?: boolean | undefined;
  completedError?: string | undefined;
  icon?: IconName | undefined;
  color?: string | undefined;
}

export interface TaskMoveIntent {
  accountId: string;
  taskId: string;
  revision: number;
  sourceListId: string;
  destinationListId: string;
  parentId: null;
  previousTaskId: string | null;
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
  pendingTaskIds?: ReadonlySet<string> | undefined;
  status?: 'loading' | 'ready' | 'error' | undefined;
  errorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  onAddList?: (() => void) | undefined;
  onLoadMoreLists?: (() => void) | undefined;
  onOpenTask: (task: Task) => void;
  onToggleComplete: (task: Task, completed: boolean) => void;
  onTaskMenu: (task: Task, anchor: HTMLButtonElement) => void;
  onAddTask?: ((list: TaskList) => void) | undefined;
  renderTaskCreate?: ((list: TaskList) => ReactNode) | undefined;
  onListMenu: (list: TaskList, anchor: HTMLButtonElement) => void;
  onLoadMore: (list: TaskList, section: 'open' | 'completed') => void;
  onRetryList: (list: TaskList) => void;
  onMoveTask?: ((intent: TaskMoveIntent) => void) | undefined;
}

type DraggedTask = Pick<TaskMoveIntent, 'accountId' | 'taskId' | 'revision' | 'sourceListId'>;
const dragType = 'application/x-lanes-task+json';
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

function readDrag(data: string): DraggedTask | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.accountId !== 'string' ||
      typeof record.taskId !== 'string' ||
      typeof record.sourceListId !== 'string' ||
      typeof record.revision !== 'number' ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0
    )
      return null;
    return {
      accountId: record.accountId,
      taskId: record.taskId,
      sourceListId: record.sourceListId,
      revision: record.revision,
    };
  } catch {
    return null;
  }
}

interface ColumnProps {
  column: BoardColumn;
  options: BoardSurfaceProps;
  knownTasks: readonly Task[];
  canReorder: boolean;
  dragging: DraggedTask | null;
  dropTarget: string | null;
  startDrag: (task: Task, event: DragEvent<HTMLElement>) => void;
  endDrag: () => void;
  overColumn: (column: BoardColumn, event: DragEvent<HTMLElement>) => void;
  dropOnColumn: (column: BoardColumn, event: DragEvent<HTMLElement>) => void;
}

function ListColumn({
  column,
  options,
  knownTasks,
  canReorder,
  dragging,
  dropTarget,
  startDrag,
  endDrag,
  overColumn,
  dropOnColumn,
}: ColumnProps) {
  const [completedExpanded, setCompletedExpanded] = useState(options.expandCompleted ?? false);
  const headingId = useId();
  const completedId = useId();
  const { list } = column;
  const entries = useMemo(
    () =>
      sortTasks(confirmedTasks(column.tasks, options.accountId, list.id), options.sort ?? 'manual'),
    [column.tasks, options.accountId, options.sort, list.id],
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
  const canDrop = canReorder && column.coverage.complete && column.status !== 'loading';
  const columnStyle =
    column.color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(column.color)
      ? ({ '--list-color': column.color } as CSSProperties)
      : undefined;
  const parentTitle = (task: Task): string | undefined =>
    task.parentId ? byId.get(task.parentId)?.title || 'parent not loaded' : undefined;
  const renderCard = (task: Task, completedRow = false) => (
    <TaskCard
      key={`${task.accountId}:${task.id}`}
      task={task}
      subtasks={completedRow || task.parentId ? [] : (children.get(task.id) ?? [])}
      subtaskSummary={
        completedRow || task.parentId ? undefined : column.subtaskSummaries?.[task.id]
      }
      initiallyExpanded={
        !!options.filtered &&
        (children.get(task.id) ?? []).some((child) => !matching || matching.has(child.id))
      }
      relatedTasks={knownTasks}
      blockingState={blockers.get(task)}
      labels={options.labels}
      today={options.today}
      accountTimeZone={options.accountTimeZone}
      pending={options.pendingTaskIds?.has(task.id) ?? false}
      {...(options.pendingTaskIds ? { pendingTaskIds: options.pendingTaskIds } : {})}
      providerActionsEnabled={options.providerActionsEnabled ?? true}
      contextOnly={!completedRow && task.completed}
      {...(parentTitle(task) ? { parentTitle: parentTitle(task)! } : {})}
      draggable={canDrop && !task.completed && task.capabilities.canMove}
      showNotes={options.showNotes ?? true}
      layout={options.layout === 'stacked' ? 'row' : 'column'}
      onOpen={options.onOpenTask}
      onToggleComplete={options.onToggleComplete}
      onMenu={options.onTaskMenu}
      onDragStart={(event) => startDrag(task, event)}
      onDragEnd={endDrag}
    />
  );

  function toggleCompleted() {
    const next = !completedExpanded;
    setCompletedExpanded(next);
    if (next && completed.length === 0 && !completedCoverage.complete && !column.completedLoading)
      options.onLoadMore(list, 'completed');
  }

  return (
    <section
      className={`board-column${dropTarget === list.id && dragging ? ' board-column--drop-target' : ''}`}
      style={columnStyle}
      aria-labelledby={headingId}
      aria-busy={column.status === 'loading' || undefined}
      data-list-id={list.id}
      onDragOver={(event) => overColumn(column, event)}
      onDrop={(event) => dropOnColumn(column, event)}
    >
      <header className="board-column__header">
        <span className="board-column__symbol">
          <Icon name={column.icon ?? 'list'} size={16} />
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
          ) : (
            <Skeleton className="board-skeleton__count" />
          ))}
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
      <div
        className="board-column__tasks"
        role={openCards.length ? 'list' : undefined}
        aria-label={openCards.length ? `open tasks in ${title(list)}` : undefined}
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
      </div>
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
              ) : (
                <Skeleton className="board-skeleton__count" />
              )}
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
  const [dragging, setDragging] = useState<DraggedTask | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const columns = options.columns.filter((column) => column.list.accountId === options.accountId);
  const knownTasks = useMemo(
    () =>
      confirmedTasks(
        options.relatedTasks ?? options.columns.flatMap((column) => column.tasks),
        options.accountId,
      ),
    [options.relatedTasks, options.columns, options.accountId],
  );
  const canReorder = Boolean(
    options.onMoveTask &&
    options.providerActionsEnabled !== false &&
    !options.filtered &&
    (options.sort ?? 'manual') === 'manual',
  );

  function startDrag(task: Task, event: DragEvent<HTMLElement>) {
    if (
      !canReorder ||
      task.accountId !== options.accountId ||
      task.parentId ||
      !task.capabilities.canMove ||
      task.unsupportedHierarchy ||
      options.pendingTaskIds?.has(task.id)
    ) {
      event.preventDefault();
      return;
    }
    const source = columns.find((column) => column.list.id === task.listId);
    if (!source?.coverage.complete || source.status === 'loading') {
      event.preventDefault();
      return;
    }
    const payload: DraggedTask = {
      accountId: task.accountId,
      taskId: task.id,
      sourceListId: task.listId,
      revision: task.revision,
    };
    event.dataTransfer.setData(dragType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'move';
    setDragging(payload);
    setAnnouncement(
      `moving ${task.title || 'untitled task'}. task options provide keyboard movement.`,
    );
  }

  function endDrag() {
    setDragging(null);
    setDropTarget(null);
  }

  function overColumn(column: BoardColumn, event: DragEvent<HTMLElement>) {
    if (
      !canReorder ||
      !dragging ||
      dragging.accountId !== options.accountId ||
      !column.coverage.complete ||
      column.status === 'loading'
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(column.list.id);
  }

  function dropOnColumn(column: BoardColumn, event: DragEvent<HTMLElement>) {
    if (!canReorder || !dragging || !column.coverage.complete || column.status === 'loading')
      return;
    event.preventDefault();
    const payload = readDrag(event.dataTransfer.getData(dragType));
    const task = payload
      ? knownTasks.find(
          (item) =>
            item.id === payload.taskId &&
            item.accountId === payload.accountId &&
            item.listId === payload.sourceListId,
        )
      : undefined;
    if (
      !payload ||
      !task ||
      payload.accountId !== options.accountId ||
      payload.accountId !== dragging.accountId ||
      payload.taskId !== dragging.taskId ||
      payload.revision !== dragging.revision ||
      payload.sourceListId !== dragging.sourceListId ||
      task.revision !== payload.revision ||
      !task.capabilities.canMove ||
      task.parentId
    ) {
      endDrag();
      setAnnouncement('the task changed. choose its destination again.');
      return;
    }
    const siblings = sortTasks(
      confirmedTasks(column.tasks, options.accountId, column.list.id).filter(
        (item) => !item.parentId && item.id !== task.id,
      ),
      'manual',
    );
    const targetElement =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-task-id]') : null;
    const before = targetElement
      ? siblings.findIndex((item) => item.id === targetElement.dataset.taskId)
      : -1;
    const previous = before >= 0 ? siblings[before - 1] : siblings[siblings.length - 1];
    options.onMoveTask?.({
      accountId: options.accountId,
      taskId: task.id,
      revision: payload.revision,
      sourceListId: payload.sourceListId,
      destinationListId: column.list.id,
      parentId: null,
      previousTaskId: previous?.id ?? null,
    });
    setAnnouncement(`move requested for ${task.title || 'untitled task'}.`);
    endDrag();
  }

  const status = options.status ?? 'ready';
  return (
    <div
      className={`board-surface${options.layout === 'stacked' ? ' board-surface--stacked' : ''}`}
    >
      <div className="board-surface__sr-only" role="status" aria-live="polite">
        {announcement}
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
            {options.onAddList && (
              <button
                type="button"
                disabled={options.providerActionsEnabled === false}
                onClick={options.onAddList}
              >
                <Icon name="plus" size={14} />
                new list
              </button>
            )}
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
                dragging={dragging}
                dropTarget={dropTarget}
                startDrag={startDrag}
                endDrag={endDrag}
                overColumn={overColumn}
                dropOnColumn={dropOnColumn}
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
            {options.onAddList && (
              <button
                className="board-surface__add-list"
                type="button"
                disabled={options.providerActionsEnabled === false}
                onClick={options.onAddList}
              >
                <Icon name="plus" size={14} />
                new list
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
