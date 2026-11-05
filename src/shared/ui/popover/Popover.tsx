import { useId, useLayoutEffect, useRef, useState, type AriaRole, type ReactNode } from 'react';
import { placePopover } from './floating';
import { restoreFocus as returnFocus } from '../focus/restore-focus';
import { observeViewport, readViewport } from '../viewport/viewport';
import './Popover.css';

type Content = ReactNode | ((close: () => void) => ReactNode);

export interface AnchoredPopoverProps {
  anchor: HTMLElement;
  label: string;
  onClose: () => void;
  children: Content;
  align?: 'start' | 'end';
  className?: string;
  focusOnOpen?: boolean;
  role?: AriaRole;
  id?: string;
}

export function AnchoredPopover({
  anchor,
  label,
  onClose,
  children,
  align = 'start',
  className,
  focusOnOpen = true,
  role = 'dialog',
  id,
}: AnchoredPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    let restoreFocus = true;
    let keyboard = anchor.matches(':focus-visible');
    const keydown = () => {
      keyboard = true;
    };
    const position = () => {
      if (!anchor.isConnected) {
        closeRef.current();
        return;
      }
      const viewport = readViewport();
      const styles = getComputedStyle(panel);
      const safe = (side: string) => parseFloat(styles.getPropertyValue(`--safe-${side}`)) || 0;
      const left = safe('left'),
        right = safe('right'),
        top = safe('top'),
        bottom = safe('bottom');
      const usable = {
        left: viewport.left + left,
        top: viewport.top + top,
        width: Math.max(0, viewport.width - left - right),
        height: Math.max(0, viewport.height - top - bottom),
      };
      panel.style.setProperty('--floating-max-width', `${Math.max(0, usable.width - 24)}px`);
      const bounds = panel.getBoundingClientRect();
      const next = placePopover(anchor.getBoundingClientRect(), bounds, usable, align);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.style.maxHeight = `${next.maxHeight}px`;
    };
    const toggled = (event: Event) => {
      if (event.target === panel && (event as ToggleEvent).newState === 'closed')
        closeRef.current();
    };
    const outside = (event: PointerEvent) => {
      keyboard = false;
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      )
        restoreFocus = false;
    };
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      ) {
        restoreFocus = false;
        panel.hidePopover();
      }
    };
    panel.addEventListener('toggle', toggled);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focus);
    panel.showPopover();
    const stopViewport = observeViewport(position);
    if (focusOnOpen) {
      panel
        .querySelector<HTMLElement>(
          '[autofocus],button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        )
        ?.focus({ preventScroll: true });
    } else anchor.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener('scroll', position, true);
    return () => {
      panel.removeEventListener('toggle', toggled);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focus);
      observer.disconnect();
      stopViewport();
      window.removeEventListener('scroll', position, true);
      if (panel.matches(':popover-open')) panel.hidePopover();
      queueMicrotask(() => {
        if (
          restoreFocus &&
          anchor.isConnected &&
          (document.activeElement === document.body ||
            document.activeElement === anchor ||
            panel.contains(document.activeElement))
        )
          returnFocus(anchor, keyboard);
      });
    };
  }, [anchor, align, focusOnOpen]);
  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      className={`popover__panel${className ? ` ${className}` : ''}`}
      role={role}
      aria-label={role === 'presentation' ? undefined : label}
    >
      {typeof children === 'function' ? children(onClose) : children}
    </div>
  );
}

export interface PopoverProps {
  label: string;
  trigger: ReactNode;
  children: Content;
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
  align?: 'start' | 'end';
  triggerId?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

export function Popover({
  label,
  trigger,
  children,
  className,
  triggerClassName,
  disabled,
  align,
  triggerId,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (open && button.current?.matches(':disabled')) setOpen(false);
  });
  return (
    <span className="popover">
      <button
        ref={button}
        id={triggerId}
        type="button"
        className={`popover__trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && button.current && (
        <AnchoredPopover
          anchor={button.current}
          id={id}
          label={label}
          onClose={() => setOpen(false)}
          {...(align ? { align } : {})}
          {...(className ? { className } : {})}
        >
          {children}
        </AnchoredPopover>
      )}
    </span>
  );
}
