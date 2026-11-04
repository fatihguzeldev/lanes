import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { newOperationId } from './useCommands';

export interface ConfirmationChoice {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: (identity: string) => Promise<boolean>;
}
export function Confirmation({
  choice,
  clockOffset,
  onClose,
  error,
}: {
  choice: ConfirmationChoice;
  clockOffset: number;
  onClose: () => void;
  error: string;
}) {
  const [pending, setPending] = useState(false),
    [failed, setFailed] = useState(false),
    [identity] = useState(() => newOperationId(clockOffset));
  return (
    <Dialog title={choice.title} onClose={onClose} pending={pending}>
      <div className="dialog__body">
        <p>{choice.message}</p>
        {failed && (
          <p className="error" role="alert">
            {error || 'the save is not confirmed yet. check its status before trying again.'}
          </p>
        )}
        <footer>
          <button onClick={onClose} disabled={pending}>
            cancel
          </button>
          <button
            className="primary"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setFailed(false);
              void choice
                .onConfirm(identity)
                .then((done) => {
                  if (done) onClose();
                  else setFailed(true);
                })
                .catch(() => setFailed(true))
                .finally(() => setPending(false));
            }}
          >
            {pending ? 'saving…' : choice.confirmLabel}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
