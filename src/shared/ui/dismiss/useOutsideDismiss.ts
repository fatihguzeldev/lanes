import { useEffect, useRef, type RefObject } from 'react';

export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!enabled) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        event.button !== 0 ||
        event.isPrimary === false ||
        event.defaultPrevented ||
        !(target instanceof Node) ||
        !ref.current ||
        ref.current.contains(target) ||
        document.querySelector('dialog[open]') ||
        (target instanceof Element && target.closest('[popover]:popover-open'))
      )
        return;
      dismiss.current();
    };
    document.addEventListener('pointerdown', outside, { capture: true });
    return () => document.removeEventListener('pointerdown', outside, { capture: true });
  }, [enabled, ref]);
}
