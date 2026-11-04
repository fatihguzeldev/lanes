import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../../shared/browser/http/http';
import { unknownCoverage } from '../../../shared/browser/resources/usePagedResource';
import { TaskPageSchema, type TaskPage, type TaskQueryInput } from '../query-contract';
const empty = (): TaskPage => ({
  items: [],
  matchedTaskIds: [],
  contextTaskIds: [],
  subtaskSummaries: {},
  nextCursor: null,
  coverage: unknownCoverage,
  providerCoverage: unknownCoverage,
});
export function useTaskQuery(accountId: string, input: TaskQueryInput | null, invalidation = 0) {
  const scope = input === null ? null : JSON.stringify([accountId, input]);
  const key = scope === null ? null : JSON.stringify([scope, invalidation]);
  const inputRef = useRef(input);
  inputRef.current = input;
  const [state, setState] = useState({
    page: empty(),
    status: 'loading' as 'loading' | 'ready' | 'error',
    error: '',
    loaded: false,
    scope: null as string | null,
    settledInvalidation: null as number | null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0),
    flight = useRef<AbortController | null>(null);
  const priorScope = useRef<string | null>(null);
  const load = useCallback(
    async (append = false) => {
      if (key === null || inputRef.current === null) return;
      const cursor = append ? stateRef.current.page.nextCursor : undefined;
      if (append && (!cursor || flight.current || stateRef.current.scope !== scope)) return;
      flight.current?.abort();
      const controller = new AbortController(),
        epoch = ++generation.current;
      flight.current = controller;
      setState((previous) => ({ ...previous, status: 'loading', error: '' }));
      try {
        const page = await request(
          `/api/accounts/${encodeURIComponent(accountId)}/tasks/query`,
          TaskPageSchema,
          {
            method: 'POST',
            body: { ...inputRef.current, ...(cursor ? { cursor } : {}) },
            signal: controller.signal,
          },
        );
        if (generation.current !== epoch || controller.signal.aborted) return;
        setState((previous) => {
          const byId = new Map((append ? previous.page.items : []).map((task) => [task.id, task]));
          page.items.forEach((task) => byId.set(task.id, task));
          const matched = new Set([
            ...(append ? previous.page.matchedTaskIds : []),
            ...page.matchedTaskIds,
          ]);
          const contexts = new Set([
            ...(append ? previous.page.contextTaskIds : []),
            ...page.contextTaskIds,
          ]);
          matched.forEach((id) => contexts.delete(id));
          return {
            page: {
              ...page,
              items: [...byId.values()],
              matchedTaskIds: [...matched],
              contextTaskIds: [...contexts],
              subtaskSummaries: {
                ...(append ? previous.page.subtaskSummaries : {}),
                ...page.subtaskSummaries,
              },
              coverage: {
                ...page.providerCoverage,
                complete: page.providerCoverage.complete && page.nextCursor === null,
              },
            },
            status: 'ready',
            error: '',
            loaded: true,
            scope,
            settledInvalidation: invalidation,
          };
        });
      } catch (error) {
        if (!controller.signal.aborted && generation.current === epoch)
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: error instanceof Error ? error.message : 'tasks could not be loaded.',
            settledInvalidation: invalidation,
          }));
      } finally {
        if (generation.current === epoch) flight.current = null;
      }
    },
    [key, accountId],
  );
  useEffect(() => {
    if (priorScope.current !== scope) {
      setState({
        page: empty(),
        status: 'loading',
        error: '',
        loaded: false,
        scope,
        settledInvalidation: null,
      });
      priorScope.current = scope;
    }
    if (key !== null) void load();
    return () => {
      ++generation.current;
      flight.current?.abort();
      flight.current = null;
    };
  }, [key, load, scope]);
  const visible =
    state.scope === scope
      ? state
      : {
          page: empty(),
          status: 'loading' as const,
          error: '',
          loaded: false,
          scope,
          settledInvalidation: null,
        };
  return {
    ...visible,
    settled: visible.settledInvalidation === invalidation && visible.status !== 'loading',
    reload: () => load(),
    loadMore: () => load(true),
  };
}
