import { useEffect, useMemo } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import { type Label, type Task, type TaskFilter, type TaskSort } from '../../contracts/task';
import { TaskCard } from '../items/TaskCard';
import type { EditorLocation } from '../editor/editor-contract';
import { creationAcknowledged, type PendingTaskCreation } from '../creation/useTaskCreations';
import type { ToggleTaskStar } from '../items/TaskStarButton';
import { countOpenTasks, getBlockingStates, sortTasks } from '../../model/task';
import { collectionCreationMatches, selectCollectionTasks } from './collection-selection';
import { TaskCreationPreview } from '../creation/TaskCreationPreview';
import { projectSubtaskSummary } from '../changes/project-subtask-summary';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { useTaskQuery } from './useTaskQuery';
import { useTaskListContexts } from './useTaskListContexts';
import {
  taskChangeAcknowledged,
  projectTaskCollection,
  type PendingTaskChange,
} from '../changes/useTaskChanges';
import type { QueuedTaskMove } from '../movement/task-move-model';
import './TaskCollectionWorkspace.css';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';

interface Props {
  account: ConnectionSummary;
  today: string;
  labels: readonly Label[];
  query: string;
  filter: TaskFilter;
  sort: TaskSort;
  version: number;
  onOpenTask: (task: Task, location?: EditorLocation) => void;
  onToggleComplete: (task: Task, completed: boolean) => Promise<boolean> | void;
  onToggleStar?: ToggleTaskStar | undefined;
  localActionsEnabled?: boolean;
  pendingTaskIds?: ReadonlySet<string> | undefined;
  onTaskMenu: (task: Task, anchor: HTMLButtonElement) => void;
  onOpenBoard: (id: string) => void;
  onInitialReady?: (state: InitialViewReadiness) => void;
  creations?: readonly PendingTaskCreation[];
  onCreationRead?(id: number): void;
  edits?: readonly PendingTaskChange[];
  moves?: readonly QueuedTaskMove[];
  onEditRead?(id: string | number): void;
}
export function TaskCollectionWorkspace({
  account,
  today,
  labels,
  query,
  filter,
  sort,
  version,
  onOpenTask,
  onToggleComplete,
  onToggleStar,
  localActionsEnabled = false,
  pendingTaskIds,
  onTaskMenu,
  onOpenBoard,
  onInitialReady,
  creations = [],
  onCreationRead,
  edits = [],
  moves = [],
  onEditRead,
}: Props) {
  const input = useMemo(() => ({ query, filter, sort }), [query, filter, sort]);
  const tasks = useTaskQuery(account.id, input, version);
  const readVersion = tasks.settled && tasks.status === 'ready' ? version : undefined;
  const projected = projectTaskCollection(
    tasks.page.items,
    edits,
    readVersion,
    (task) => task.accountId === account.id,
    moves,
  );
  const pendingCreations = creations.filter(
    (creation) =>
      creation.input.accountId === account.id &&
      !creationAcknowledged(creation, readVersion, tasks.page.orderReadyTaskIds),
  );
  useEffect(() => {
    for (const creation of creations) {
      if (
        creation.input.accountId === account.id &&
        creationAcknowledged(creation, readVersion, tasks.page.orderReadyTaskIds)
      )
        onCreationRead?.(creation.id);
    }
  }, [account.id, creations, readVersion, tasks.page.orderReadyTaskIds, onCreationRead]);
  useEffect(() => {
    for (const edit of edits) {
      if (edit.input.accountId === account.id && taskChangeAcknowledged(edit, readVersion))
        onEditRead?.(edit.id);
    }
  }, [account.id, edits, readVersion, onEditRead]);
  const ids = [
    ...new Set([
      ...projected.map((task) => task.listId),
      ...pendingCreations
        .filter((creation) => !creation.deleted)
        .map((creation) => creation.input.listId),
    ]),
  ];
  const context = useTaskListContexts(account.id, ids, version);
  const contextError = context.error;
  useEffect(() => {
    onInitialReady?.({
      version,
      settled: tasks.settled && context.settled,
      baselineComplete: tasks.page.providerCoverage.complete,
      failed: tasks.status === 'error' || Boolean(contextError),
    });
  }, [
    version,
    tasks.settled,
    context.settled,
    contextError,
    tasks.page.providerCoverage.complete,
    tasks.status,
    onInitialReady,
  ]);
  const knownLists = context.items.filter((list) => list.accountId === account.id);
  const lists = new Map(knownLists.map((list) => [list.id, list]));
  const placements = new Map(
    context.contexts.filter((item) => lists.has(item.listId)).map((item) => [item.listId, item]),
  );
  const selection = selectCollectionTasks(
    projected.filter(
      (task) => !pendingCreations.some((creation) => creation.resolvedTaskId === task.id),
    ),
    {
      accountId: account.id,
      today,
      query,
      filter,
      labels,
      lists: knownLists,
    },
    tasks.page.matchedTaskIds,
    edits,
    readVersion,
    new Set(moves.map((move) => move.intent.taskId)),
  );
  const displayedItems = sortTasks(selection.tasks, sort);
  const matchingCreations = pendingCreations.filter((creation) =>
    collectionCreationMatches(
      creation,
      {
        accountId: account.id,
        today,
        query,
        filter,
        labels,
        lists: knownLists,
      },
      projected,
    ),
  );
  const rootCreations = matchingCreations.filter(
    (creation) =>
      !creation.input.parentId ||
      !displayedItems.some((task) => task.id === creation.input.parentId),
  );
  const byId = new Map(displayedItems.map((task) => [task.id, task]));
  const matched = new Set(selection.matchedTaskIds);
  const blocking = getBlockingStates(displayedItems);
  const groups = new Map<string, Task[]>(),
    children = new Map<string, Task[]>();
  for (const task of displayedItems) {
    if (!groups.has(task.listId)) groups.set(task.listId, []);
    groups.get(task.listId)!.push(task);
    if (task.parentId) {
      if (!children.has(task.parentId)) children.set(task.parentId, []);
      children.get(task.parentId)!.push(task);
    }
  }
  return (
    <div className="task-collection">
      {(tasks.error || contextError) && (
        <div className="task-collection__error" role="alert">
          <p>{tasks.error || contextError}</p>
          <button
            onClick={() => {
              if (tasks.error) void tasks.reload();
              if (contextError) context.retry();
            }}
          >
            try again
          </button>
        </div>
      )}
      {[
        ...new Set([...rootCreations.map((creation) => creation.input.listId), ...groups.keys()]),
      ].map((listId) => {
        const list = lists.get(listId),
          placement = placements.get(listId),
          items = groups.get(listId) ?? [];
        const roots = items.filter(
          (task) => !task.parentId || !byId.has(task.parentId) || byId.get(task.parentId)?.parentId,
        );
        return (
          <section className="task-collection__list" key={listId}>
            <header>
              <div>
                <h2>{list?.title || 'loading list…'}</h2>
                {placement && (
                  <button onClick={() => onOpenBoard(placement.boardId)}>
                    {placement.boardTitle}
                    <Icon name="right" size={11} />
                  </button>
                )}
              </div>
              {tasks.page.coverage.complete && tasks.page.nextCursor === null && (
                <span>
                  {rootCreations.filter(
                    (creation) => creation.input.listId === listId && !creation.completed,
                  ).length +
                    countOpenTasks(
                      items.filter((task) => matched.has(task.id)),
                      account.id,
                    )}{' '}
                  matching open
                </span>
              )}
            </header>
            {rootCreations
              .filter((creation) => creation.input.listId === listId)
              .map((creation) => (
                <TaskCreationPreview
                  key={`create:${creation.id}`}
                  creation={creation}
                  parentTitle={projected.find((task) => task.id === creation.input.parentId)?.title}
                />
              ))}
            {roots.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                subtasks={children.get(task.id) ?? []}
                subtaskSummary={projectSubtaskSummary(
                  task,
                  tasks.page.subtaskSummaries[task.id],
                  tasks.page.items,
                  projected,
                  edits,
                  readVersion,
                )}
                pendingSubtasks={matchingCreations}
                blockingState={blocking.get(task)}
                initiallyExpanded={(children.get(task.id) ?? []).some((child) =>
                  matched.has(child.id),
                )}
                relatedTasks={displayedItems}
                labels={labels}
                today={today}
                accountTimeZone={account.planningZone}
                layout="row"
                providerActionsEnabled={account.state === 'connected'}
                localActionsEnabled={localActionsEnabled}
                onToggleStar={onToggleStar}
                pending={pendingTaskIds?.has(task.id) ?? false}
                {...(pendingTaskIds ? { pendingTaskIds } : {})}
                contextOnly={selection.contextTaskIds.includes(task.id)}
                onOpen={(selected) => {
                  const list = lists.get(selected.listId);
                  const placement = placements.get(selected.listId);
                  onOpenTask(
                    selected,
                    list
                      ? { list, ...(placement ? { boardId: placement.boardId } : {}) }
                      : undefined,
                  );
                }}
                onToggleComplete={onToggleComplete}
                onMenu={onTaskMenu}
              />
            ))}
          </section>
        );
      })}
      {!tasks.loaded && tasks.status === 'loading' && (
        <p className="task-collection__coverage" role="status">
          loading tasks…
        </p>
      )}
      {tasks.loaded && displayedItems.length === 0 && rootCreations.length === 0 && (
        <div className="task-collection__empty">
          <Icon name="leaf" size={24} />
          <h2>
            {tasks.page.coverage.complete ? 'nothing here right now.' : 'no tasks to show yet.'}
          </h2>
          {tasks.page.coverage.complete && <p>try another search or clear your filters.</p>}
        </div>
      )}
      {tasks.page.nextCursor && (
        <button
          className="task-collection__more"
          disabled={tasks.status === 'loading'}
          onClick={() => void tasks.loadMore()}
        >
          load more tasks
          <Icon name="down" size={13} />
        </button>
      )}
    </div>
  );
}
