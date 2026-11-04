import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import { TaskListSchema, type TaskList } from '../modules/tasks/contracts';
import {
  OperationIdSchema,
  OperationSummarySchema,
  type OperationSummary,
} from '../modules/tasks/operation-contract';
import {
  CompletedDeletionPageSchema,
  CompletedDeletionPreviewPageSchema,
  CompletedDeletionSummarySchema,
  type CompletedDeletionSummary,
} from '../modules/tasks/completed-deletion-contract';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { request, RequestError } from '../client/http';
import { newOperationId } from '../client/operation-identity';
import { usePagedResource } from '../client/usePagedResource';
import { useServerConnection } from '../client/useServerConnection';
import { CompletedDeletionConfirmation } from './CompletedDeletionConfirmation';
import {
  completedDeletionAcknowledged,
  mayAdvanceCompletedDeletion,
  type CompletedDeletionAcknowledgements,
} from './completed-deletion-model';
import './CompletedDeletionDialog.css';

const unconfirmed: CompletedDeletionAcknowledgements = {
  permanent: false,
  openChildren: false,
  assignments: false,
};
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(done, 350);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function CompletedDeletionDialog({
  account,
  list,
  clockOffset,
  onClose,
  onChanged,
  onInspect,
}: {
  account: ConnectionSummary;
  list: TaskList;
  clockOffset: number;
  onClose(): void;
  onChanged(): void;
  onInspect(operationId: string): void;
}) {
  const connection = useServerConnection();
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [summary, setSummary] = useState<CompletedDeletionSummary | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reviewVersion, setReviewVersion] = useState(0);
  const [acknowledgements, setAcknowledgements] = useState(unconfirmed),
    [freshAcknowledged, setFreshAcknowledged] = useState(false);
  const [beginAttempted, setBeginAttempted] = useState(false);
  const [currentOperation, setCurrentOperation] = useState<OperationSummary | null>(null);
  const flight = useRef<AbortController | null>(null),
    working = useRef(false);
  const beginInput = useRef<{ id: string; listRevision: number } | null>(null);
  const base = `/api/accounts/${encodeURIComponent(account.id)}/lists/${encodeURIComponent(list.id)}/completed-deletions`;
  const scoped = list.accountId === account.id;
  const reachable = connection === 'reachable' && scoped;
  const writable = reachable && account.state === 'connected' && account.permissions.tasks;
  const recent = usePagedResource(
    scoped ? `${account.id}:${list.id}:completed-deletions` : null,
    (cursor, signal) =>
      request(
        `${base}?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        CompletedDeletionPageSchema,
        { signal },
      ),
    (value) => value.id,
    reviewVersion,
  );
  const records = usePagedResource(
    selectedId ? `${account.id}:${list.id}:completed-deletion:${selectedId}` : null,
    (cursor, signal) =>
      request(
        `${base}/${encodeURIComponent(selectedId!)}/preview?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        CompletedDeletionPreviewPageSchema,
        { signal },
      ),
    (value) => value.taskId,
    reviewVersion,
  );
  useEffect(() => () => flight.current?.abort(), [account.id, list.id]);
  useEffect(() => {
    setAcknowledgements(unconfirmed);
  }, [summary?.id, summary?.previewHash]);
  const checked = (value: CompletedDeletionSummary, id: string) => {
    if (value.accountId !== account.id || value.listId !== list.id || value.id !== id)
      throw new Error('this deletion result belongs to a different selection.');
    return value;
  };
  const perform = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (working.current || !reachable) return;
    const controller = new AbortController();
    flight.current = controller;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action(controller.signal);
    } catch (cause) {
      const existing = OperationIdSchema.safeParse(
        cause instanceof RequestError ? cause.fields?.deletionId : undefined,
      );
      if (!controller.signal.aborted && existing.success) {
        try {
          const value = checked(
            await request(
              `${base}/${encodeURIComponent(existing.data)}`,
              CompletedDeletionSummarySchema,
              { signal: controller.signal },
            ),
            existing.data,
          );
          if (!controller.signal.aborted) {
            setSelectedId(value.id);
            setSummary(value);
          }
        } catch {
          /* Keep the original conflict visible; retained results can be read again. */
        }
      }
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'this deletion could not be checked. inspect the retained preview before retrying.',
        );
    } finally {
      working.current = false;
      if (!controller.signal.aborted) {
        setBusy(false);
        setReviewVersion((value) => value + 1);
      }
    }
  };
  const drive = async (
    current: CompletedDeletionSummary,
    kind: 'capture' | 'advance',
    signal: AbortSignal,
  ) => {
    const deadline = Date.now() + 30_000;
    let lastChanged = 0,
      lastOperationRead = 0,
      operationId = '';
    while (
      !signal.aborted &&
      Date.now() < deadline &&
      current.state === (kind === 'capture' ? 'capturing' : 'running')
    ) {
      if (
        kind === 'advance' &&
        current.operationId &&
        (current.operationId !== operationId || Date.now() - lastOperationRead >= 2_000)
      ) {
        const operation = await request(
          `/api/accounts/${encodeURIComponent(account.id)}/operations/${encodeURIComponent(current.operationId)}`,
          OperationSummarySchema,
          { signal },
        );
        if (operation.accountId !== account.id || operation.id !== current.operationId)
          throw new Error('this provider operation belongs to a different deletion.');
        if (signal.aborted) return;
        setCurrentOperation(operation);
        operationId = operation.id;
        lastOperationRead = Date.now();
        if (
          !operation.finished &&
          !mayAdvanceCompletedDeletion(operation, Date.now() + clockOffset)
        )
          break;
      }
      current = checked(
        await request(
          `${base}/${encodeURIComponent(current.id)}/${kind}`,
          CompletedDeletionSummarySchema,
          { method: 'POST', body: {}, signal },
        ),
        current.id,
      );
      if (signal.aborted) return;
      setSummary(current);
      if (kind === 'advance' && Date.now() - lastChanged > 1500) {
        onChanged();
        lastChanged = Date.now();
      }
      if (current.state === (kind === 'capture' ? 'capturing' : 'running')) await pause(signal);
    }
    if (!signal.aborted && kind === 'advance') onChanged();
  };
  const prepare = () =>
    void perform(async (signal) => {
      if (!beginInput.current) {
        const latest = await request(
          `/api/accounts/${encodeURIComponent(account.id)}/lists/${encodeURIComponent(list.id)}`,
          TaskListSchema,
          { signal },
        );
        if (latest.accountId !== account.id)
          throw new Error('this list belongs to a different account.');
        beginInput.current = { id: newOperationId(clockOffset), listRevision: latest.revision };
      }
      setBeginAttempted(true);
      const input = beginInput.current;
      const value = checked(
        await request(base, CompletedDeletionSummarySchema, {
          method: 'POST',
          body: input,
          signal,
        }),
        input.id,
      );
      if (signal.aborted) return;
      setSelectedId(value.id);
      setSummary(value);
      setFreshAcknowledged(false);
      await drive(value, 'capture', signal);
    });
  const read = (id: string) =>
    void perform(async (signal) => {
      const value = checked(
        await request(`${base}/${encodeURIComponent(id)}`, CompletedDeletionSummarySchema, {
          signal,
        }),
        id,
      );
      if (!signal.aborted) {
        setSelectedId(id);
        setSummary(value);
      }
    });
  const runAction = (kind: 'capture' | 'advance' | 'resume' | 'cancel' | 'confirm') =>
    void perform(async (signal) => {
      if (!summary) return;
      if (['confirm', 'resume', 'advance'].includes(kind) && !writable) return;
      if (
        kind === 'confirm' &&
        (!summary.previewHash || !completedDeletionAcknowledged(summary, acknowledgements))
      )
        return;
      const value = checked(
        await request(
          `${base}/${encodeURIComponent(summary.id)}/${kind}`,
          CompletedDeletionSummarySchema,
          {
            method: 'POST',
            body:
              kind === 'confirm'
                ? {
                    previewHash: summary.previewHash,
                    confirm: true,
                    confirmOpenDescendantCount: summary.openDescendantCount,
                    confirmAssignedTaskCount: summary.assignedTaskCount,
                  }
                : {},
            signal,
          },
        ),
        summary.id,
      );
      if (signal.aborted) return;
      setSummary(value);
      onChanged();
      if (kind !== 'cancel') await drive(value, kind === 'capture' ? 'capture' : 'advance', signal);
    });
  const retained = recent.items.filter(
    (value) => value.accountId === account.id && value.listId === list.id,
  );
  const retainedUnfinished = retained.some((value) => value.finishedAt === null);
  const finished = summary?.finishedAt !== null && summary?.finishedAt !== undefined;
  const confirmable =
    !!summary &&
    summary.state === 'preview' &&
    summary.coverageComplete &&
    summary.previewHash !== null &&
    records.loaded &&
    records.status === 'ready' &&
    !records.error &&
    completedDeletionAcknowledged(summary, acknowledgements);
  const freshAllowed = !summary || finished;
  return (
    <Dialog title="delete completed tasks" wide onClose={onClose}>
      <div className="dialog__body completed-deletion">
        <p>
          {summary?.listTitle || list.title || 'untitled list'} · {account.email}
        </p>
        <p>
          this permanently deletes selected tasks from google. the list stays in place. completed
          parents include their subtasks, including open ones; inspect the frozen selection first.
        </p>
        {!reachable && (
          <p className="error" role="status">
            {!scoped
              ? 'this list belongs to a different account.'
              : 'the server connection is paused. retained previews stay on the server.'}
          </p>
        )}
        {!writable && reachable && (
          <p role="status">reconnect this account before confirming or continuing deletion.</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p role="status">
            {summary?.state === 'capturing'
              ? 'preparing your selection…'
              : summary?.state === 'running'
                ? 'recording confirmed deletion progress…'
                : 'checking the retained preview…'}
          </p>
        )}
        {summary ? (
          <>
            <section className="completed-deletion__summary" aria-label="frozen deletion preview">
              <h3>{summary.state.replaceAll('_', ' ')}</h3>
              <dl>
                <div>
                  <dt>completed tasks selected</dt>
                  <dd>{summary.selectedCompletedCount}</dd>
                </div>
                <div>
                  <dt>open subtasks included</dt>
                  <dd>{summary.openDescendantCount}</dd>
                </div>
                <div>
                  <dt>total tasks to delete</dt>
                  <dd>{summary.totalDeleteCount}</dd>
                </div>
                <div>
                  <dt>source assignments</dt>
                  <dd>{summary.assignedTaskCount}</dd>
                </div>
              </dl>
              {summary.state === 'capturing' && (
                <p>
                  {summary.capturedCount}/{summary.totalDeleteCount} task references captured. no
                  provider deletion is sent before confirmation.
                </p>
              )}
              {summary.state !== 'capturing' && !summary.coverageComplete && (
                <p className="error">
                  the source coverage is incomplete. refresh the account before preparing another
                  preview.
                </p>
              )}
              {summary.error && (
                <p className="error" role="alert">
                  {summary.error.message}
                </p>
              )}
              {summary.state === 'stale' && (
                <p className="error">
                  the frozen source changed. this preview will not rebase or delete new tasks
                  automatically. review confirmed results before preparing another preview.
                </p>
              )}
              {summary.state === 'preview' && (
                <CompletedDeletionConfirmation
                  counts={summary}
                  acknowledgements={acknowledgements}
                  onChange={setAcknowledgements}
                  disabled={busy || !writable}
                />
              )}
              {!['capturing', 'preview'].includes(summary.state) && (
                <p role="status">
                  {summary.deletedCount}{' '}
                  {summary.deletedCount === 1 ? 'task deletion' : 'task deletions'} confirmed ·{' '}
                  {summary.deletedRootCount}/{summary.rootCount} root deletions confirmed ·{' '}
                  {summary.failedRootCount} roots failed · {summary.pendingRootCount} roots remain.
                  confirmed deletions stay deleted when work stops.
                </p>
              )}
              {summary.state === 'uncertain' && (
                <p>
                  check the last deletion below before continuing. do not start another deletion to
                  retry it.
                </p>
              )}
              {summary.operationId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onInspect(summary.operationId!)}
                >
                  inspect current operation
                </button>
              )}
              {currentOperation?.id === summary.operationId && (
                <p>
                  current operation: {currentOperation.state.replaceAll('_', ' ')} ·{' '}
                  {currentOperation.confirmedSteps}/{currentOperation.totalSteps} steps confirmed
                  {currentOperation.nextAttemptAt &&
                  currentOperation.nextAttemptAt > Date.now() + clockOffset
                    ? ` · next attempt after ${new Date(currentOperation.nextAttemptAt).toISOString()}`
                    : ''}
                  . {currentOperation.error?.message}
                </p>
              )}
            </section>
            <details className="completed-deletion__records" open>
              <summary>
                affected tasks · {records.items.length}
                {records.nextCursor ? ' loaded' : ''}
              </summary>
              <ol>
                {records.items.map((item) => (
                  <li key={item.taskId}>
                    <Icon name={item.completed ? 'check' : 'subtasks'} size={13} />
                    <div>
                      <span>
                        {item.title ||
                          (item.payloadRetained
                            ? 'untitled task'
                            : 'source title no longer retained')}
                      </span>
                      <small>
                        {item.isRoot ? 'root deletion' : 'included subtask'} ·{' '}
                        {item.completed ? 'completed' : 'open'}
                        {item.assignmentSource
                          ? ` · assigned from ${item.assignmentSource}`
                          : ''} · {item.state}
                      </small>
                      {!item.payloadRetained && <small>task {item.taskId}</small>}
                      {item.error && <p className="error">{item.error.message}</p>}
                      {item.operationId && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onInspect(item.operationId!)}
                        >
                          inspect operation
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {records.status === 'loading' && <p role="status">loading frozen task references…</p>}
              {records.error && (
                <p className="error" role="alert">
                  {records.error}{' '}
                  <button
                    type="button"
                    disabled={records.status === 'loading'}
                    onClick={() => void records.reload()}
                  >
                    retry task references
                  </button>
                </p>
              )}
              {records.nextCursor && (
                <button
                  type="button"
                  disabled={records.status === 'loading'}
                  onClick={() => void records.loadMore()}
                >
                  more affected tasks
                </button>
              )}
            </details>
            <div className="completed-deletion__actions">
              <button type="button" disabled={busy || !reachable} onClick={() => read(summary.id)}>
                refresh result
              </button>
              {summary.state === 'capturing' && (
                <button
                  type="button"
                  disabled={busy || !reachable}
                  onClick={() => runAction('capture')}
                >
                  continue preview capture
                </button>
              )}
              {summary.state === 'preview' && summary.totalDeleteCount > 0 && (
                <button
                  type="button"
                  className="completed-deletion__delete"
                  disabled={busy || !writable || !confirmable}
                  onClick={() => runAction('confirm')}
                >
                  permanently delete {summary.totalDeleteCount}{' '}
                  {summary.totalDeleteCount === 1 ? 'task' : 'tasks'}
                </button>
              )}
              {summary.state === 'running' && (
                <button
                  type="button"
                  disabled={busy || !writable}
                  onClick={() => runAction('advance')}
                >
                  continue deletion
                </button>
              )}
              {['paused', 'uncertain', 'partial'].includes(summary.state) && !finished && (
                <button
                  type="button"
                  disabled={busy || !writable}
                  onClick={() => runAction('resume')}
                >
                  check and continue remaining work
                </button>
              )}
              {!finished && (
                <button
                  type="button"
                  disabled={busy || !reachable}
                  onClick={() => runAction('cancel')}
                >
                  {summary.state === 'cancelled'
                    ? 'reconcile stopped result'
                    : summary.state === 'stale'
                      ? 'close this stale preview'
                      : ['capturing', 'preview'].includes(summary.state)
                        ? 'cancel this preview'
                        : 'stop unsent deletions'}
                </button>
              )}
            </div>
            {freshAllowed && (
              <label className="completed-deletion__fresh">
                <input
                  type="checkbox"
                  checked={freshAcknowledged}
                  onChange={(event) => setFreshAcknowledged(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  i reviewed this result. prepare a new selection from the list's current state.
                </span>
              </label>
            )}
            {freshAllowed && (
              <button
                type="button"
                disabled={busy || !writable || !freshAcknowledged}
                onClick={() => {
                  beginInput.current = null;
                  setBeginAttempted(false);
                  prepare();
                }}
              >
                prepare a fresh preview
              </button>
            )}
          </>
        ) : (
          <>
            {retained.length > 0 && (
              <section className="completed-deletion__recent">
                <h3>retained previews and results</h3>
                <ul>
                  {retained.map((value) => (
                    <li key={value.id}>
                      <button
                        type="button"
                        disabled={busy || !reachable}
                        onClick={() => read(value.id)}
                      >
                        <span>
                          {value.state} · {value.deletedCount}/{value.totalDeleteCount} task
                          {value.totalDeleteCount === 1 ? 'deletion' : 'deletions'} confirmed
                        </span>
                        <small>{new Date(value.createdAt).toLocaleString()}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {recent.status === 'loading' && (
              <p role="status">checking earlier deletion attempts…</p>
            )}
            {recent.error && (
              <p className="error" role="alert">
                {recent.error}{' '}
                <button type="button" onClick={() => void recent.reload()}>
                  retry earlier results
                </button>
              </p>
            )}
            {recent.nextCursor && (
              <button
                type="button"
                disabled={recent.status === 'loading'}
                onClick={() => void recent.loadMore()}
              >
                older results
              </button>
            )}
            <p>
              preparing a preview captures the current selection and sends no deletion requests. an
              existing attempt keeps its own frozen input.
            </p>
            {retainedUnfinished && !beginAttempted && (
              <p>review the unfinished attempt above before preparing another deletion.</p>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !writable ||
                !recent.loaded ||
                !!recent.error ||
                (retainedUnfinished && !beginAttempted)
              }
              onClick={prepare}
            >
              {beginAttempted ? 'retry the same preview capture' : 'prepare deletion preview'}
            </button>
          </>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            close
          </button>
        </footer>
        <p className="completed-deletion__note">
          closing stops this browser's progress checks. the preview and admitted work remain
          available here; closing does not undo confirmed deletions.
        </p>
      </div>
    </Dialog>
  );
}
