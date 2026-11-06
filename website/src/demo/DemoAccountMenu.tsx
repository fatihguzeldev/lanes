import { useId, useLayoutEffect, useRef, useState } from 'react';
import './DemoAccountMenu.css';

export type DemoAccountIdentity = {
  id: string;
  displayName: string;
  email: string;
};

export function DemoAccountMenu({
  account,
  accounts,
  onSelect,
}: {
  account: DemoAccountIdentity;
  accounts: readonly DemoAccountIdentity[];
  onSelect(id: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const anchor = trigger.current;
    const panel = menu.current;
    if (!open || !anchor || !panel) return;
    let restoreFocus = true;
    const viewport = window.visualViewport;
    const position = () => {
      if (!anchor.isConnected || !anchor.getClientRects().length) {
        restoreFocus = false;
        setOpen(false);
        return;
      }
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const width = Math.max(0, (viewport?.width ?? document.documentElement.clientWidth) - 24);
      const height = Math.max(0, (viewport?.height ?? window.innerHeight) - 24);
      panel.style.maxWidth = `${width}px`;
      panel.style.maxHeight = `${height}px`;
      const bounds = panel.getBoundingClientRect();
      const anchorBounds = anchor.getBoundingClientRect();
      const below = Math.max(0, top + height - anchorBounds.bottom - 6);
      const above = Math.max(0, anchorBounds.top - top - 6);
      const upwards = bounds.height > below && above > below;
      const maxHeight = Math.min(height, upwards ? above : below);
      const panelHeight = Math.min(bounds.height, maxHeight);
      panel.style.left = `${Math.max(left, Math.min(anchorBounds.right - bounds.width, left + width - bounds.width))}px`;
      panel.style.top = `${Math.max(top, Math.min(upwards ? anchorBounds.top - panelHeight - 6 : anchorBounds.bottom + 6, top + height - panelHeight))}px`;
      panel.style.maxHeight = `${maxHeight}px`;
    };
    const pointerDown = (event: PointerEvent) => {
      keyboard.current = false;
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      )
        restoreFocus = false;
    };
    const keyDown = () => {
      keyboard.current = true;
    };
    const focusOutside = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.contains(event.target)
      ) {
        restoreFocus = false;
        panel.hidePopover();
      }
    };
    const toggled = (event: Event) => {
      if (event.target === panel && (event as ToggleEvent).newState === 'closed') setOpen(false);
    };
    panel.addEventListener('toggle', toggled);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('focusin', focusOutside);
    panel.showPopover();
    position();
    const first = panel.querySelector('button');
    first?.toggleAttribute('data-pointer-focus', !keyboard.current);
    first?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      panel.removeEventListener('toggle', toggled);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('keydown', keyDown, true);
      document.removeEventListener('focusin', focusOutside);
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
      if (panel.matches(':popover-open')) panel.hidePopover();
      queueMicrotask(() => {
        if (
          restoreFocus &&
          anchor.isConnected &&
          (document.activeElement === document.body ||
            document.activeElement === anchor ||
            panel.contains(document.activeElement))
        ) {
          anchor.toggleAttribute('data-pointer-focus', !keyboard.current);
          anchor.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="demo-account-menu__trigger"
        aria-label={`google account: ${account.email}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerDown={(event) => event.currentTarget.setAttribute('data-pointer-focus', '')}
        onKeyDown={(event) => event.currentTarget.removeAttribute('data-pointer-focus')}
        onBlur={(event) => event.currentTarget.removeAttribute('data-pointer-focus')}
        onClick={(event) => {
          keyboard.current = event.detail === 0;
          setOpen((value) => !value);
        }}
      >
        <span className="demo-account-menu__avatar">
          {Array.from(account.displayName.trim())[0] ?? '?'}
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={`google account: ${account.email}`}
          className="demo-account-menu__panel"
          onKeyDown={(event) => {
            if (event.target instanceof HTMLElement)
              event.target.removeAttribute('data-pointer-focus');
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="demo-account-menu__identity">
            <strong>{account.displayName}</strong>
            <span>{account.email}</span>
          </div>
          {accounts.length > 1 &&
            accounts.map((item) => (
              <button
                key={item.id}
                type="button"
                className="demo-account-menu__item"
                aria-pressed={item.id === account.id}
                onPointerDown={(event) =>
                  event.currentTarget.setAttribute('data-pointer-focus', '')
                }
                onBlur={(event) => event.currentTarget.removeAttribute('data-pointer-focus')}
                onClick={() => {
                  setOpen(false);
                  onSelect(item.id);
                }}
              >
                <span>{item.email}</span>
                {item.id === account.id && (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.65"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                )}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
