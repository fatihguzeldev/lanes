import { useState, type ReactNode } from 'react';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { checkServerConnection } from '../../../../shared/browser/http/http';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { errorMessage } from './template-model';

type PagedState = {
  status: string;
  error: string;
  nextCursor: string | null;
  loaded: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
};

export function PageState({
  resource,
  empty,
  children,
}: {
  resource: PagedState;
  empty?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {resource.status === 'error' && (
        <p className="templates__error" role="alert">
          {resource.error}{' '}
          <button type="button" onClick={() => void resource.reload()}>
            try again
          </button>
        </p>
      )}
      {!resource.loaded && resource.status === 'loading' && (
        <p className="templates__quiet" role="status">
          loading…
        </p>
      )}
      {resource.loaded && empty && <div className="templates__empty">{children}</div>}
      {resource.nextCursor && (
        <button
          className="templates__more"
          type="button"
          disabled={resource.status === 'loading'}
          onClick={() => void resource.loadMore()}
        >
          load more
          <Icon name="down" size={12} />
        </button>
      )}
    </>
  );
}

export function ServerRecovery() {
  const connection = useServerConnection(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (connection === 'reachable') return null;
  return (
    <p className="templates__banner">
      {connection === 'incompatible'
        ? 'reload lanes before making another change.'
        : 'the server connection is paused. this draft stays here.'}
      <button
        type="button"
        className="templates__text"
        disabled={busy}
        onClick={() => {
          if (connection === 'incompatible') window.location.reload();
          else {
            setBusy(true);
            setError('');
            void checkServerConnection()
              .catch((caught) => setError(errorMessage(caught)))
              .finally(() => setBusy(false));
          }
        }}
      >
        {connection === 'incompatible' ? 'reload lanes' : busy ? 'checking…' : 'check connection'}
      </button>
      {error && <span>{error}</span>}
    </p>
  );
}
