import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileNavigation } from '../useMobileNavigation';

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));

class Element extends EventTarget {
  isConnected = true;
  visible = true;
  tabIndex = 0;
  children: Element[] = [];
  nestedSurface = false;
  openPopover: Element | null = null;
  attributes = new Map<string, string>();
  focus = vi.fn(() => {
    documentState.activeElement = this;
  });
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  querySelectorAll() {
    return this.children;
  }
  querySelector() {
    return this.openPopover;
  }
  contains(element: unknown) {
    return element === this || this.children.includes(element as Element);
  }
  closest() {
    return this.nestedSurface ? this : null;
  }
  matches() {
    return false;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
}
const documentState = Object.assign(new EventTarget(), {
  activeElement: null as Element | null,
  body: new Element(),
  querySelector: vi.fn(() => null as Element | null),
});
const narrow = Object.assign(new EventTarget(), { matches: true });
let cleanup: (() => void) | undefined;

function mount() {
  const close = vi.fn();
  const navigation = useMobileNavigation(true, close);
  const drawer = new Element();
  const first = new Element();
  const input = new Element();
  const last = new Element();
  drawer.children = [first, input, last];
  const trigger = new Element();
  navigation.drawer.current = drawer as unknown as HTMLElement;
  navigation.trigger.current = trigger as unknown as HTMLButtonElement;
  cleanup = effects.at(-1)!() || undefined;
  return { close, drawer, first, input, last, trigger };
}

function key(key: string, target: Element, shiftKey = false) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
    target: { value: target },
  });
  documentState.dispatchEvent(event);
  return event;
}

describe('compact navigation focus', () => {
  beforeEach(() => {
    effects.length = 0;
    narrow.matches = true;
    documentState.activeElement = documentState.body;
    documentState.querySelector.mockReturnValue(null);
    vi.stubGlobal('document', documentState);
    vi.stubGlobal('window', { matchMedia: vi.fn(() => narrow) });
    vi.stubGlobal('HTMLElement', Element);
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
  });

  it('cycles keyboard focus through the drawer, including inline creation inputs', () => {
    const { first, input, last } = mount();
    expect(first.focus).toHaveBeenCalledOnce();
    input.focus();
    expect(key('Tab', input).defaultPrevented).toBe(false);
    last.focus();
    expect(key('Tab', last).defaultPrevented).toBe(true);
    expect(documentState.activeElement).toBe(first);
    expect(key('Tab', first, true).defaultPrevented).toBe(true);
    expect(documentState.activeElement).toBe(last);
  });

  it('lets a nested dialog or popover handle Escape first', () => {
    const { close } = mount();
    const nested = new Element();
    nested.nestedSurface = true;
    key('Escape', nested);
    expect(close).not.toHaveBeenCalled();
  });

  it('lets an open popover dismiss first when focus remains on its trigger', () => {
    const { close, drawer, first, last } = mount();
    drawer.openPopover = new Element();
    const escape = key('Escape', first);
    expect(escape.defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();

    last.focus();
    expect(key('Tab', last).defaultPrevented).toBe(true);
    expect(documentState.activeElement).toBe(first);

    drawer.openPopover = null;
    expect(key('Escape', first).defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes at the desktop breakpoint without focusing a hidden mobile trigger', () => {
    const { close, trigger } = mount();
    trigger.visible = false;
    narrow.matches = false;
    narrow.dispatchEvent(new Event('change'));
    expect(close).toHaveBeenCalledOnce();
    cleanup?.();
    cleanup = undefined;
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it('does not steal focus from a newly opened confirmation dialog', () => {
    const { trigger } = mount();
    const dialog = new Element();
    documentState.querySelector.mockReturnValue(dialog);
    documentState.activeElement = dialog;
    cleanup?.();
    cleanup = undefined;
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});
