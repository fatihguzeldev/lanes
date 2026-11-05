import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '../Tooltip';

const state = vi.hoisted(() => ({
  open: false,
  setOpen: vi.fn(),
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useId: () => 'tooltip-test',
  useRef: (current: unknown) => {
    const ref = { current };
    state.refs.push(ref);
    return ref;
  },
  useState: () => [state.open, state.setOpen],
  useLayoutEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
}));
vi.mock('../../viewport/viewport', () => ({
  readViewport: () => ({ left: 0, top: 0, width: 320, height: 480 }),
  observeViewport: (changed: () => void) => {
    changed();
    return () => {};
  },
}));
class Element {
  isConnected = true;
  keyboard = false;
  open = false;
  attributes = new Map<string, string>();
  style = { maxWidth: '', left: '', top: '' };
  bounds = { left: 20, right: 120, top: 5, bottom: 33, width: 100, height: 28 };
  focus = vi.fn();
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }
  hasAttribute(key: string) {
    return this.attributes.has(key);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  matches(selector: string) {
    return selector === ':focus-visible' ? this.keyboard : this.open;
  }
  getClientRects() {
    return [{}];
  }
  getBoundingClientRect() {
    return this.bounds;
  }
  showPopover() {
    this.open = true;
  }
  hidePopover() {
    this.open = false;
  }
}
let cleanup: (() => void) | undefined;
const lifetimes: Array<() => void> = [];
function render(open = false) {
  state.open = open;
  const refStart = state.refs.length;
  const effectStart = state.effects.length;
  const anchor = new Element(),
    panel = new Element();
  const view = Tooltip({ label: 'schedule', children: createElement('button') }) as ReactElement<
    Record<string, Function>
  >;
  state.refs[refStart]!.current = { querySelector: () => anchor };
  state.refs[refStart + 1]!.current = panel;
  const lifetime = state.effects[effectStart]!();
  if (lifetime) lifetimes.push(lifetime);
  return { anchor, panel, props: view.props };
}
describe('control tooltips', () => {
  beforeEach(() => {
    state.refs.length = 0;
    state.effects.length = 0;
    state.setOpen.mockClear();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { activeElement: null }));
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => (name === '--floating-gutter' ? '12px' : '0px'),
    }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    lifetimes
      .splice(0)
      .reverse()
      .forEach((dispose) => dispose());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('opens for pointer hover and keyboard focus without reacting to touch', () => {
    const { anchor, props } = render();
    props.onPointerEnter!({ pointerType: 'touch' });
    expect(state.setOpen).not.toHaveBeenCalled();
    props.onPointerEnter!({ pointerType: 'mouse' });
    expect(state.setOpen).toHaveBeenLastCalledWith(true);
    state.setOpen.mockClear();
    props.onFocus!({ target: anchor });
    expect(state.setOpen).not.toHaveBeenCalled();
    anchor.keyboard = true;
    props.onFocus!({ target: anchor });
    expect(state.setOpen).toHaveBeenCalledWith(true);
  });
  it('does not reopen after a quiet pointer focus return', () => {
    const { anchor, props } = render();
    anchor.keyboard = true;
    anchor.setAttribute('data-pointer-focus', '');
    props.onFocus!({ target: anchor });
    expect(state.setOpen).not.toHaveBeenCalled();
  });
  it('dismisses a hovered tooltip before Escape reaches an editor field outside its trigger', () => {
    render(true);
    cleanup = state.effects.at(-1)!() || undefined;
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, {
      key: { value: 'Escape' },
      target: { value: new Element() },
    });
    const stopped = vi.spyOn(event, 'stopPropagation');
    document.dispatchEvent(event);
    expect(state.setOpen).toHaveBeenCalledWith(false);
    expect(event.defaultPrevented).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
  });
  it('describes its control without moving focus and preserves other descriptions', () => {
    const { anchor, panel } = render(true);
    anchor.setAttribute('aria-describedby', 'validation');
    cleanup = state.effects.at(-1)!() || undefined;
    expect(panel.open).toBe(true);
    expect(anchor.focus).not.toHaveBeenCalled();
    expect(anchor.getAttribute('aria-describedby')).toBe('validation tooltip-test');
    anchor.setAttribute('aria-describedby', 'validation tooltip-test extra');
    cleanup?.();
    cleanup = undefined;
    expect(anchor.getAttribute('aria-describedby')).toBe('validation extra');
    expect(panel.open).toBe(false);
  });

  it('keeps labels inside the safe area and shared floating gutter', () => {
    const tokens: Record<string, string> = {
      '--floating-gutter': '16px',
      '--safe-left': '44px',
      '--safe-right': '21px',
      '--safe-top': '10px',
      '--safe-bottom': '34px',
    };
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => tokens[name] ?? '',
    }));
    const { anchor, panel } = render(true);
    anchor.bounds = { left: 260, right: 304, top: 450, bottom: 494, width: 44, height: 44 };
    cleanup = state.effects.at(-1)!() || undefined;
    expect(panel.style.maxWidth).toBe('223px');
    expect(panel.style.left).toBe('183px');
    expect(panel.style.top).toBe('402px');
  });

  it('keeps a label open while the pointer crosses the gap to its content', () => {
    vi.useFakeTimers();
    const { props } = render();
    props.onPointerEnter!({ pointerType: 'mouse' });
    state.setOpen.mockClear();
    props.onPointerLeave!();
    expect(state.setOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    props.onPointerEnter!({ pointerType: 'mouse' });
    state.setOpen.mockClear();
    vi.advanceTimersByTime(200);
    expect(state.setOpen).not.toHaveBeenCalled();
    props.onPointerLeave!();
    vi.advanceTimersByTime(120);
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });

  it('keeps a keyboard label visible when the pointer leaves its control', () => {
    vi.useFakeTimers();
    const { anchor, props } = render();
    anchor.keyboard = true;
    Object.assign(document, { activeElement: anchor });
    props.onFocus!({ target: anchor });
    state.setOpen.mockClear();
    props.onPointerLeave!();
    vi.advanceTimersByTime(200);
    expect(state.setOpen).not.toHaveBeenCalled();
    props.onBlur!();
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });

  it('still dismisses a hovered label after a quiet pointer focus return', () => {
    vi.useFakeTimers();
    const { anchor, props } = render();
    anchor.keyboard = true;
    anchor.setAttribute('data-pointer-focus', '');
    Object.assign(document, { activeElement: anchor });
    props.onPointerEnter!({ pointerType: 'mouse' });
    state.setOpen.mockClear();
    props.onPointerLeave!();
    vi.advanceTimersByTime(120);
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });

  it('replaces the previous label when another control is hovered', () => {
    const first = render();
    first.props.onPointerEnter!({ pointerType: 'mouse' });
    state.setOpen.mockClear();
    const second = render();
    second.props.onPointerEnter!({ pointerType: 'mouse' });
    expect(state.setOpen.mock.calls.map(([value]) => value)).toEqual([false, true]);
  });

  it('cancels pending hover dismissal when its control unmounts', () => {
    vi.useFakeTimers();
    const { props } = render();
    props.onPointerEnter!({ pointerType: 'mouse' });
    props.onPointerLeave!();
    lifetimes.at(-1)?.();
    state.setOpen.mockClear();
    vi.advanceTimersByTime(200);
    expect(state.setOpen).not.toHaveBeenCalled();
    render().props.onPointerEnter!({ pointerType: 'mouse' });
    expect(state.setOpen.mock.calls.map(([value]) => value)).toEqual([true]);
  });
});
