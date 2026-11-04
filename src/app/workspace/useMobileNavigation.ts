import { useEffect, useRef } from 'react';

/** Keep the temporary navigation drawer inside its own keyboard focus boundary. */
export function useMobileNavigation(open: boolean, onClose: () => void) {
  const drawer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const narrow = window.matchMedia('(max-width: 560px)');
    if (!narrow.matches) {
      onClose();
      return;
    }
    const focusable = () =>
      Array.from(
        drawer.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), a[href]',
        ) ?? [],
      ).filter((item) => item.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
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
    const resized = () => {
      if (!narrow.matches) onClose();
    };
    document.addEventListener('keydown', keydown);
    narrow.addEventListener('change', resized);
    return () => {
      document.removeEventListener('keydown', keydown);
      narrow.removeEventListener('change', resized);
      if (!document.querySelector('dialog[open]')) trigger.current?.focus();
    };
  }, [open, onClose]);
  return { drawer, trigger };
}
