import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts';
import { TemplateRunSummarySchema, type TemplateRunSummary } from '../../template-contract';
import { OperationSummarySchema, type OperationSummary } from '../../../tasks/operation-contract';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { request, RequestError } from '../../../../shared/browser/http/http';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { type TemplateWorkspaceProps } from './TemplateWorkspace';
import { useLifetime } from './TemplateDraft';
import { baseFor, errorMessage, providerWritable, localWritable } from './template-model';
import { ServerRecovery } from './TemplateFeedback';

export function RunDetail({
  account,
  run: initial,
  onClose,
  onChanged,
  onOpenOperation,
}: {
  account: ConnectionSummary;
  run: TemplateRunSummary;
  onClose: () => void;
  onChanged: () => void;
  onOpenOperation: TemplateWorkspaceProps['onOpenOperation'];
}) {
  const [run, setRun] = useState(initial),
    [operation, setOperation] = useState<OperationSummary | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [cancel, setCancel] = useState(false);
  const [running, setRunning] = useState(
    initial.state === 'capturing' || initial.state === 'running',
  );
  const connection = useServerConnection();
  const lifetime = useLifetime(),
    base = baseFor(account.id),
    refreshVersion = useRef(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  async function refresh(signal: AbortSignal) {
    const generation = ++refreshVersion.current;
    const [latest, receipt] = await Promise.all([
      request(`${base}/template-runs/${encodeURIComponent(initial.id)}`, TemplateRunSummarySchema, {
        signal,
      }),
      request(
        `${base}/operations/${encodeURIComponent(initial.operationId)}`,
        OperationSummarySchema,
        { signal },
      ).catch((caught) => {
        if (caught instanceof RequestError && caught.code === 'not_found') return null;
        throw caught;
      }),
    ]);
    if (!signal.aborted && generation === refreshVersion.current) {
      setRun(latest);
      setOperation(receipt);
    }
    return { run: latest, operation: receipt };
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    });
    return () => controller.abort();
  }, [initial.id]);
  async function action(kind: 'advance' | 'resume' | 'cancel') {
    if (busy || running || connection !== 'reachable') return;
    setBusy(true);
    setError('');
    try {
      const value = await request(
        `${base}/template-runs/${encodeURIComponent(run.id)}/${kind}`,
        TemplateRunSummarySchema,
        { method: 'POST', body: {}, signal: lifetime.current.signal },
      );
      if (!lifetime.current.signal.aborted) {
        setRun(value);
        changed.current();
        await refresh(lifetime.current.signal);
        setCancel(false);
        if (kind !== 'cancel' && ['capturing', 'running'].includes(value.state)) setRunning(true);
      }
    } catch (caught) {
      if (!lifetime.current.signal.aborted) {
        setError(
          `${errorMessage(caught)} confirmed output is retained. refresh this run before trying another copy.`,
        );
        void refresh(lifetime.current.signal).catch(() => {});
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  // Foreground progress is bounded and sequential. The run owner, rather than this
  // loop, decides whether a captured step may be dispatched or reconciled.
  useEffect(() => {
    if (!running) return;
    if (!providerWritable(account) || connection !== 'reachable') {
      setRunning(false);
      return;
    }
    const controller = new AbortController(),
      deadline = Date.now() + 30000;
    async function continueCaptured() {
      try {
        let current = await refresh(controller.signal);
        while (
          !controller.signal.aborted &&
          Date.now() < deadline &&
          ['capturing', 'running'].includes(current.run.state) &&
          !current.operation?.finished &&
          !['uncertain', 'reconnect_required', 'blocked_by_limit', 'failed', 'cancelled'].includes(
            current.operation?.state ?? '',
          ) &&
          (!current.operation?.nextAttemptAt || current.operation.nextAttemptAt < Date.now() + 2000)
        ) {
          const delay = Math.max(600, (current.operation?.nextAttemptAt ?? 0) - Date.now());
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(done, delay);
            function done() {
              controller.signal.removeEventListener('abort', abort);
              resolve();
            }
            function abort() {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            }
            controller.signal.addEventListener('abort', abort, { once: true });
          });
          if (controller.signal.aborted || Date.now() >= deadline) break;
          await request(
            `${base}/template-runs/${encodeURIComponent(initial.id)}/advance`,
            TemplateRunSummarySchema,
            { method: 'POST', body: {}, signal: controller.signal },
          );
          changed.current();
          current = await refresh(controller.signal);
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setError(`${errorMessage(caught)} inspect confirmed progress before continuing.`);
      } finally {
        if (!controller.signal.aborted) setRunning(false);
      }
    }
    void continueCaptured();
    return () => controller.abort();
  }, [running, initial.id, account.state, connection]);
  // Read-only polling keeps cron progress visible after the short foreground run.
  useEffect(() => {
    if (running || ['succeeded', 'cancelled', 'paused', 'partial'].includes(run.state)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void refresh(controller.signal).catch((caught) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      });
    }, 2500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [run, running]);
  const terminal = run.state === 'succeeded' || run.state === 'cancelled';
  return (
    <Dialog title="template run" onClose={onClose} wide pending={busy}>
      <div className="dialog__body templates__form">
        <ServerRecovery />
        <span className="templates__stamp">
          {run.scheduleId ? 'scheduled' : 'manual'} · {run.slotDay} · {run.state}
        </span>
        <div className="templates__preview">
          <div className="templates__numbers">
            <span>
              <strong>{operation?.confirmedSteps ?? '—'}</strong>confirmed steps
            </span>
            <span>
              <strong>{operation?.totalSteps ?? '—'}</strong>total steps
            </span>
            <span>
              <strong>{operation?.inputSealed ? 'ready' : 'saving'}</strong>input
            </span>
          </div>
          <p>
            progress includes preparing the copy, creating lists and tasks, and linking
            dependencies. steps are counted separately from tasks.
          </p>
        </div>
        {operation && (
          <progress
            aria-label="confirmed operation steps"
            value={operation.confirmedSteps}
            max={operation.totalSteps}
          />
        )}
        <p>
          this run keeps the original snapshot and destination. confirmed lists and tasks stay in
          your workspace; no automatic rollback removes them.
        </p>
        {run.skippedBefore && (
          <p>older missed checklist slots through {run.skippedBefore} were skipped.</p>
        )}
        {(run.errorCode || operation?.error) && (
          <p className="templates__warning">
            {operation?.error?.message ?? run.errorCode?.replaceAll('_', ' ')}
          </p>
        )}
        {operation?.state === 'uncertain' && (
          <p className="templates__warning">
            google may have accepted the last creation. inspect and reconcile the operation before
            continuing; a new copy can create duplicates.
          </p>
        )}
        {operation?.nextAttemptAt && (
          <p>
            next retry opportunity{' '}
            {new Intl.DateTimeFormat('en', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: account.planningZone,
            }).format(operation.nextAttemptAt)}{' '}
            · {account.planningZone}.
          </p>
        )}
        {error && (
          <p className="templates__error" role="alert">
            {error}
          </p>
        )}
        <p className="templates__retained">
          operation <code>{run.operationId}</code>
        </p>
        <div className="templates__management">
          {running && (
            <button type="button" onClick={() => setRunning(false)}>
              leave progress in the background
              <Icon name="clock" size={14} />
            </button>
          )}
          <button
            type="button"
            disabled={busy || running}
            onClick={() => {
              setError('');
              void refresh(lifetime.current.signal).catch((caught) =>
                setError(errorMessage(caught)),
              );
            }}
          >
            <Icon name="sync" size={14} />
            refresh confirmed progress
          </button>
          {onOpenOperation && (
            <button type="button" disabled={busy} onClick={() => onOpenOperation(run.operationId)}>
              inspect operation
              <Icon name="external" size={14} />
            </button>
          )}
          {!terminal &&
            !operation?.finished &&
            (run.state === 'paused' || run.state === 'partial') && (
              <button
                type="button"
                disabled={
                  busy ||
                  running ||
                  connection !== 'reachable' ||
                  !providerWritable(account) ||
                  operation?.state === 'uncertain'
                }
                onClick={() => void action('resume')}
              >
                resume this captured run
                <Icon name="arrow" size={14} />
              </button>
            )}
          {!terminal &&
            !operation?.finished &&
            (run.state === 'capturing' || run.state === 'running') && (
              <button
                type="button"
                disabled={
                  busy ||
                  running ||
                  connection !== 'reachable' ||
                  !providerWritable(account) ||
                  operation?.state === 'uncertain'
                }
                onClick={() => void action('advance')}
              >
                {run.state === 'capturing' ? 'continue capturing input' : 'continue saved work'}
                <Icon name="arrow" size={14} />
              </button>
            )}
        </div>
        {!terminal && (
          <details className="templates__disclosure">
            <summary>stop unsent work</summary>
            <p>
              cancel stops unissued steps. already dispatched work must settle, and confirmed output
              remains. this cannot undo a copy.
            </p>
            <label className="templates__check">
              <input
                type="checkbox"
                checked={cancel}
                onChange={(event) => setCancel(event.target.checked)}
              />
              keep existing output and cancel remaining work
            </label>
            <button
              className="templates__danger"
              type="button"
              disabled={
                busy || running || connection !== 'reachable' || !cancel || !localWritable(account)
              }
              onClick={() => void action('cancel')}
            >
              cancel remaining work
            </button>
          </details>
        )}
      </div>
    </Dialog>
  );
}
