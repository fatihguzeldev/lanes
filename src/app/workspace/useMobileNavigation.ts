import { useEffect, useRef } from 'react';
import { restoreFocus } from '../../shared/ui/focus/restore-focus';

/** Keep the temporary navigation drawer inside its own keyboard focus boundary. */
export function useMobileNavigation(open: boolean, onClose: () => void) {
  const drawer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const narrow = window.matchMedia('(max-width: 768px)');
    if (!narrow.matches) {
      onClose();
      return;
    }
    let keyboard = trigger.current?.matches(':focus-visible') ?? false;
    const focusable = () =>
      Array.from(
        drawer.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]',
        ) ?? [],
      ).filter((item) => item.tabIndex >= 0 && item.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('dialog[open], [popover]'))
        return;
      keyboard = true;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const targets = focusable();
      const first = targets[0],
        last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const pointerdown = () => {
      keyboard = false;
    };
    const focusin = (event: FocusEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.target instanceof HTMLElement && !drawer.current?.contains(event.target))
        focusable()[0]?.focus();
    };
    const resized = () => {
      if (!narrow.matches) onClose();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', pointerdown, true);
    document.addEventListener('focusin', focusin);
    narrow.addEventListener('change', resized);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', pointerdown, true);
      document.removeEventListener('focusin', focusin);
      narrow.removeEventListener('change', resized);
      if (
        trigger.current?.getClientRects().length &&
        !document.querySelector('dialog[open]') &&
        (document.activeElement === document.body ||
          document.activeElement === trigger.current ||
          drawer.current?.contains(document.activeElement))
      )
        restoreFocus(trigger.current, keyboard);
    };
  }, [open, onClose]);
  return { drawer, trigger };
}
