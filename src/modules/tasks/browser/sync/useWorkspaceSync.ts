import { useCallback, useEffect, useRef, useState } from 'react';
import { SyncStepSchema, type SyncAdvance, type SyncStatus } from '../../contracts/sync';
import { request } from '../../../../shared/browser/http/http';

export interface SyncChanges {
  topology: boolean;
  tasks: boolean;
}

export function syncChanges(progress: Pick<SyncAdvance, 'phase' | 'errorCode'>): SyncChanges {
  if (progress.errorCode) return { topology: false, tasks: false };
  return {
    topology: ['default', 'inventory', 'list_check'].includes(progress.phase),
    tasks: ['tasks', 'list_check', 'task_check'].includes(progress.phase),
  };
}

export function useWorkspaceSync(
  accountId: string,
  onChanged: (changes: SyncChanges) => void,
  retainedWorkspace = false,
) {
  const [status, setStatus] = useState<SyncStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [initialTopologyReady, setInitialTopologyReady] = useState(false),
    [initialForegroundSettled, setInitialForegroundSettled] = useState(false);
  const topologySeen = useRef(false);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const retained = useRef(retainedWorkspace);
  retained.current = retainedWorkspace;
  const pendingChanges = useRef<SyncChanges>({ topology: false, tasks: false });
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
      let lastInvalidatedAt = Date.now();
      const returning = retained.current;
      const flushChanges = () => {
        const changes = pendingChanges.current;
        if (!changes.topology && !changes.tasks) return;
        pendingChanges.current = { topology: false, tasks: false };
        lastInvalidatedAt = Date.now();
        callback.current(changes);
      };
      const advance = async (first: boolean): Promise<void> => {
        if (controller.signal.aborted || generation.current !== epoch) return;
        try {
          const progress = await request(
            `${first ? base : `${base}/advance`}?status=1`,
            SyncStepSchema,
            {
              method: 'POST',
              body: first ? { reason, visibleListIds } : {},
              signal: controller.signal,
            },
          );
          if (controller.signal.aborted || generation.current !== epoch) return;
          const next = progress.status;
          setStatus(next);
          const changes = syncChanges(progress);
          pendingChanges.current.topology ||= changes.topology;
          pendingChanges.current.tasks ||= changes.tasks;
          if (
            !topologySeen.current &&
            !progress.errorCode &&
            ['inventory', 'tasks'].includes(progress.phase)
          ) {
            topologySeen.current = true;
            setInitialTopologyReady(true);
            if (!returning) flushChanges();
          }
          if (
            next.pending &&
            next.nextAttemptAt !== null &&
            document.visibilityState === 'visible'
          ) {
            const wait = Math.max(300, next.nextAttemptAt - Date.now());
            // Long backoff is visible; a future return/manual refresh can resume it.
            if (wait <= 30_000) {
              if (Date.now() - lastInvalidatedAt >= 10_000) flushChanges();
              timer.current = setTimeout(() => void advance(false), wait);
              return;
            }
          }
          topologySeen.current = true;
          setInitialTopologyReady(true);
          setInitialForegroundSettled(true);
          flushChanges();
          setBusy(false);
          flight.current = null;
        } catch (error) {
          if (!controller.signal.aborted && generation.current === epoch) {
            setError(error instanceof Error ? error.message : 'this account could not refresh.');
            topologySeen.current = true;
            setInitialTopologyReady(true);
            setInitialForegroundSettled(true);
            // The slice may have committed before its response or status read was lost.
            pendingChanges.current = { topology: true, tasks: true };
            flushChanges();
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
      pendingChanges.current = { topology: false, tasks: false };
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { status, busy, error, refresh, initialTopologyReady, initialForegroundSettled };
}
