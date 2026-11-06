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
import { clearAccountInitial, readAccountInitial, rememberAccountInitial } from './account-initial';
import { documentClockOffset } from './entry-bootstrap';

export function useOwnerSession(
  initialAccountId: () => string | null,
  initialSession: SessionSnapshot | null = null,
  initialError = '',
) {
  const [session, setSession] = useState<SessionSnapshot | null>(initialSession);
  const [error, setError] = useState(initialError);
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
  const initialSelection = useRef({ accountId, active: true });
  const selectedAccountId = useRef(accountId);
  const [loadingInitial, setLoadingInitial] = useState(() => {
    if (!initialSession) return readAccountInitial(accountId);
    if (!initialSession.authenticated) return null;
    const selected =
      initialSession.accounts?.items.find((item) => item.id === accountId) ??
      (!accountId || !initialSession.accounts?.nextCursor
        ? initialSession.accounts?.items[0]
        : undefined);
    return selected ? rememberAccountInitial(selected) : null;
  });
  selectedAccountId.current = accountId;
  const channel = useRef<BroadcastChannel | null>(null);
  const sessionFlight = useRef<AbortController | null>(null);
  const [clockOffset, setClockOffset] = useState(() =>
    initialSession ? documentClockOffset(initialSession.serverTime) : 0,
  );
  const load = useCallback(async (snapshot?: SessionSnapshot) => {
    sessionFlight.current?.abort();
    const flight = new AbortController();
    sessionFlight.current = flight;
    setError('');
    try {
      const next = snapshot
        ? SessionSnapshotSchema.parse(snapshot)
        : await request('/api/session', SessionSnapshotSchema, { signal: flight.signal });
      const offset = snapshot ? documentClockOffset(next.serverTime) : next.serverTime - Date.now();
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
      const nextAccount = next.authenticated
        ? (next.accounts?.items.find((account) => account.id === selectedAccountId.current) ??
          next.accounts?.items[0])
        : undefined;
      if (nextAccount) setLoadingInitial(rememberAccountInitial(nextAccount));
      else {
        clearAccountInitial();
        setLoadingInitial(null);
      }
      setClockOffset(offset);
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
    if (accountId !== initialSelection.current.accountId) initialSelection.current.active = false;
    if (initialSession && initialSelection.current.active) {
      if (!initialSession.authenticated) {
        clearAccountInitial();
        return;
      }
      if (!accountId || initialSession.accounts?.items.some((item) => item.id === accountId))
        return;
      // Resolve a remembered account beyond the first page without repeating the session read.
      void load(initialSession);
    } else if (!initialError || !initialSelection.current.active) void load();
    return () => sessionFlight.current?.abort();
  }, [load, accountId, initialSession, initialError]);
  useEffect(() => {
    const clearPrivate = () => {
      sessionFlight.current?.abort();
      setSession(null);
      clearAccountInitial();
      setLoadingInitial(null);
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
    const confirmedAccount = session?.accounts?.items.find((account) => account.id === id);
    setLoadingInitial(confirmedAccount ? rememberAccountInitial(confirmedAccount) : null);
    if (!confirmedAccount) clearAccountInitial();
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
        clearAccountInitial();
        setLoadingInitial(null);
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
    (accountId && session?.accounts?.nextCursor ? undefined : session?.accounts?.items[0]);
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
    loadingInitial,
    load,
    selectAccount,
    signOut,
    authorize,
    loadMoreAccounts,
    dismissError,
  };
}
