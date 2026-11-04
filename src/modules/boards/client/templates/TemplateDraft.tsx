import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../../../../ui/Dialog';

export function useDirty(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
  const callback = useRef(onDirtyChange);
  callback.current = onDirtyChange;
  useEffect(() => {
    callback.current?.(dirty);
    return () => callback.current?.(false);
  }, [dirty]);
}

export function CloseGuard({
  dirty,
  busy,
  onClose,
  children,
  title = 'discard this draft?',
  message = 'the changes in this editor have not been saved.',
  discardLabel = 'discard draft',
}: {
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
  title?: string | undefined;
  message?: string | undefined;
  discardLabel?: string | undefined;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {children(() => {
        if (!busy) {
          if (dirty) setConfirm(true);
          else onClose();
        }
      })}
      {confirm && (
        <Dialog title={title} onClose={() => setConfirm(false)}>
          <div className="dialog__body">
            <p>{message}</p>
            <footer>
              <button type="button" onClick={() => setConfirm(false)}>
                keep editing
              </button>
              <button type="button" className="primary" onClick={onClose}>
                {discardLabel}
              </button>
            </footer>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function useLifetime() {
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  return controller;
}
