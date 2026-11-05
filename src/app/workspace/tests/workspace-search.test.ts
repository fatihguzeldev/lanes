import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearch } from '../useWorkspaceSearch';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= { current: initial });
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    const slot = (hooks.slots[index] ??= { value: initial }) as { value: unknown };
    return [slot.value, (next: unknown) => (slot.value = next)];
  },
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (previous && dependencies.every((value, key) => Object.is(value, previous[key]))) return;
    hooks.slots[index] = dependencies;
    hooks.effects.push(effect);
  },
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (previous && dependencies.every((value, key) => Object.is(value, previous[key]))) return;
    hooks.slots[index] = dependencies;
    hooks.effects.push(() => {
      const cleanup = effect();
      if (cleanup) hooks.cleanups.push(cleanup);
    });
  },
}));

class Element extends EventTarget {
  isConnected = true;
  visible = true;
  editing = false;
  surface = false;
  keyboard = false;
  attributes = new Map<string, string>();
  focus = vi.fn(() => {
    documentState.activeElement = this;
  });
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  closest() {
    return this.editing || this.surface ? this : null;
  }
  matches() {
    return this.keyboard;
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
const windowState = new EventTarget();

function mount(initialQuery = '') {
  let query = initialQuery;
  const onQuery = vi.fn();
  const input = new Element();
  input.editing = true;
  const trigger = new Element();
  function render(nextQuery = query) {
    query = nextQuery;
    hooks.cursor = 0;
    const result = useWorkspaceSearch(query, onQuery);
    result.input.current = input as unknown as HTMLInputElement;
    result.trigger.current = trigger as unknown as HTMLButtonElement;
    input.visible = result.searching;
    trigger.visible = !result.searching;
    hooks.effects.splice(0).forEach((effect) => effect());
    return result;
  }
  return { input, trigger, onQuery, render, state: render() };
}

function key(target: Element, options: Partial<KeyboardEvent> = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: '/' },
    target: { value: target },
    ...Object.fromEntries(Object.entries(options).map(([name, value]) => [name, { value }])),
  });
  windowState.dispatchEvent(event);
  return event;
}

describe('workspace search', () => {
  beforeEach(() => {
    hooks.cursor = 0;
    hooks.slots.length = 0;
    hooks.effects.length = 0;
    documentState.activeElement = documentState.body;
    documentState.querySelector.mockReturnValue(null);
    vi.stubGlobal('document', documentState);
    vi.stubGlobal('window', windowState);
    vi.stubGlobal('HTMLElement', Element);
  });
  afterEach(async () => {
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    await Promise.resolve();
    vi.unstubAllGlobals();
  });

  it('reveals search before focusing its previously hidden input', () => {
    const search = mount();
    search.state.open();
    expect(search.input.focus).not.toHaveBeenCalled();
    expect(search.render().searching).toBe(true);
    expect(search.input.focus).toHaveBeenCalledOnce();
  });

  it('opens with slash and leaves editing, nested surfaces, and modified shortcuts alone', () => {
    const search = mount();
    expect(key(documentState.body).defaultPrevented).toBe(true);
    expect(search.render().searching).toBe(true);
    expect(documentState.activeElement).toBe(search.input);
    search.input.focus.mockClear();
    const nested = new Element();
    nested.surface = true;
    for (const [target, options] of [
      [search.input, {}],
      [nested, {}],
      [documentState.body, { metaKey: true }],
      [documentState.body, { ctrlKey: true }],
      [documentState.body, { altKey: true }],
      [documentState.body, { shiftKey: true }],
      [documentState.body, { defaultPrevented: true }],
    ] as const)
      key(target, options);
    expect(search.input.focus).not.toHaveBeenCalled();
  });

  it('keeps a guarded query visible until its clear is accepted', async () => {
    const search = mount('inference');
    search.input.focus();
    search.state.close();
    expect(search.onQuery).toHaveBeenCalledWith('');
    expect(search.render().searching).toBe(true);
    expect(search.trigger.focus).not.toHaveBeenCalled();
    expect(search.render('').searching).toBe(false);
    await Promise.resolve();
    expect(search.trigger.focus).toHaveBeenCalledOnce();
  });

  it('does not take focus from a confirmation or another control after clearing', async () => {
    const search = mount('inference');
    search.input.focus();
    search.state.close();
    const confirmation = new Element();
    documentState.activeElement = confirmation;
    documentState.querySelector.mockReturnValue(confirmation);
    search.render('');
    await Promise.resolve();
    expect(search.trigger.focus).not.toHaveBeenCalled();

    documentState.querySelector.mockReturnValue(null);
    search.state.open();
    const open = search.render();
    open.close();
    documentState.activeElement = new Element();
    search.render();
    await Promise.resolve();
    expect(search.trigger.focus).not.toHaveBeenCalled();
  });

  it('does not focus the hidden mobile search trigger on desktop', async () => {
    const search = mount();
    search.state.open();
    const open = search.render();
    open.close();
    search.render();
    search.trigger.visible = false;
    await Promise.resolve();
    expect(search.trigger.focus).not.toHaveBeenCalled();
  });
});
