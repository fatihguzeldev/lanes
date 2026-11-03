import { useEffect, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import {
  ResolutionCandidatesSchema,
  ResolutionContextSchema,
  ResolutionPreviewSchema,
  type ResolutionCandidate,
  type ResolutionContext,
  type ResolutionPreview,
} from '../modules/tasks/resolution-contract';
import { OperationSummarySchema } from '../modules/tasks/operation-contract';
import { Dialog } from '../ui/Dialog';
import { checkServerConnection, request } from './http';
import { useServerConnection } from './useServerConnection';
interface Props {
  account: ConnectionSummary;
  operationId: string;
  onClose: () => void;
  onResolved: () => void;
}
export function OperationResolutionDialog({ account, operationId, onClose, onResolved }: Props) {
  const [context, setContext] = useState<ResolutionContext | null>(null),
    [candidates, setCandidates] = useState<ResolutionCandidate[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState(''),
    [preview, setPreview] = useState<ResolutionPreview | null>(null),
    [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const connection = useServerConnection(),
    base = `/api/accounts/${encodeURIComponent(account.id)}/operations/${encodeURIComponent(operationId)}/resolution`;
  const writable = account.state === 'connected' && connection === 'reachable';
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setContext(null);
    setPreview(null);
    setCandidates([]);
    setCursor(null);
    setCandidateId('');
    setIdentityConfirmed(false);
    void request(base, ResolutionContextSchema, { signal: controller.signal })
      .then(setContext)
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'this outcome could not be inspected.');
      });
    return () => controller.abort();
  }, [base, reload]);
  const work = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'this outcome could not be resolved.');
    } finally {
      setBusy(false);
    }
  };
  const loadCandidates = (append: boolean) =>
    void work(async () => {
      const page = await request(`${base}/candidates`, ResolutionCandidatesSchema, {
        method: 'POST',
        body: append && cursor ? { cursor } : {},
      });
      setContext(page.context);
      setCursor(page.nextCursor);
      setCandidates((previous) => [
        ...new Map(
          [...(append ? previous : []), ...page.items].map((item) => [item.providerId, item]),
        ).values(),
      ]);
    });
  const check = (decision: 'adopt' | 'keep_provider_current' = 'adopt') =>
    void work(async () => {
      const result = await request(`${base}/preview`, ResolutionPreviewSchema, {
        method: 'POST',
        body: { decision, ...(candidateId ? { candidateId } : {}) },
      });
      setPreview(result);
      setIdentityConfirmed(false);
    });
  return (
    <Dialog title="resolve this provider outcome" onClose={onClose} wide pending={busy}>
      <div className="dialog__body operation-resolution">
        <p>
          {account.email}. a request may have reached google. check its current state before
          recording a result or stopping the remaining work.
        </p>
        {connection !== 'reachable' && (
          <p role="status">
            the server connection is paused.{' '}
            <button
              onClick={() => {
                if (connection === 'incompatible') window.location.reload();
                else
                  void checkServerConnection().catch((error) =>
                    setError(
                      error instanceof Error ? error.message : 'the server is still unavailable.',
                    ),
                  );
              }}
            >
              {connection === 'incompatible' ? 'reload lanes' : 'check connection'}
            </button>
          </p>
        )}
        {!context && !error && <p role="status">reading the issued step…</p>}
        {context && (
          <>
            <p>
              <strong>{context.action.replaceAll('.', ' · ')}</strong> ·{' '}
              {context.title || 'untitled'}
              {context.listTitle ? ` · ${context.listTitle}` : ''}
            </p>
            {context.claimActive && (
              <p>
                the original request still has an active worker claim. wait for it to settle, then{' '}
                <button onClick={() => setReload((value) => value + 1)}>check again</button>.
              </p>
            )}
            {!writable && connection === 'reachable' && (
              <p>reconnect this google account before reading or resolving its provider state.</p>
            )}
            {context.needsCandidate && !context.hasRecordedResponse && (
              <>
                <p>
                  identify the exact created or moved resource. equal titles and notes do not
                  establish identity.{' '}
                  <a href="https://tasks.google.com/" target="_blank" rel="noreferrer">
                    open google tasks
                  </a>
                </p>
                <button
                  disabled={busy || !writable || context.claimActive}
                  onClick={() => loadCandidates(false)}
                >
                  read candidate resources
                </button>
                {candidates.length > 0 && (
                  <label>
                    observed candidates
                    <select
                      value={candidateId}
                      onChange={(event) => {
                        setCandidateId(event.target.value);
                        setPreview(null);
                        setIdentityConfirmed(false);
                      }}
                    >
                      <option value="">choose a resource</option>
                      {candidates.map((candidate) => (
                        <option value={candidate.providerId} key={candidate.providerId}>
                          {candidate.title || 'untitled'}
                          {candidate.alreadyRetained ? ' · already retained' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {cursor && (
                  <button disabled={busy || !writable} onClick={() => loadCandidates(true)}>
                    more candidates
                  </button>
                )}
                <label>
                  exact google resource id
                  <input
                    value={candidateId}
                    onChange={(event) => {
                      setCandidateId(event.target.value);
                      setPreview(null);
                      setIdentityConfirmed(false);
                    }}
                    maxLength={2048}
                    spellCheck={false}
                  />
                </label>
              </>
            )}
            {context.hasRecordedResponse && (
              <p>
                the returned provider receipt is retained. resume its local repair after restoring
                access; no identity matching or creation is needed.
              </p>
            )}
            <button
              disabled={
                busy ||
                !writable ||
                context.claimActive ||
                (context.needsCandidate && !context.hasRecordedResponse && !candidateId)
              }
              onClick={() => check()}
            >
              {busy ? 'checking…' : 'check current result'}
            </button>
          </>
        )}
        {preview && (
          <section aria-label="verified outcome preview">
            {preview.candidate && (
              <>
                <h3>{preview.candidate.title || 'untitled resource'}</h3>
                <dl>
                  <dt>google id</dt>
                  <dd>{preview.candidate.providerId}</dd>
                  <dt>state</dt>
                  <dd>{preview.candidate.completed ? 'completed' : 'open'}</dd>
                  <dt>scheduled day</dt>
                  <dd>{preview.candidate.scheduledDay ?? 'none'}</dd>
                  {preview.candidate.parentId && (
                    <>
                      <dt>parent google id</dt>
                      <dd>{preview.candidate.parentId}</dd>
                    </>
                  )}
                </dl>
                {preview.candidate.notes && <pre>{preview.candidate.notes}</pre>}
              </>
            )}
            {preview.stopExplanation && <p role="status">{preview.stopExplanation}</p>}
            {preview.candidate?.alreadyRetained && (
              <p>
                this resource is already in lanes. keeping its current state preserves its existing
                organization and metadata.
              </p>
            )}
            {preview.canKeepProviderCurrent && preview.decision !== 'keep_provider_current' && (
              <button disabled={busy || !writable} onClick={() => check('keep_provider_current')}>
                review current google state and stop
              </button>
            )}
            {preview.reason && (
              <p className="error" role="alert">
                {preview.reason}
              </p>
            )}
            {preview.canConfirm &&
              preview.context.needsCandidate &&
              !preview.context.hasRecordedResponse && (
                <label>
                  <span>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={identityConfirmed}
                      onChange={(event) => setIdentityConfirmed(event.target.checked)}
                    />{' '}
                    {preview.decision === 'keep_provider_current'
                      ? 'i checked this exact google resource and want to keep its current state. stop the remaining work without merging its identity with another task.'
                      : 'i identified this exact resource as the result of this issued request. its title alone is not my evidence.'}
                  </span>
                </label>
              )}
            {preview.canConfirm && !preview.candidate && !preview.context.hasRecordedResponse && (
              <p>google confirms absence at the exact captured address.</p>
            )}
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!context && error && (
          <button onClick={() => setReload((value) => value + 1)}>inspect again</button>
        )}
        <footer>
          <button disabled={busy} onClick={onClose}>
            close
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !writable ||
              !preview?.canConfirm ||
              (preview.context.needsCandidate &&
                !preview.context.hasRecordedResponse &&
                !identityConfirmed)
            }
            onClick={() =>
              void work(async () => {
                if (!preview) return;
                await request(`${base}/confirm`, OperationSummarySchema, {
                  method: 'POST',
                  body: {
                    previewHash: preview.previewHash,
                    decision: preview.decision,
                    confirm: true,
                    ...(candidateId ? { candidateId } : {}),
                    ...(identityConfirmed ? { confirmIdentity: true } : {}),
                  },
                });
                onResolved();
              })
            }
          >
            {preview?.decision === 'keep_provider_current'
              ? 'keep google state and stop'
              : 'record result and repair'}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
