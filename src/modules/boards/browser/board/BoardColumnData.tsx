import { useEffect, useMemo, useRef } from 'react';
import type { BoardList } from '../../contracts/board';
import type { TaskFilter, TaskSort } from '../../../tasks/contracts/task';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import { unknownCoverage } from '../../../../shared/browser/resources/usePagedResource';
import type { InitialViewReadiness } from '../../../../shared/browser/resources/readiness';
import type { BoardColumn } from './board-column';

export type BoardColumnActions = {
  open: () => Promise<void>;
  completed: () => Promise<void>;
  retry: () => Promise<void>;
};
interface BoardColumnDataProps {
  accountId: string;
  list: BoardList;
  filter: TaskFilter;
  query: string;
  sort: TaskSort;
  version: number;
  completedRequested: boolean;
  discoverCompleted: boolean;
  onData: (id: string, data: BoardColumn) => void;
  onActions: (id: string, actions: BoardColumnActions) => void;
  onReady: (id: string, state: InitialViewReadiness) => void;
}
export function BoardColumnData({
  accountId,
  list,
  filter,
  query,
  sort,
  version,
  completedRequested,
  discoverCompleted,
  onData,
  onActions,
  onReady,
}: BoardColumnDataProps) {
  const completion = filter.completion ?? 'open';
  const input = useMemo(
    () => ({ listIds: [list.id], query, sort, filter: { ...filter, completion } }),
    [list.id, filter, query, sort, completion],
  );
  const completedInput = useMemo(
    () =>
      (discoverCompleted || completedRequested) && completion === 'open'
        ? { ...input, filter: { ...filter, completion: 'completed' as const } }
        : null,
    [discoverCompleted, completedRequested, input, filter, completion],
  );
  const open = useTaskQuery(accountId, input, version),
    completed = useTaskQuery(accountId, completedInput, version);
  const data = useMemo<BoardColumn>(
    () => ({
      list,
      tasks: [...open.page.items, ...completed.page.items],
      coverage: open.page.coverage,
      providerComplete: open.page.providerCoverage.complete,
      orderReadyTaskIds: [
        ...(open.page.orderReadyTaskIds ?? []),
        ...(completed.page.orderReadyTaskIds ?? []),
      ],
      orderReadyListIds: [
        ...(open.page.orderReadyListIds ?? []),
        ...(completed.page.orderReadyListIds ?? []),
      ],
      readVersion:
        open.status === 'ready' &&
        open.settled &&
        (!completedInput || (completed.status === 'ready' && completed.settled))
          ? version
          : undefined,
      status: open.status,
      countLoading: open.status === 'loading' && !open.loaded,
      nextCursor: open.page.nextCursor,
      errorMessage: open.error,
      completedCoverage:
        completion !== 'open'
          ? open.page.coverage
          : completed.loaded
            ? completed.page.coverage
            : unknownCoverage,
      completedNextCursor: completion !== 'open' ? open.page.nextCursor : completed.page.nextCursor,
      completedLoading: (discoverCompleted || completedRequested) && completed.status === 'loading',
      completedCountLoading:
        completion !== 'open'
          ? open.status === 'loading' && !open.loaded
          : completed.status === 'loading' && !completed.loaded,
      completedError: completed.error,
      color: list.color,
      subtaskSummaries: { ...open.page.subtaskSummaries, ...completed.page.subtaskSummaries },
      matchedTaskIds: open.page.matchedTaskIds,
    }),
    [
      list,
      open.page,
      open.status,
      open.settled,
      open.loaded,
      open.error,
      completed.page,
      completed.status,
      completed.settled,
      completedInput,
      completed.error,
      completed.loaded,
      completedRequested,
      discoverCompleted,
      completion,
      version,
    ],
  );
  useEffect(() => onData(list.id, data), [list.id, data, onData]);
  useEffect(() => {
    onReady(list.id, {
      version,
      settled: open.settled && (!completedInput || completed.settled),
      baselineComplete:
        open.page.providerCoverage.complete &&
        (!completedInput || completed.page.providerCoverage.complete),
      failed: open.status === 'error' || Boolean(completedInput && completed.status === 'error'),
    });
  }, [
    list.id,
    version,
    open.settled,
    completed.settled,
    completedInput,
    open.page.providerCoverage.complete,
    completed.page.providerCoverage.complete,
    open.status,
    completed.status,
    onReady,
  ]);
  const latest = useRef({ open, completed });
  latest.current = { open, completed };
  useEffect(
    () =>
      onActions(list.id, {
        open: () => latest.current.open.loadMore(),
        completed: () => {
          const target = completion === 'open' ? latest.current.completed : latest.current.open;
          return target.page.nextCursor ? target.loadMore() : target.reload();
        },
        retry: () => latest.current.open.reload(),
      }),
    [list.id, onActions, completion],
  );
  return null;
}
