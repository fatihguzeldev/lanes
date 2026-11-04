import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import type { ConnectionSummary } from '../../accounts/contracts/connection';
import {
  TaskListSchema,
  type Label,
  type Task,
  type TaskFilter,
  type TaskList,
  type TaskSort,
} from '../contracts';
import { TaskCard } from '../components/TaskCard';
import { countOpenTasks, getBlockingStates } from '../model';
import { Icon } from '../../../shared/ui/icon/Icon';
import { request } from '../../../shared/browser/http/http';
import { useTaskQuery } from './useTaskQuery';
import './TaskCollectionWorkspace.css';
import type { InitialViewReadiness } from '../../../shared/browser/resources/readiness';

const contextsSchema = z
  .object({
    items: z.array(TaskListSchema).max(100),
    contexts: z
      .array(z.object({ listId: z.string(), boardId: z.string(), boardTitle: z.string() }).strict())
      .max(100),
  })
  .strict();
interface Props {
  account: ConnectionSummary;
  today: string;
  labels: readonly Label[];
  query: string;
  filter: TaskFilter;
  sort: TaskSort;
  version: number;
  onOpenTask: (task: Task) => void;
  onToggleComplete: (task: Task, completed: boolean) => void;
  onTaskMenu: (task: Task, anchor: HTMLButtonElement) => void;
  onOpenBoard: (id: string) => void;
  onInitialReady?: (state: InitialViewReadiness) => void;
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
  onTaskMenu,
  onOpenBoard,
  onInitialReady,
}: Props) {
  const input = useMemo(() => ({ query, filter, sort }), [query, filter, sort]);
  const tasks = useTaskQuery(account.id, input, version);
  const ids = [...new Set(tasks.page.items.map((task) => task.listId))];
  const key = JSON.stringify([account.id, ...ids.sort()]);
  const [context, setContext] = useState<{
    key: string;
    items: TaskList[];
    contexts: { listId: string; boardId: string; boardTitle: string }[];
  }>({ key: '', items: [], contexts: [] });
  const [contextError, setContextError] = useState('');
  const [contextSettledVersion, setContextSettledVersion] = useState<number | null>(null);
  const [contextSettledKey, setContextSettledKey] = useState<string | null>(null);
  useEffect(() => {
    onInitialReady?.({
      version,
      settled:
        tasks.settled &&
        (!ids.length || (contextSettledKey === key && contextSettledVersion === version)),
      baselineComplete: tasks.page.providerCoverage.complete,
      failed: tasks.status === 'error' || Boolean(contextError),
    });
  }, [
    version,
    tasks.settled,
    ids.length,
    contextSettledVersion,
    contextSettledKey,
    key,
    contextError,
    tasks.page.providerCoverage.complete,
    tasks.status,
    onInitialReady,
  ]);
  useEffect(() => {
    const [, ...listIds] = JSON.parse(key) as string[];
    if (!listIds.length) return;
    const abort = new AbortController();
    setContextError('');
    setContextSettledVersion(null);
    void (async () => {
      const items: TaskList[] = [],
        contexts: { listId: string; boardId: string; boardTitle: string }[] = [];
      for (let offset = 0; offset < listIds.length; offset += 100) {
        const page = await request(
          `/api/accounts/${encodeURIComponent(account.id)}/lists/resolve`,
          contextsSchema,
          {
            method: 'POST',
            body: { ids: listIds.slice(offset, offset + 100) },
            signal: abort.signal,
          },
        );
        items.push(...page.items);
        contexts.push(...page.contexts);
      }
      if (!abort.signal.aborted) {
        setContext({ key, items, contexts });
        setContextSettledVersion(version);
        setContextSettledKey(key);
      }
    })().catch((error) => {
      if (!abort.signal.aborted) {
        setContextError(error instanceof Error ? error.message : 'list context could not load.');
        setContextSettledVersion(version);
        setContextSettledKey(key);
      }
    });
    return () => abort.abort();
  }, [key, account.id, version]);
  const lists = new Map((context.key === key ? context.items : []).map((list) => [list.id, list]));
  const placements = new Map(
    (context.key === key ? context.contexts : []).map((item) => [item.listId, item]),
  );
  const byId = new Map(tasks.page.items.map((task) => [task.id, task]));
  const matched = new Set(tasks.page.matchedTaskIds);
  const blocking = getBlockingStates(tasks.page.items);
  const groups = new Map<string, Task[]>(),
    children = new Map<string, Task[]>();
  for (const task of tasks.page.items) {
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
          <button onClick={() => void tasks.reload()}>try again</button>
        </div>
      )}
      {ids.map((listId) => {
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
                  {countOpenTasks(
                    items.filter((task) => matched.has(task.id)),
                    account.id,
                  )}{' '}
                  matching open
                </span>
              )}
            </header>
            {roots.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                subtasks={children.get(task.id) ?? []}
                subtaskSummary={tasks.page.subtaskSummaries[task.id]}
                blockingState={blocking.get(task)}
                initiallyExpanded={(children.get(task.id) ?? []).some((child) =>
                  matched.has(child.id),
                )}
                relatedTasks={tasks.page.items}
                labels={labels}
                today={today}
                accountTimeZone={account.planningZone}
                layout="row"
                providerActionsEnabled={account.state === 'connected'}
                contextOnly={tasks.page.contextTaskIds.includes(task.id)}
                onOpen={onOpenTask}
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
      {tasks.loaded && tasks.page.items.length === 0 && (
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
