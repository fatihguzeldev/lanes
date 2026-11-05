import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnchoredPopover } from '../Popover';

const lifecycle = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  panel: null as unknown,
  reposition: null as (() => void) | null,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current: current ?? lifecycle.panel }),
  useLayoutEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
}));
vi.mock('../../viewport/viewport', () => ({
  readViewport: () => ({ left: 0, top: 0, width: 375, height: 667 }),
  observeViewport: (changed: () => void) => {
    lifecycle.reposition = changed;
    changed();
    return () => {};
  },
}));

class Element extends EventTarget {
  isConnected = true;
  visible = true;
  open = false;
  child: Element | null = null;
  style = { setProperty: vi.fn(), left: '', top: '', maxHeight: '' };
  focus = vi.fn(() => {
    documentState.activeElement = this;
  });
  setAttribute = vi.fn();
  removeAttribute = vi.fn();
  showPopover() {
    this.open = true;
  }
  hidePopover() {
    this.open = false;
  }
  matches(selector: string) {
    return selector === ':popover-open' && this.open;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  getBoundingClientRect() {
    return { left: 20, right: 64, top: 20, bottom: 64, width: 260, height: 200 };
  }
  querySelector() {
    return this.child;
  }
  contains(element: unknown) {
    return element === this || element === this.child;
  }
}
const documentState = Object.assign(new EventTarget(), {
  body: new Element(),
  activeElement: null as Element | null,
});
let cleanup: (() => void) | undefined;

function mount(visible = true) {
  const anchor = new Element();
  anchor.visible = visible;
  const panel = new Element();
  panel.child = new Element();
  lifecycle.panel = panel;
  const close = vi.fn();
  AnchoredPopover({
    anchor: anchor as unknown as HTMLElement,
    label: 'settings',
    onClose: close,
    children: null,
  });
  cleanup = lifecycle.effects.at(-1)!() || undefined;
  return { anchor, panel, close };
}

describe('popover anchor visibility', () => {
  beforeEach(() => {
    lifecycle.effects.length = 0;
    lifecycle.reposition = null;
    documentState.activeElement = documentState.body;
    vi.stubGlobal('document', documentState);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '12px' }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    vi.unstubAllGlobals();
  });

  it('closes when a responsive layout hides its trigger without restoring hidden focus', async () => {
    const { anchor, close } = mount();
    anchor.visible = false;
    documentState.activeElement = documentState.body;
    lifecycle.reposition?.();
    expect(close).toHaveBeenCalledOnce();
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    expect(anchor.focus).not.toHaveBeenCalled();
  });

  it('does not focus popup content when its trigger is already hidden', () => {
    const { panel, close } = mount(false);
    expect(close).toHaveBeenCalledOnce();
    expect(panel.child?.focus).not.toHaveBeenCalled();
  });

  it('keeps an available anchor open and restores its focus after dismissal', async () => {
    const { anchor, panel, close } = mount();
    lifecycle.reposition?.();
    expect(close).not.toHaveBeenCalled();
    expect(panel.child?.focus).toHaveBeenCalledOnce();
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    expect(anchor.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
