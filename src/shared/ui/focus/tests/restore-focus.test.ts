import { describe, expect, it, vi } from 'vitest';
import { restoreFocus } from '../restore-focus';

function target() {
  const element = new EventTarget();
  return Object.assign(element, {
    isConnected: true,
    focus: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  });
}

describe('returning focus after transient controls', () => {
  it('returns pointer focus quietly until the user uses the keyboard', () => {
    const element = target();
    restoreFocus(element as unknown as HTMLElement, false);
    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(element.setAttribute).toHaveBeenCalledWith('data-pointer-focus', '');
    element.dispatchEvent(new Event('keydown'));
    expect(element.removeAttribute).toHaveBeenCalledWith('data-pointer-focus');
  });

  it('keeps keyboard focus visible', () => {
    const element = target();
    restoreFocus(element as unknown as HTMLElement, true);
    expect(element.focus).toHaveBeenCalledOnce();
    expect(element.setAttribute).not.toHaveBeenCalled();
  });

  it('does not focus a removed opener', () => {
    const element = Object.assign(target(), { isConnected: false });
    restoreFocus(element as unknown as HTMLElement, false);
    expect(element.focus).not.toHaveBeenCalled();
  });

  it('clears a previous pointer suppression when returning with the keyboard', () => {
    const element = target();
    restoreFocus(element as unknown as HTMLElement, false);
    restoreFocus(element as unknown as HTMLElement, true);
    expect(element.removeAttribute).toHaveBeenCalledWith('data-pointer-focus');
    element.removeAttribute.mockClear();
    element.dispatchEvent(new Event('keydown'));
    expect(element.removeAttribute).not.toHaveBeenCalled();
  });

  it('cleans up pointer suppression when focus leaves', () => {
    const element = target();
    restoreFocus(element as unknown as HTMLElement, false);
    element.dispatchEvent(new Event('blur'));
    expect(element.removeAttribute).toHaveBeenCalledWith('data-pointer-focus');
  });
});
