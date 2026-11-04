import { useCallback, useEffect, useRef, useState } from 'react';
import { RecurrenceAdvanceSchema } from '../recurrence-contract';
import { SyncAdvanceSchema } from '../sync-contract';
import { request } from '../../../client/http';

/** Follows already admitted recurrence work while this account is on screen. Cron can continue it later. */
export function useRecurrenceWork(accountId: string, enabled: boolean, onChanged: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const running = useRef(false),
    again = useRef(false),
    abort = useRef<AbortController | null>(null),
    callback = useRef(onChanged);
  callback.current = onChanged;
  const run = useCallback(async () => {
    if (!enabled) return;
    if (running.current) {
      again.current = true;
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    running.current = true;
    setBusy(true);
    setError('');
    const base = `/api/accounts/${encodeURIComponent(accountId)}`,
      deadline = Date.now() + 45_000;
    let lastInvalidation = 0;
    try {
      do {
        again.current = false;
        while (!controller.signal.aborted && Date.now() < deadline) {
          const step = await request(`${base}/recurrence/advance`, RecurrenceAdvanceSchema, {
            method: 'POST',
            body: {},
            signal: controller.signal,
          });
          if (step.advanced && (Date.now() - lastInvalidation > 1200 || !step.pending)) {
            callback.current();
            lastInvalidation = Date.now();
          }
          if (!step.pending || ['paused', 'uncertain', 'reopen_required'].includes(step.state))
            break;
          if (step.state === 'undoing')
            await request(`${base}/sync/advance`, SyncAdvanceSchema, {
              method: 'POST',
              body: {},
              signal: controller.signal,
            });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(done, 350);
            function done() {
              controller.signal.removeEventListener('abort', cancel);
              resolve();
            }
            function cancel() {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            }
            controller.signal.addEventListener('abort', cancel, { once: true });
          });
        }
      } while (again.current && !controller.signal.aborted && Date.now() < deadline);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'repeat work is retained and needs another attempt.',
        );
    } finally {
      running.current = false;
      if (!controller.signal.aborted) {
        setBusy(false);
        callback.current();
      }
    }
  }, [accountId, enabled]);
  useEffect(
    () => () => {
      abort.current?.abort();
      running.current = false;
    },
    [accountId],
  );
  return { run, busy, error };
}
