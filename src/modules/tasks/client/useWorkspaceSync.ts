import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SyncAdvanceSchema,
  SyncStatusSchema,
  type SyncAdvance,
  type SyncStatus,
} from '../sync-contract';
import { request } from '../../../shared/browser/http/http';

export function syncProgressNeedsRefresh(
  progress: Pick<SyncAdvance, 'phase' | 'errorCode'>,
  lastInvalidatedAt: number | null,
  firstTaskPage: boolean,
  now: number,
): boolean {
  if (progress.errorCode || progress.phase === 'idle' || progress.phase === 'coalesced')
    return false;
  return (
    lastInvalidatedAt === null ||
    (firstTaskPage && progress.phase === 'tasks') ||
    now - lastInvalidatedAt >= 10_000
  );
}

export function useWorkspaceSync(accountId: string, onChanged: () => void) {
  const [status, setStatus] = useState<SyncStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [initialTopologyReady, setInitialTopologyReady] = useState(false),
    [initialForegroundSettled, setInitialForegroundSettled] = useState(false);
  const topologySeen = useRef(false);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const generation = useRef(0),
    flight = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(
    async (reason: 'entry' | 'manual' | 'stale' = 'manual', visibleListIds: string[] = []) => {
      flight.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      const controller = new AbortController(),
        epoch = ++generation.current;
      flight.current = controller;
      setBusy(true);
      setError('');
      const base = `/api/accounts/${encodeURIComponent(accountId)}/sync`;
      let lastInvalidatedAt: number | null = null,
        firstTaskPage = true;
      const advance = async (first: boolean): Promise<void> => {
        if (controller.signal.aborted || generation.current !== epoch) return;
        try {
          const progress = await request(first ? base : `${base}/advance`, SyncAdvanceSchema, {
            method: 'POST',
            body: first ? { reason, visibleListIds } : {},
            signal: controller.signal,
          });
          const next = await request(base, SyncStatusSchema, { signal: controller.signal });
          if (controller.signal.aborted || generation.current !== epoch) return;
          setStatus(next);
          if (!topologySeen.current && ['inventory', 'tasks'].includes(progress.phase)) {
            topologySeen.current = true;
            setInitialTopologyReady(true);
            lastInvalidatedAt = Date.now();
            callback.current();
          }
          if (
            next.pending &&
            next.nextAttemptAt !== null &&
            document.visibilityState === 'visible'
          ) {
            const wait = Math.max(300, next.nextAttemptAt - Date.now());
            // Long backoff is visible; a future return/manual refresh can resume it.
            if (wait <= 30_000) {
              const now = Date.now();
              if (
                topologySeen.current &&
                syncProgressNeedsRefresh(progress, lastInvalidatedAt, firstTaskPage, now)
              ) {
                lastInvalidatedAt = now;
                callback.current();
              }
              if (progress.phase === 'tasks' && !progress.errorCode) firstTaskPage = false;
              timer.current = setTimeout(() => void advance(false), wait);
              return;
            }
          }
          topologySeen.current = true;
          setInitialTopologyReady(true);
          setInitialForegroundSettled(true);
          callback.current();
          setBusy(false);
          flight.current = null;
        } catch (error) {
          if (!controller.signal.aborted && generation.current === epoch) {
            setError(error instanceof Error ? error.message : 'this account could not refresh.');
            topologySeen.current = true;
            setInitialTopologyReady(true);
            setInitialForegroundSettled(true);
            callback.current();
            setBusy(false);
            flight.current = null;
          }
        }
      };
      await advance(true);
    },
    [accountId],
  );
  useEffect(() => {
    void refresh('entry');
    const visible = () => {
      if (document.visibilityState === 'visible' && !flight.current) void refresh('stale');
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      ++generation.current;
      flight.current?.abort();
      flight.current = null;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { status, busy, error, refresh, initialTopologyReady, initialForegroundSettled };
}
