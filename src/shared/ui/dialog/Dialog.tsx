import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icon/Icon';
import { restoreFocus } from '../focus/restore-focus';
import './Dialog.css';

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  side = false,
  pending = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  side?: boolean;
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
  const keyboard = useRef(opener.current?.matches(':focus-visible') ?? false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      queueMicrotask(() => {
        if (!dialog?.open && opener.current?.isConnected)
          restoreFocus(opener.current, keyboard.current);
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog--wide' : ''}${side ? ' dialog--side' : ''}`}
      aria-label={title}
      aria-busy={pending || undefined}
      onKeyDown={() => {
        keyboard.current = true;
      }}
      onPointerDown={() => {
        keyboard.current = false;
      }}
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
