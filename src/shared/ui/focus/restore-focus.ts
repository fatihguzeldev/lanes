const cleanups = new WeakMap<HTMLElement, () => void>();

export function restoreFocus(element: HTMLElement, keyboard: boolean) {
  if (!element.isConnected) return;
  cleanups.get(element)?.();
  if (!keyboard) {
    const cleanup = () => {
      element.removeAttribute('data-pointer-focus');
      element.removeEventListener('blur', cleanup);
      element.removeEventListener('keydown', cleanup);
      cleanups.delete(element);
    };
    element.setAttribute('data-pointer-focus', '');
    element.addEventListener('blur', cleanup);
    element.addEventListener('keydown', cleanup);
    cleanups.set(element, cleanup);
  }
  element.focus({ preventScroll: true });
}
