import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { restoreFocus } from '../../../../shared/ui/focus/restore-focus';

interface Props {
  accountId: string;
  taskId: string | null;
  children: ReactNode;
}

function findSlot(accountId: string, taskId: string | null) {
  return [...document.querySelectorAll<HTMLElement>('[data-task-editor-host]')].find(
    (item) => item.dataset.taskEditorHost === taskId && item.dataset.accountId === accountId,
  );
}

/** Moving this host preserves the draft when its card is refreshed or leaves the view. */
export function TaskEditorSurface({ accountId, taskId, children }: Props) {
  const [host] = useState(() =>
    typeof document === 'undefined' ? null : document.createElement('div'),
  );
  const [origin] = useState(() =>
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? {
          element: document.activeElement,
          keyboard: document.activeElement.matches(':focus-visible'),
        }
      : null,
  );
  const opener = useRef<HTMLElement | null>(origin?.element ?? null);
  const keyboard = useRef(origin?.keyboard ?? false);
  useLayoutEffect(() => {
    if (!host) return;
    host.className = 'task-editor-surface';
    const place = () => {
      const slot = findSlot(accountId, taskId);
      const title = slot?.parentElement?.querySelector<HTMLElement>(
        '.task-card__title, .task-card__child-title',
      );
      if (title) opener.current = title;
      const parent = slot ?? document.body;
      host.classList.toggle('task-editor-surface--detached', !slot);
      if (host.parentNode !== parent) parent.append(host);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    const onKey = () => {
      keyboard.current = true;
    };
    const onPointer = () => {
      keyboard.current = false;
    };
    host.addEventListener('keydown', onKey, true);
    host.addEventListener('pointerdown', onPointer, true);
    return () => {
      observer.disconnect();
      host.removeEventListener('keydown', onKey, true);
      host.removeEventListener('pointerdown', onPointer, true);
      host.remove();
      const target = opener.current;
      queueMicrotask(() => {
        if (target && document.activeElement === document.body)
          restoreFocus(target, keyboard.current);
      });
    };
  }, [accountId, taskId, host]);
  return host ? createPortal(children, host) : children;
}
