import { useRef, useState } from 'react';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { newOperationId } from './operation-identity';

export interface ConfirmationChoice {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: (identity: string) => Promise<boolean>;
  onCancel?: () => void;
}
export function Confirmation({
  choice,
  clockOffset,
  onClose,
  onError,
}: {
  choice: ConfirmationChoice;
  clockOffset: number;
  onClose: () => void;
  onError?: (message: string) => void;
}) {
  const captured = useRef(false);
  const [identity] = useState(() => newOperationId(clockOffset));
  const [error, setError] = useState('');
  const cancel = () => {
    choice.onCancel?.();
    onClose();
  };
  return (
    <Dialog title={choice.title} onClose={cancel}>
      <div className="dialog__body">
        <p>{choice.message}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button onClick={cancel}>cancel</button>
          <button
            className="primary"
            onClick={() => {
              if (captured.current) return;
              captured.current = true;
              try {
                // The account workspace owns the request after this confirmation closes.
                const submission = choice.onConfirm(identity);
                onClose();
                void submission.catch((caught) =>
                  onError?.(
                    caught instanceof Error
                      ? caught.message
                      : 'this change could not be submitted.',
                  ),
                );
              } catch (caught) {
                captured.current = false;
                setError(
                  caught instanceof Error ? caught.message : 'this change could not be submitted.',
                );
              }
            }}
          >
            {choice.confirmLabel}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
