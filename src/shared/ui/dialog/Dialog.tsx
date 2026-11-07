import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icon/Icon';
import { restoreFocus } from '../focus/restore-focus';
import { applyViewport, observeViewport } from '../viewport/viewport';
import './Dialog.css';

export function Dialog({
  title,
  children,
  presented = true,
  onClose,
  wide = false,
  side = false,
  pending = false,
  dismissOnOutside = false,
}: {
  title: string;
  presented?: boolean;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  side?: boolean;
  pending?: boolean;
  dismissOnOutside?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [scrollableTitle, setScrollableTitle] = useState(false);
  const opener = useRef(
    typeof document === 'undefined'
      ? null
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );
  const keyboard = useRef(opener.current?.matches(':focus-visible') ?? false);
  const outsidePointer = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!presented) return;
    const element = heading.current;
    if (!element) return;
    const update = () => setScrollableTitle(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [title, presented]);
  useLayoutEffect(() => {
    if (!presented) return;
    const dialog = ref.current;
    const stopViewport = dialog
      ? observeViewport((bounds) => applyViewport(dialog, bounds))
      : () => {};
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      stopViewport();
      if (dialog?.open) dialog.close();
      queueMicrotask(() => {
        if (
          !dialog?.open &&
          opener.current?.isConnected &&
          (document.activeElement === document.body ||
            document.activeElement === opener.current ||
            !!dialog?.contains(document.activeElement))
        )
          restoreFocus(opener.current, keyboard.current);
      });
    };
  }, [presented]);
  return (
    <dialog
      ref={ref}
      hidden={!presented}
      className={`dialog${wide ? ' dialog--wide' : ''}${side ? ' dialog--side' : ''}`}
      aria-label={title}
      aria-busy={pending || undefined}
      onKeyDown={() => {
        keyboard.current = true;
      }}
      onPointerDown={(event) => {
        keyboard.current = false;
        const bounds = event.currentTarget.getBoundingClientRect();
        outsidePointer.current =
          dismissOnOutside &&
          event.button === 0 &&
          event.isPrimary !== false &&
          event.target === event.currentTarget &&
          !event.currentTarget.querySelector('[popover]:popover-open') &&
          (event.clientX < bounds.left ||
            event.clientX >= bounds.right ||
            event.clientY < bounds.top ||
            event.clientY >= bounds.bottom)
            ? event.pointerId
            : null;
      }}
      onPointerUp={(event) => {
        const pointer = outsidePointer.current;
        outsidePointer.current = null;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          dismissOnOutside &&
          !pending &&
          pointer === event.pointerId &&
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX >= bounds.right ||
            event.clientY < bounds.top ||
            event.clientY >= bounds.bottom)
        )
          onClose();
      }}
      onPointerCancel={() => {
        outsidePointer.current = null;
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="dialog__heading">
        <h2 ref={heading} tabIndex={scrollableTitle ? 0 : undefined}>
          {title}
        </h2>
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
