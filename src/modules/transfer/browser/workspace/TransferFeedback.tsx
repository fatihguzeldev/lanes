import type { ReactNode } from 'react';
import { checkServerConnection } from '../../../../shared/browser/http/http';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { useTransferAction } from './useTransferAction';
export function TransferConnection() {
  const connection = useServerConnection(),
    action = useTransferAction('connection');
  return connection === 'reachable' ? null : (
    <p className="transfer__notice">
      {connection === 'incompatible'
        ? 'reload lanes before making another change.'
        : 'the server connection is paused. this editor keeps your unsent work.'}
      <button
        type="button"
        onClick={() => {
          if (connection === 'incompatible') window.location.reload();
          else void action.run(() => checkServerConnection());
        }}
        disabled={action.busy}
      >
        {connection === 'incompatible' ? 'reload' : 'check connection'}
      </button>
      {action.error}
    </p>
  );
}
export function TransferError({ children }: { children: ReactNode }) {
  return children ? (
    <p className="transfer__error" role="alert">
      {children}
    </p>
  ) : null;
}
export function TransferPages({
  resource,
}: {
  resource: {
    status: string;
    error: string;
    loaded: boolean;
    nextCursor: string | null;
    reload: () => Promise<void>;
    loadMore: () => Promise<void>;
  };
}) {
  return (
    <>
      {resource.error && (
        <TransferError>
          {resource.error}
          <button type="button" onClick={() => void resource.reload()}>
            try again
          </button>
        </TransferError>
      )}
      {!resource.loaded && resource.status === 'loading' && (
        <p className="transfer__quiet">loading…</p>
      )}
      {resource.nextCursor && (
        <button
          className="transfer__text"
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
