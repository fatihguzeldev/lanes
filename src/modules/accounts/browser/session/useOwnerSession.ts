import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { request, RequestError } from '../../../../shared/browser/http/http';
import {
  AccountPageSchema,
  SessionSnapshotSchema,
  OAuthStartResponseSchema,
  type SessionSnapshot,
} from '../../contracts/session';
import { ConnectionSummarySchema } from '../../contracts/connection';
import { oauthLandingError } from './landing';

export function useOwnerSession(initialAccountId: () => string | null) {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [authorizationError, setAuthorizationError] = useState(oauthLandingError);
  const [pending, setPending] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(() => {
    const initial = initialAccountId();
    if (initial) return initial;
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
  const loadMoreAccounts = () => {
    if (!session?.accounts?.nextCursor) return;
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
      );
  };
  const dismissError = () => {
    setError('');
    setAuthorizationError('');
  };
  return {
    session,
    error,
    authorizationError,
    pending,
    clockOffset,
    selected,
    load,
    selectAccount,
    signOut,
    authorize,
    loadMoreAccounts,
    dismissError,
  };
}
