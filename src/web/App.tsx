import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Brand } from '../ui/Brand';
import {
  AccountPageSchema,
  SessionSnapshotSchema,
  OAuthStartResponseSchema,
} from '../modules/accounts/session-contract';
import type { SessionSnapshot } from '../modules/accounts/session-contract';
import { request, RequestError } from './http';
import './App.css';
import { useTheme } from './theme';
import { z } from 'zod';
import { ConnectionSummarySchema } from '../modules/accounts/contracts';
import { oauthLandingError, portabilityLanding } from './landing';
const Workspace = lazy(() =>
  import('./Workspace').then((module) => ({ default: module.Workspace })),
);

export function App() {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [authorizationError, setAuthorizationError] = useState(oauthLandingError);
  const [pending, setPending] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(() => {
    const landing = portabilityLanding();
    if (landing) return landing.accountId;
    try {
      return sessionStorage.getItem('lanes.account') ?? localStorage.getItem('lanes.account');
    } catch {
      return null;
    }
  });
  const selectedAccountId = useRef(accountId);
  selectedAccountId.current = accountId;
  const channel = useRef<BroadcastChannel | null>(null);
  const sessionFlight = useRef<AbortController | null>(null);
  const [theme, setTheme] = useTheme();
  const [clockOffset, setClockOffset] = useState(0);
  const load = useCallback(async () => {
    sessionFlight.current?.abort();
    const flight = new AbortController();
    sessionFlight.current = flight;
    setError('');
    try {
      const next = await request('/api/session', SessionSnapshotSchema, { signal: flight.signal });
      let removedId: string | null = null;
      if (
        next.authenticated &&
        next.accounts &&
        selectedAccountId.current &&
        !next.accounts.items.some((account) => account.id === selectedAccountId.current)
      ) {
        try {
          next.accounts.items.push(
            await request(
              '/api/accounts/' + encodeURIComponent(selectedAccountId.current),
              ConnectionSummarySchema,
              { signal: flight.signal },
            ),
          );
        } catch (error) {
          if (flight.signal.aborted) return;
          if (error instanceof RequestError && error.code === 'not_found') {
            removedId = selectedAccountId.current;
            setAccountId(null);
          } else throw error;
        }
      }
      if (flight.signal.aborted) return;
      setClockOffset(next.serverTime - Date.now());
      setSession((previous) =>
        next.authenticated && next.accounts && previous?.authenticated && previous.accounts
          ? {
              ...next,
              accounts: {
                ...next.accounts,
                items: [
                  ...new Map(
                    [
                      ...previous.accounts.items.filter((account) => account.id !== removedId),
                      ...next.accounts.items,
                    ].map((account) => [account.id, account]),
                  ).values(),
                ],
              },
            }
          : next,
      );
    } catch (error) {
      if (!flight.signal.aborted)
        setError(error instanceof Error ? error.message : 'lanes could not load this workspace.');
    }
  }, []);
  useEffect(() => {
    void load();
    return () => sessionFlight.current?.abort();
  }, [load, accountId]);
  useEffect(() => {
    const clearPrivate = () => {
      sessionFlight.current?.abort();
      setSession(null);
    };
    const expired = () => {
      clearPrivate();
      void load();
    };
    window.addEventListener('lanes.session-expired', expired);
    if (typeof BroadcastChannel !== 'undefined') {
      const connection = new BroadcastChannel('lanes.session');
      channel.current = connection;
      connection.onmessage = (event) => {
        if (event.data?.type === 'signout') {
          clearPrivate();
          setAccountId(null);
          try {
            sessionStorage.removeItem('lanes.account');
          } catch {
            /* Private UI is already cleared. */
          }
          void load();
        } else if (event.data?.type === 'account-changed') void load();
      };
    }
    return () => {
      window.removeEventListener('lanes.session-expired', expired);
      channel.current?.close();
      channel.current = null;
    };
  }, [load]);
  const selectAccount = (id: string) => {
    try {
      sessionStorage.setItem('lanes.account', id);
      localStorage.setItem('lanes.account', id);
    } catch {
      /* Selection remains usable when storage is unavailable. */
    }
    setAccountId(id);
  };
  const signOut = () => {
    void request('/auth/signout', z.object({ signedOut: z.literal(true) }), {
      method: 'POST',
      body: {},
    })
      .then(() => {
        sessionFlight.current?.abort();
        setSession(null);
        try {
          sessionStorage.removeItem('lanes.account');
          localStorage.removeItem('lanes.account');
        } catch {
          /* Server sign-out remains authoritative. */
        }
        setAccountId(null);
        channel.current?.postMessage({ type: 'signout' });
        return load();
      })
      .catch((error) =>
        setError(error instanceof Error ? error.message : 'sign out could not finish.'),
      );
  };
  const authorize = async (purpose: 'signin' | 'link' | 'reconnect', targetAccountId?: string) => {
    if (pending) return;
    setPending(true);
    setError('');
    setAuthorizationError('');
    try {
      const result = await request('/auth/google/start', OAuthStartResponseSchema, {
        method: 'POST',
        body: {
          purpose,
          planningZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(targetAccountId ? { accountId: targetAccountId } : {}),
        },
      });
      const url = new URL(result.authorizationUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com')
        throw new Error('the authorization destination is not valid.');
      window.location.assign(url.href);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'authorization could not start.');
      setPending(false);
    }
  };
  const selected =
    session?.accounts?.items.find((account) => account.id === accountId) ??
    session?.accounts?.items[0];
  if (session?.authenticated && selected)
    return (
      <>
        <Suspense
          fallback={
            <main className="entry">
              <Brand />
              <p className="entry-footer">opening your workspace…</p>
            </main>
          }
        >
          <Workspace
            key={selected.id}
            account={selected}
            accounts={session.accounts!.items}
            clockOffset={clockOffset}
            theme={theme}
            onTheme={setTheme}
            onSelectAccount={selectAccount}
            onAuthorize={(purpose, id) => void authorize(purpose, id)}
            onAccountsChanged={load}
            onSignOut={signOut}
          />
        </Suspense>
        {session.accounts!.nextCursor && (
          <button
            className="app-load-accounts"
            onClick={() =>
              void request(
                '/api/accounts?cursor=' + encodeURIComponent(session.accounts!.nextCursor!),
                AccountPageSchema,
              )
                .then((page) =>
                  setSession((previous) =>
                    previous?.accounts
                      ? {
                          ...previous,
                          accounts: {
                            ...page,
                            items: [
                              ...new Map(
                                [...previous.accounts.items, ...page.items].map((account) => [
                                  account.id,
                                  account,
                                ]),
                              ).values(),
                            ],
                          },
                        }
                      : previous,
                  ),
                )
                .catch((error) =>
                  setError(error instanceof Error ? error.message : 'accounts could not load.'),
                )
            }
          >
            load more google accounts
          </button>
        )}
        {(error || authorizationError) && (
          <div className="app-global-error" role="alert">
            <span>{error || authorizationError}</span>
            <button
              onClick={() => {
                setError('');
                setAuthorizationError('');
              }}
            >
              dismiss
            </button>
          </div>
        )}
      </>
    );
  return (
    <main className="entry">
      <div className="entry-brand">
        <Brand />
      </div>
      <section className="entry-paper" aria-busy={!session && !error}>
        {!session && !error ? (
          <>
            <span className="entry-mark" aria-hidden="true" />
            <h1>opening your workspace…</h1>
          </>
        ) : !session ? (
          <>
            <h1>couldn’t open lanes.</h1>
            <p role="alert">{error}</p>
            <button className="entry-primary" onClick={() => void load()}>
              try again
            </button>
          </>
        ) : !session.configured ? (
          <>
            <span className="entry-mark" aria-hidden="true" />
            <h1>a little setup first.</h1>
            <p>this installation is waiting for its owner to finish configuration.</p>
            <p className="entry-note">
              the self-hosting guide in the repository has the required account and deployment
              steps.
            </p>
          </>
        ) : !session.authenticated || !session.accounts?.items.length ? (
          <>
            <span className="entry-mark" aria-hidden="true" />
            <h1>your things, in one place.</h1>
            <p>open your google tasks with the owner account.</p>
            <button
              className="entry-primary"
              disabled={pending}
              onClick={() => void authorize('signin')}
            >
              {pending ? 'opening google…' : 'continue with google'}
            </button>
            {(error || authorizationError) && (
              <p className="entry-error" role="alert">
                {error || authorizationError}
              </p>
            )}
          </>
        ) : (
          <>
            <h1>your accounts</h1>
            <p>choose the google account for this workspace.</p>
            <ul className="entry-accounts">
              {session.accounts.items.map((account) => (
                <li key={account.id}>
                  <strong>{account.displayName}</strong>
                  <span>{account.email}</span>
                  <small>{account.state.replaceAll('_', ' ')}</small>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <p className="entry-footer">a personal workspace for google tasks.</p>
    </main>
  );
}
