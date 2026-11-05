import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { restoreFocus } from '../../shared/ui/focus/restore-focus';

export function useWorkspaceSearch(query: string, onQuery: (value: string) => void) {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const focusInput = useRef(false);
  const returning = useRef<{ origin: Element | null; keyboard: boolean } | null>(null);
  const searching = requestedOpen || Boolean(query);

  const open = useCallback(() => {
    returning.current = null;
    setRequestedOpen(true);
    if (input.current?.getClientRects().length) {
      focusInput.current = false;
      input.current.focus({ preventScroll: true });
    } else focusInput.current = true;
  }, []);
  const close = () => {
    const origin = document.activeElement;
    returning.current = {
      origin,
      keyboard: origin instanceof HTMLElement && origin.matches(':focus-visible'),
    };
    focusInput.current = false;
    setRequestedOpen(false);
    onQuery('');
  };

  useLayoutEffect(() => {
    if (searching && focusInput.current) {
      focusInput.current = false;
      if (!document.querySelector('dialog[open]')) input.current?.focus({ preventScroll: true });
    }
    if (searching || !returning.current) return;
    const pending = returning.current;
    returning.current = null;
    queueMicrotask(() => {
      const target = trigger.current;
      if (
        target?.getClientRects().length &&
        !document.querySelector('dialog[open]') &&
        (document.activeElement === document.body ||
          document.activeElement === pending.origin ||
          document.activeElement === input.current)
      )
        restoreFocus(target, pending.keyboard);
    });
  }, [requestedOpen, searching]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            'input,textarea,select,[role=combobox],[contenteditable=true],dialog,[role=dialog],[popover]',
          ))
      )
        return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);

  return { input, trigger, searching, open, close };
}
