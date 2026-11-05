import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOutsideDismiss } from '../useOutsideDismiss';

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));

class Element {
  child: Element | null = null;
  popup = false;
  contains(target: unknown) {
    return target === this || target === this.child;
  }
  closest() {
    return this.popup ? this : null;
  }
}
const documentState = Object.assign(new EventTarget(), {
  querySelector: vi.fn(() => null as Element | null),
});
let cleanup: (() => void) | undefined;
function mount(enabled = true) {
  const root = new Element();
  root.child = new Element();
  const close = vi.fn();
  useOutsideDismiss({ current: root as unknown as HTMLElement }, close, { enabled });
  cleanup = effects.at(-1)!() || undefined;
  return { root, close };
}
function down(target: Element, button = 0) {
  const event = new Event('pointerdown', { cancelable: true });
  Object.defineProperties(event, {
    target: { value: target },
    button: { value: button },
    isPrimary: { value: true },
  });
  documentState.dispatchEvent(event);
  return event;
}

describe('outside dismissal', () => {
  beforeEach(() => {
    effects.length = 0;
    documentState.querySelector.mockReturnValue(null);
    vi.stubGlobal('document', documentState);
    vi.stubGlobal('Node', Element);
    vi.stubGlobal('Element', Element);
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
  });

  it('closes on an outside primary press without consuming the target action', () => {
    const { close } = mount();
    expect(down(new Element()).defaultPrevented).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
  it('keeps the editor open while using its content or a nested popup', () => {
    const { root, close } = mount();
    down(root.child!);
    const popup = new Element();
    popup.popup = true;
    down(popup);
    expect(close).not.toHaveBeenCalled();
  });
  it('leaves an open modal dialog in charge of dismissal', () => {
    const { close } = mount();
    documentState.querySelector.mockReturnValue(new Element());
    down(new Element());
    expect(close).not.toHaveBeenCalled();
  });
  it('ignores secondary clicks and disabled dismissal', () => {
    const { close } = mount();
    down(new Element(), 2);
    expect(close).not.toHaveBeenCalled();
    cleanup?.();
    const disabled = mount(false);
    down(new Element());
    expect(disabled.close).not.toHaveBeenCalled();
  });
  it('stops observing after its editor leaves the screen', () => {
    const { close } = mount();
    cleanup?.();
    cleanup = undefined;
    down(new Element());
    expect(close).not.toHaveBeenCalled();
  });
});
