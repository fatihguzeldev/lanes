import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import './Dialog.css';

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  pending = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  pending?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(
    typeof document === 'undefined'
      ? null
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      queueMicrotask(() => {
        if (!dialog?.open && opener.current?.isConnected) opener.current.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog--wide' : ''}`}
      aria-label={title}
      aria-busy={pending || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="dialog__heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="dialog__close"
          onClick={onClose}
          disabled={pending}
          aria-label={`close ${title}`}
        >
          <Icon name="close" size={17} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
