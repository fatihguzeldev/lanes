import { lazy, Suspense } from 'react';
import { Brand } from '../../shared/ui/brand/Brand';
import { WorkspaceSkeleton } from '../workspace/WorkspaceSkeleton';
import { useTheme } from '../theme/theme';
import { useOwnerSession } from '../../modules/accounts/browser/session/useOwnerSession';
import { portabilityLanding } from '../../modules/transfer/browser/workspace/landing';
import type { SessionSnapshot } from '../../modules/accounts/contracts/session';
import './App.css';

const Workspace = lazy(() =>
  import('../workspace/Workspace').then((module) => ({ default: module.Workspace })),
);

export function App({
  initialSession = null,
  initialError = '',
  interactive = true,
}: {
  initialSession?: SessionSnapshot | null;
  initialError?: string;
  interactive?: boolean;
}) {
  const [, setTheme, resolvedTheme] = useTheme();
  const {
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
  } = useOwnerSession(() => portabilityLanding()?.accountId ?? null, initialSession, initialError);
  if (session?.authenticated && session.accounts?.items.length && !selected && !error)
    return <WorkspaceSkeleton theme={resolvedTheme} accountInitial={loadingInitial} />;
  if (!session && !error)
    return <main className="entry" role="status" aria-label="loading lanes" aria-busy="true" />;
  if (session?.authenticated && selected)
    return (
      <>
        <Suspense
          fallback={<WorkspaceSkeleton theme={resolvedTheme} accountInitial={loadingInitial} />}
        >
          <Workspace
            key={selected.id}
            account={selected}
            accounts={session.accounts!.items}
            clockOffset={clockOffset}
            theme={resolvedTheme}
            onTheme={setTheme}
            onSelectAccount={selectAccount}
            onAuthorize={(purpose, id) => void authorize(purpose, id)}
            onAccountsChanged={load}
            onSignOut={signOut}
          />
        </Suspense>
        {session.accounts!.nextCursor && (
          <button className="app-load-accounts" onClick={loadMoreAccounts}>
            load more google accounts
          </button>
        )}
        {(error || authorizationError) && (
          <div className="app-global-error" role="alert">
            <span>{error || authorizationError}</span>
            <button onClick={dismissError}>dismiss</button>
          </div>
        )}
      </>
    );
  return (
    <main className="entry">
      <div className="entry-brand">
        <Brand />
      </div>
      <section className="entry-paper">
        {!session || (error && !selected) ? (
          <>
            <h1>couldn’t open lanes.</h1>
            <p role="alert">{error}</p>
            <button className="entry-primary" disabled={!interactive} onClick={() => void load()}>
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
              disabled={pending || !interactive}
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
