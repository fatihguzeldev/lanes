import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import {
  AccountLifecycleStatusSchema,
  DisconnectStatusSchema,
  RemovalStatusSchema,
  type AccountLifecycleStatus,
  type DisconnectStatus,
  type RemovalStatus,
} from '../modules/accounts/lifecycle-contract';
import { Dialog } from '../ui/Dialog';
import { checkServerConnection, request } from '../client/http';
import { useServerConnection } from '../client/useServerConnection';
interface Props {
  account: ConnectionSummary;
  onClose: () => void;
  onChanged: () => void;
}
export function AccountLifecycleDialog({ account, onClose, onChanged }: Props) {
  const [status, setStatus] = useState<AccountLifecycleStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [choice, setChoice] = useState<'disconnect' | 'remove' | null>(null),
    [email, setEmail] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const controller = useRef<AbortController | null>(null),
    changed = useRef(onChanged);
  changed.current = onChanged;
  const connection = useServerConnection(),
    base = `/api/accounts/${encodeURIComponent(account.id)}/lifecycle`;
  const read = async (signal?: AbortSignal) => {
    const value = await request(base, AccountLifecycleStatusSchema, signal ? { signal } : {});
    setStatus(value);
    return value;
  };
  useEffect(() => {
    const abort = new AbortController();
    void read(abort.signal).catch((error) => {
      if (!abort.signal.aborted)
        setError(error instanceof Error ? error.message : 'account progress could not load.');
    });
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, [base]);
  const follow = async (kind: 'disconnect' | 'remove', signal: AbortSignal) => {
    const until = Date.now() + 30_000;
    while (!signal.aborted && Date.now() < until) {
      const value = await request<DisconnectStatus | RemovalStatus>(
        `${base}/${kind}/advance`,
        kind === 'disconnect' ? DisconnectStatusSchema : RemovalStatusSchema,
        { method: 'POST', body: {}, signal },
      );
      const next = await read(signal);
      if (kind === 'disconnect' && next.disconnect && !next.disconnect.pending) {
        changed.current();
        return;
      }
      if (kind === 'remove' && next.removal?.state === 'completed') return;
      if ('state' in value && value.state === 'blocked' && !value.nextAttemptAt) return;
      const wait = Math.max(350, (value.nextAttemptAt ?? 0) - Date.now());
      if (Date.now() + wait >= until) return;
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve();
        }, wait);
        signal.addEventListener('abort', stop, { once: true });
      });
    }
  };
  const run = async (kind: 'disconnect' | 'remove', start: boolean) => {
    if (busy || connection !== 'reachable') return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    try {
      if (start) {
        if (!confirmed || email.trim().toLowerCase() !== account.email.toLowerCase()) return;
        if (kind === 'disconnect')
          await request(`${base}/disconnect`, DisconnectStatusSchema, {
            method: 'POST',
            body: { confirm: true },
            signal: abort.signal,
          });
        else
          await request(`${base}/remove`, RemovalStatusSchema, {
            method: 'POST',
            body: { confirm: true, revision: account.revision },
            signal: abort.signal,
          });
        setChoice(null);
        setConfirmed(false);
        setEmail('');
        await read(abort.signal);
        changed.current();
      }
      await follow(kind, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'account work stopped before its next checkpoint.',
        );
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const disconnected =
      status?.disconnect?.state === 'disconnected' || account.state === 'disconnected',
    removing = !!status?.removal && status.removal.state !== 'completed',
    removed = status?.removal?.state === 'completed';
  const choose = (kind: 'disconnect' | 'remove') => {
    setChoice(kind);
    setEmail('');
    setConfirmed(false);
    setError('');
  };
  return (
    <Dialog
      title={removed ? 'local account data removed' : 'account connection'}
      onClose={() => {
        if (removed) onChanged();
        onClose();
      }}
      wide
      pending={busy && !status?.disconnect && !status?.removal}
    >
      <div className="dialog__body">
        <p>
          <strong>{account.email}</strong>
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
        {!removed && (
          <p>
            disconnect pauses admitted work and removes this installation’s stored grant. your
            google tasks, lists and retained lanes workspace stay in place. reconnecting is a
            separate action.
          </p>
        )}
        {status?.disconnect && (
          <section aria-label="disconnect progress">
            <h3>{status.disconnect.pending ? 'disconnecting…' : 'disconnected'}</h3>
            <p>
              {status.disconnect.pausedOwners}/{status.disconnect.totalOwners} local owners paused.
              google revocation: {status.disconnect.remoteRevocation.replaceAll('_', ' ')}.
            </p>
            {status.disconnect.remoteRevocation === 'failed' && (
              <p>
                local disconnect completed even though google could not confirm remote revocation.
              </p>
            )}
            {status.disconnect.pending && (
              <button
                disabled={busy || connection !== 'reachable'}
                onClick={() => void run('disconnect', false)}
              >
                continue disconnect
              </button>
            )}
          </section>
        )}
        {status?.removal && (
          <section aria-label="local removal progress">
            <h3>{removed ? 'removal complete' : `removal ${status.removal.state}`}</h3>
            <p>
              at least {status.removal.deletedRecords} local records acknowledged as removed.
              {status.removal.owner ? ` current owner: ${status.removal.owner}.` : ''}
            </p>
            <small>receipt: {status.removal.id}</small>
            {status.removal.errorCode && (
              <p className="error">
                {status.removal.errorCode === 'outcome_uncertain'
                  ? 'issued provider outcomes still need their evidence. reconnect and resolve them before local removal can continue.'
                  : status.removal.errorCode.replaceAll('_', ' ')}
              </p>
            )}
            {!removed && (
              <button
                disabled={busy || connection !== 'reachable'}
                onClick={() => void run('remove', false)}
              >
                continue local removal
              </button>
            )}
          </section>
        )}
        {removed && (
          <p>
            google content was not deleted. this receipt remains available without restoring the
            removed workspace.
          </p>
        )}
        {!removed && !removing && !status?.disconnect?.pending && (
          <div className="board-options__order">
            {!disconnected && (
              <button
                disabled={busy || connection !== 'reachable'}
                onClick={() => choose('disconnect')}
              >
                disconnect account
              </button>
            )}
            {disconnected && (
              <button
                className="danger"
                disabled={busy || connection !== 'reachable'}
                onClick={() => choose('remove')}
              >
                remove local workspace data
              </button>
            )}
          </div>
        )}
        {choice && (
          <section className="account-lifecycle__confirm">
            <h3>
              {choice === 'disconnect'
                ? 'disconnect this account?'
                : 'remove its local workspace data?'}
            </h3>
            <p>
              {choice === 'disconnect'
                ? 'issued requests settle first. unsent work pauses; google content and lanes history remain.'
                : 'this removes boards, labels, schedules, templates, captured work and retained history for this account from this lanes instance. it does not delete google tasks or lists. this local removal cannot be undone through lanes.'}
            </p>
            <label>
              type the account email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{' '}
                {choice === 'disconnect'
                  ? 'pause work and disconnect this account'
                  : 'remove this account’s local data'}
              </span>
            </label>
            <button
              className={choice === 'remove' ? 'danger' : 'primary'}
              disabled={
                busy ||
                !confirmed ||
                email.trim().toLowerCase() !== account.email.toLowerCase() ||
                connection !== 'reachable'
              }
              onClick={() => void run(choice, true)}
            >
              {choice === 'disconnect' ? 'disconnect' : 'remove local data'}
            </button>
          </section>
        )}
        {busy && (
          <p role="status">
            saving the next bounded checkpoint… you can leave after this work is admitted.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            onClick={() => {
              if (removed) onChanged();
              onClose();
            }}
          >
            close
          </button>
          <button
            disabled={busy || connection !== 'reachable'}
            onClick={() =>
              void read().catch((error) =>
                setError(
                  error instanceof Error ? error.message : 'account progress could not load.',
                ),
              )
            }
          >
            refresh progress
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
