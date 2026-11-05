import { useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { observeViewport, readViewport } from '../viewport/viewport';
import './Tooltip.css';

export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const id = useId();
  const wrapper = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const trigger = () =>
    wrapper.current?.querySelector<HTMLElement>('button,summary,input,[tabindex]');
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger(),
      tooltip = panel.current;
    if (!anchor || !tooltip) return;
    const described = anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
    anchor.setAttribute('aria-describedby', [...described, id].join(' '));
    const position = () => {
      if (!anchor.isConnected || !anchor.getClientRects().length) {
        setOpen(false);
        return;
      }
      const view = readViewport();
      const styles = getComputedStyle(tooltip);
      const gutter = parseFloat(styles.getPropertyValue('--floating-gutter')) || 12;
      const safe = (side: string) =>
        Math.max(0, parseFloat(styles.getPropertyValue(`--safe-${side}`)) || 0);
      const leftEdge = view.left + safe('left') + gutter;
      const rightEdge = view.left + view.width - safe('right') - gutter;
      const topEdge = view.top + safe('top') + gutter;
      const bottomEdge = view.top + view.height - safe('bottom') - gutter;
      const bounds = anchor.getBoundingClientRect();
      tooltip.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;
      tooltip.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
      const size = tooltip.getBoundingClientRect();
      const left = Math.max(
        leftEdge,
        Math.min(bounds.left + (bounds.width - size.width) / 2, rightEdge - size.width),
      );
      const above = bounds.top - size.height - 7;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(topEdge, Math.min(above >= topEdge ? above : bounds.bottom + 7, bottomEdge - size.height))}px`;
    };
    tooltip.showPopover();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', escape, { capture: true });
    const stop = observeViewport(position);
    const observer = new ResizeObserver(position);
    observer.observe(tooltip);
    window.addEventListener('scroll', position, true);
    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('keydown', escape, { capture: true });
      if (tooltip.matches(':popover-open')) tooltip.hidePopover();
      const remaining = anchor
        .getAttribute('aria-describedby')
        ?.split(/\s+/)
        .filter((value) => value !== id)
        .join(' ');
      if (remaining) anchor.setAttribute('aria-describedby', remaining);
      else anchor.removeAttribute('aria-describedby');
    };
  }, [open, id]);
  return (
    <span
      className="tooltip"
      ref={wrapper}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setOpen(true);
      }}
      onPointerLeave={() => setOpen(false)}
      onPointerDownCapture={() => setOpen(false)}
      onFocus={(event) => {
        if (
          event.target === trigger() &&
          event.target.matches(':focus-visible') &&
          !event.target.hasAttribute('data-pointer-focus')
        )
          setOpen(true);
      }}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <div ref={panel} id={id} popover="manual" role="tooltip" className="tooltip__panel">
          {label}
        </div>
      )}
    </span>
  );
}
