import { useCallback, useEffect, useRef, useState } from 'react';
import type { Coverage, Page } from '../contracts/http';
export const unknownCoverage: Coverage = { complete: false, lastSyncedAt: null, stale: true };
export interface PagedResource<T> {
  items: T[];
  nextCursor: string | null;
  coverage: Coverage;
  status: 'loading' | 'ready' | 'error';
  error: string;
  loaded: boolean;
  scope: string | null;
}
type ResourceState<T> = PagedResource<T> & { settledInvalidation: number | null };
const empty = <T>(scope: string | null = null): ResourceState<T> => ({
  items: [],
  nextCursor: null,
  coverage: unknownCoverage,
  status: 'loading',
  error: '',
  loaded: false,
  scope,
  settledInvalidation: null,
});

/** A scope change aborts old reads and cannot append a late page into a new account. */
export function usePagedResource<T>(
  scope: string | null,
  loader: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  identity: (item: T) => string,
  invalidation = 0,
) {
  const [state, setState] = useState<ResourceState<T>>(() => empty());
  const epoch = useRef(0),
    flight = useRef<AbortController | null>(null),
    stateRef = useRef(state);
  const priorScope = useRef<string | null>(null);
  stateRef.current = state;
  const loaderRef = useRef(loader),
    identityRef = useRef(identity);
  loaderRef.current = loader;
  identityRef.current = identity;
  const load = useCallback(
    async (append = false) => {
      if (scope === null) return;
      if (append && (flight.current || stateRef.current.scope !== scope)) return;
      const cursor = append ? (stateRef.current.nextCursor ?? undefined) : undefined;
      if (append && !cursor) return;
      flight.current?.abort();
      const controller = new AbortController(),
        generation = ++epoch.current;
      flight.current = controller;
      setState((previous) => ({
        ...(previous.scope === scope ? previous : empty<T>(scope)),
        status: 'loading',
        error: '',
      }));
      try {
        const page = await loaderRef.current(cursor, controller.signal);
        if (epoch.current !== generation || controller.signal.aborted) return;
        setState((previous) => {
          const byId = new Map(
            (append ? previous.items : []).map((item) => [identityRef.current(item), item]),
          );
          page.items.forEach((item) => byId.set(identityRef.current(item), item));
          return {
            items: [...byId.values()],
            nextCursor: page.nextCursor,
            coverage: page.coverage,
            status: 'ready',
            error: '',
            loaded: true,
            scope,
            settledInvalidation: invalidation,
          };
        });
      } catch (error) {
        if (!controller.signal.aborted && epoch.current === generation)
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: error instanceof Error ? error.message : 'this page could not be loaded.',
            settledInvalidation: invalidation,
          }));
      } finally {
        if (epoch.current === generation) flight.current = null;
      }
    },
    [scope, invalidation],
  );
  useEffect(() => {
    if (priorScope.current !== scope) {
      setState(empty(scope));
      priorScope.current = scope;
    }
    if (scope !== null) void load();
    return () => {
      ++epoch.current;
      flight.current?.abort();
      flight.current = null;
    };
  }, [scope, load]);
  return {
    ...(state.scope === scope ? state : empty<T>(scope)),
    settled:
      state.scope === scope &&
      state.settledInvalidation === invalidation &&
      state.status !== 'loading',
    reload: () => load(),
    loadMore: () => load(true),
  };
}
