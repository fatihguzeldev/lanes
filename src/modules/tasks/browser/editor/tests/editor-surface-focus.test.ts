import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskEditorSurface } from '../TaskEditorSurface';
import { restoreFocus } from '../../../../../shared/ui/focus/restore-focus';

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../../../../shared/ui/focus/restore-focus', () => ({ restoreFocus: vi.fn() }));
vi.mock('../../../../../shared/ui/viewport/viewport', () => ({
  observeViewport: () => () => {},
  applyViewport: vi.fn(),
}));

class Element extends EventTarget {
  isConnected = true;
  parentNode: Element | null = null;
  parentElement: Element | null = null;
  child: Element | null = null;
  className = '';
  classList = { toggle: vi.fn() };
  dataset = { taskEditorHost: 'task', taskCreateHost: '', accountId: 'account' };
  matches() {
    return true;
  }
  querySelector() {
    return this.child;
  }
  contains(element: unknown) {
    return element === this || element === this.child;
  }
  append(element: Element) {
    element.parentNode = this;
  }
  remove() {
    this.parentNode = null;
  }
}
const dom = Object.assign(new EventTarget(), {
  body: new Element(),
  activeElement: null as Element | null,
  slot: new Element(),
  host: null as Element | null,
  createElement: () => (dom.host = new Element()),
  querySelectorAll: () => [dom.slot],
});
let cleanup: (() => void) | undefined;

function mount(createListId?: string) {
  const opener = new Element();
  const card = new Element();
  card.child = opener;
  dom.slot.parentElement = card;
  dom.activeElement = opener;
  TaskEditorSurface({
    accountId: 'account',
    taskId: createListId ? null : 'task',
    ...(createListId ? { createListId } : {}),
    children: null,
  });
  cleanup = effects.at(-1)!() || undefined;
  return { opener, host: dom.host! };
}
function pointer(target: Element) {
  const event = new Event('pointerdown');
  Object.defineProperty(event, 'target', { value: target });
  dom.dispatchEvent(event);
  if (dom.host?.contains(target)) dom.host.dispatchEvent(event);
}
async function close() {
  dom.activeElement = dom.body;
  cleanup?.();
  cleanup = undefined;
  await Promise.resolve();
}

describe('editor focus after dismissal', () => {
  beforeEach(() => {
    effects.length = 0;
    dom.host = null;
    dom.slot.dataset = { taskEditorHost: 'task', taskCreateHost: '', accountId: 'account' };
    vi.stubGlobal('document', dom);
    vi.stubGlobal('HTMLElement', Element);
    vi.stubGlobal('Node', Element);
    vi.stubGlobal(
      'MutationObserver',
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

  it('does not refocus the old row after a blank outside click closes editing', async () => {
    mount();
    pointer(dom.body);
    await close();
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  it('returns focus quietly after an action inside the editor closes it', async () => {
    const { opener, host } = mount();
    pointer(host);
    await close();
    expect(restoreFocus).toHaveBeenCalledWith(opener, false);
  });

  it('returns keyboard focus after the owner dismisses from inside the editor', async () => {
    const { opener, host } = mount();
    pointer(dom.body);
    host.dispatchEvent(new Event('keydown'));
    await close();
    expect(restoreFocus).toHaveBeenCalledWith(opener, true);
  });

  it('places a new editor in the selected list creation slot', () => {
    dom.slot.dataset.taskCreateHost = 'list';
    const { host } = mount('list');
    expect(host.parentNode).toBe(dom.slot);
    expect(host.classList.toggle).toHaveBeenCalledWith('task-editor-surface--detached', false);
  });

  it('never places a creation draft into another account’s matching list slot', () => {
    dom.slot.dataset.taskCreateHost = 'list';
    dom.slot.dataset.accountId = 'another-account';
    const { host } = mount('list');
    expect(host.parentNode).toBe(dom.body);
  });
});
