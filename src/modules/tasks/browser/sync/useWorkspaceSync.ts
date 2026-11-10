import { useCallback, useEffect, useRef, useState } from 'react';
import { SyncForegroundSchema, type SyncChanges, type SyncStatus } from '../../contracts/sync';
import { request } from '../../../../shared/browser/http/http';

export function useWorkspaceSync(
  accountId: string,
  onChanged: (changes: SyncChanges) => void,
  retainedWorkspace = false,
  clockOffset = 0,
  onRefreshed?: (() => void) | undefined,
  enabled = true,
) {
  const [status, setStatus] = useState<SyncStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [initialTopologyReady, setInitialTopologyReady] = useState(false),
    [initialForegroundSettled, setInitialForegroundSettled] = useState(false);
  const topologySeen = useRef(false);
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;
  const activation = useRef({ accountId, started: false });
  if (activation.current.accountId !== accountId)
    activation.current = { accountId, started: false };
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const refreshed = useRef(onRefreshed);
  refreshed.current = onRefreshed;
  const retained = useRef(retainedWorkspace);
  retained.current = retainedWorkspace;
  const offset = useRef(clockOffset);
  offset.current = clockOffset;
  const pendingChanges = useRef<SyncChanges>({ topology: false, tasks: false });
  const observedWork = useRef({ pending: false, external: false });
  const resumeRequested = useRef(false);
  const generation = useRef(0),
    flight = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(
    async function refresh(
      reason: 'entry' | 'manual' | 'stale' | 'pending' = 'manual',
      visibleListIds: string[] = [],
    ) {
      if (!enabledNow.current) return;
      if (reason === 'pending' && flight.current) {
        resumeRequested.current = true;
        return;
      }
      resumeRequested.current = false;
      flight.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      const controller = new AbortController(),
        epoch = ++generation.current;
      flight.current = controller;
      setBusy(true);
      setError('');
      const base = `/api/accounts/${encodeURIComponent(accountId)}/sync`;
      let lastInvalidatedAt = Date.now();
      let noProgressDelay = 0;
      const returning = retained.current;
      const flushChanges = () => {
        const changes = pendingChanges.current;
        if (!changes.topology && !changes.tasks) return;
        pendingChanges.current = { topology: false, tasks: false };
        lastInvalidatedAt = Date.now();
        callback.current(changes);
      };
      const settleChanges = () => {
        if (observedWork.current.external) pendingChanges.current = { topology: true, tasks: true };
        if (!observedWork.current.pending)
          observedWork.current = { pending: false, external: false };
        flushChanges();
      };
      const finish = () => {
        topologySeen.current = true;
        setInitialTopologyReady(true);
        setInitialForegroundSettled(true);
        settleChanges();
        setBusy(false);
        flight.current = null;
        // A create can commit after this run's final status snapshot.
        if (resumeRequested.current) void refresh('pending');
      };
      const advance = async (first: boolean): Promise<void> => {
        if (!enabledNow.current || controller.signal.aborted || generation.current !== epoch)
          return;
        if (document.visibilityState !== 'visible') {
          settleChanges();
          setBusy(false);
          flight.current = null;
          return;
        }
        try {
          const progress = await request(
            `${first ? base : `${base}/advance`}?status=1&changes=1`,
            SyncForegroundSchema,
            {
              method: 'POST',
              body: first ? { reason, visibleListIds } : {},
              signal: controller.signal,
            },
          );
          if (!enabledNow.current || controller.signal.aborted || generation.current !== epoch)
            return;
          const next = progress.status;
          setStatus(next);
          if (
            progress.phase === 'coalesced' ||
            (progress.phase === 'idle' && (observedWork.current.pending || next.pending)) ||
            (progress.continued && !next.pending)
          )
            observedWork.current.external = true;
          observedWork.current.pending = next.pending;
          const changes = progress.changes;
          pendingChanges.current.topology ||= changes.topology;
          pendingChanges.current.tasks ||= changes.tasks;
          noProgressDelay = ['idle', 'coalesced'].includes(progress.phase)
            ? Math.min(10_000, noProgressDelay ? noProgressDelay * 2 : 1000)
            : 0;
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
            const scheduledWait = next.nextAttemptAt - (Date.now() + offset.current);
            const wait = scheduledWait > 0 ? scheduledWait : noProgressDelay;
            // Long backoff is visible; a future return/manual refresh can resume it.
            if (wait <= 30_000) {
              if (Date.now() - lastInvalidatedAt >= 10_000) flushChanges();
              timer.current = setTimeout(() => {
                timer.current = null;
                void advance(false);
              }, wait);
              return;
            }
          }
          const successful =
            !next.pending &&
            !progress.errorCode &&
            !next.errorCode &&
            document.visibilityState === 'visible';
          if (successful && (reason === 'manual' || reason === 'stale'))
            pendingChanges.current = { topology: true, tasks: true };
          if (successful && reason === 'pending') pendingChanges.current.tasks = true;
          finish();
          if (successful && reason !== 'pending') refreshed.current?.();
        } catch (error) {
          if (enabledNow.current && !controller.signal.aborted && generation.current === epoch) {
            setError(error instanceof Error ? error.message : 'this account could not refresh.');
            topologySeen.current = true;
            setInitialTopologyReady(true);
            setInitialForegroundSettled(true);
            // The slice may have committed before its response or status read was lost.
            pendingChanges.current = { topology: true, tasks: true };
            observedWork.current = { pending: true, external: true };
            settleChanges();
            setBusy(false);
            flight.current = null;
            resumeRequested.current = false;
          }
        }
      };
      await advance(reason !== 'pending');
    },
    [accountId],
  );
  useEffect(() => {
    if (!enabled) return;
    const reason = activation.current.started ? 'stale' : 'entry';
    activation.current.started = true;
    void refresh(reason);
    const visible = () => {
      if (document.visibilityState === 'visible' && !flight.current) void refresh('stale');
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      ++generation.current;
      flight.current?.abort();
      flight.current = null;
      pendingChanges.current = { topology: false, tasks: false };
      observedWork.current = { pending: false, external: false };
      resumeRequested.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, enabled]);
  const resume = useCallback(() => refresh('pending'), [refresh]);
  return { status, busy, error, refresh, resume, initialTopologyReady, initialForegroundSettled };
}
