import type { ComponentProps, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '../Dialog';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useState: () => [false, vi.fn()],
  useLayoutEffect: () => {},
}));
function mount(extra: Partial<ComponentProps<typeof Dialog>> = {}) {
  const close = vi.fn();
  const view = Dialog({
    title: 'board history',
    children: null,
    onClose: close,
    dismissOnOutside: true,
    ...extra,
  }) as ReactElement<ComponentProps<'dialog'>>;
  const dialog = {
    getBoundingClientRect: () => ({ left: 500, top: 0, right: 1000, bottom: 800 }),
    querySelector: vi.fn(() => null as unknown),
  };
  const press = (x: number, y: number, target: unknown = dialog, pointerId = 1) =>
    ({
      currentTarget: dialog,
      target,
      clientX: x,
      clientY: y,
      pointerId,
      button: 0,
    }) as unknown as ReactPointerEvent<HTMLDialogElement>;
  return { close, props: view.props, dialog, press };
}
describe('optional dialog outside dismissal', () => {
  it('closes history for a complete press on the backdrop', () => {
    const { close, props, press } = mount();
    props.onPointerDown?.(press(100, 100));
    props.onPointerUp?.(press(100, 100));
    expect(close).toHaveBeenCalledOnce();
  });
  it('keeps content clicks and inside-to-outside drags inside the dialog workflow', () => {
    const { close, props, press } = mount();
    props.onPointerDown?.(press(600, 100));
    props.onPointerUp?.(press(100, 100));
    props.onPointerDown?.(press(600, 100, {}));
    props.onPointerUp?.(press(600, 100, {}));
    expect(close).not.toHaveBeenCalled();
  });
  it('does not close the parent while a nested menu handles an outside click', () => {
    const { close, props, press, dialog } = mount();
    dialog.querySelector.mockReturnValue({});
    props.onPointerDown?.(press(100, 100));
    props.onPointerUp?.(press(100, 100));
    expect(close).not.toHaveBeenCalled();
  });
  it('keeps pending and non-dismissable dialogs open', () => {
    for (const extra of [{ pending: true }, { dismissOnOutside: false }]) {
      const { close, props, press } = mount(extra);
      props.onPointerDown?.(press(100, 100));
      props.onPointerUp?.(press(100, 100));
      expect(close).not.toHaveBeenCalled();
    }
  });
  it('ignores cancelled presses and a different ending pointer', () => {
    const { close, props, press } = mount();
    props.onPointerDown?.(press(100, 100));
    props.onPointerCancel?.(press(100, 100));
    props.onPointerUp?.(press(100, 100));
    props.onPointerDown?.(press(100, 100));
    props.onPointerUp?.(press(100, 100, undefined, 2));
    expect(close).not.toHaveBeenCalled();
  });
});
