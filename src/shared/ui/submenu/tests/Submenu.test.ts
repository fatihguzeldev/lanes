import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Submenu } from '../Submenu';
import { AnchoredPopover } from '../../popover/Popover';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useId: () => 'destinations',
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
class Element extends EventTarget {
  isConnected = true;
  children: Element[] = [];
  focus = vi.fn();
  setAttribute = vi.fn();
  removeAttribute = vi.fn();
  contains(element: unknown) {
    return element === this || this.children.includes(element as Element);
  }
}
type UI = ReactElement<Record<string, any>>;
function mount(options: Partial<Parameters<typeof Submenu>[0]> = {}) {
  const props = { label: 'move task', trigger: 'move task', children: 'destinations', ...options };
  const render = () => {
    hooks.index = 0;
    return Submenu(props) as UI;
  };
  let tree = render();
  const trigger = (tree.props.children as UI[])[0]!;
  trigger.props.ref.current = new Element();
  tree.props.ref.current = new Element();
  return {
    render,
    get trigger() {
      return (render().props.children as UI[])[0]!;
    },
    get wrapper() {
      return render();
    },
    get panel() {
      return (render().props.children as UI[])[1] as UI | false;
    },
  };
}
const pointer = (type = 'mouse', target: unknown = null) => ({
  pointerType: type,
  relatedTarget: target,
});
const key = (value: string) => ({ key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe('cascading submenu interaction', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
    hooks.effects = [];
    vi.useFakeTimers();
    vi.stubGlobal('Node', Element);
    vi.stubGlobal('Element', Element);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reveals a side panel on hover without moving keyboard focus', () => {
    const menu = mount();
    expect(menu.panel).toBe(false);
    menu.wrapper.props.onPointerEnter(pointer());
    expect(menu.trigger.props['aria-expanded']).toBe(true);
    expect((menu.panel as UI).type).toBe(AnchoredPopover);
    expect((menu.panel as UI).props).toMatchObject({ placement: 'side', focusOnOpen: 'none' });
  });

  it('keeps the cascade open while crossing the gap into its child', () => {
    const menu = mount();
    menu.wrapper.props.onPointerEnter(pointer());
    menu.wrapper.props.onPointerLeave(pointer());
    vi.advanceTimersByTime(150);
    expect(menu.trigger.props['aria-expanded']).toBe(true);
    const content = (menu.panel as UI).props.children as UI;
    content.props.onPointerEnter(pointer());
    vi.advanceTimersByTime(500);
    expect(menu.trigger.props['aria-expanded']).toBe(true);
    menu.wrapper.props.onPointerLeave(pointer());
    vi.advanceTimersByTime(220);
    expect(menu.trigger.props['aria-expanded']).toBe(false);
  });

  it('keeps a hovered cascade open when the mouse clicks its trigger', () => {
    const menu = mount();
    menu.wrapper.props.onPointerEnter(pointer());
    expect(menu.trigger.props.popoverTarget).toBe((menu.panel as UI).props.id);
    expect(menu.trigger.props.popoverTargetAction).toBe('show');
    menu.trigger.props.onClick({ detail: 1 });
    expect(menu.trigger.props['aria-expanded']).toBe(true);
  });

  it('uses a tap rather than touch hover and does not close on finger lift', () => {
    const menu = mount();
    menu.wrapper.props.onPointerEnter(pointer('touch'));
    expect(menu.trigger.props['aria-expanded']).toBe(false);
    menu.trigger.props.onPointerDown(pointer('touch'));
    menu.trigger.props.onClick({ detail: 1 });
    menu.wrapper.props.onPointerLeave(pointer('touch'));
    vi.advanceTimersByTime(500);
    expect(menu.trigger.props['aria-expanded']).toBe(true);
    menu.trigger.props.onClick({ detail: 1 });
    expect(menu.trigger.props['aria-expanded']).toBe(false);
    expect(menu.trigger.props.popoverTarget).toBeUndefined();
  });

  it('opens with Right and returns focus with Left without closing its parent', () => {
    const menu = mount();
    const right = key('ArrowRight');
    menu.trigger.props.onKeyDown(right);
    expect(right.preventDefault).toHaveBeenCalledOnce();
    expect((menu.panel as UI).props.focusOnOpen).toBe(true);
    const left = { ...key('ArrowLeft'), target: null };
    const content = (menu.panel as UI).props.children as UI;
    content.props.onKeyDown(left);
    expect(left.stopPropagation).toHaveBeenCalledOnce();
    expect(menu.trigger.props['aria-expanded']).toBe(false);
    expect(menu.trigger.props.ref.current.focus).toHaveBeenCalledOnce();
  });

  it('lets a durable owner control opening and successful dismissal', () => {
    const changed = vi.fn();
    const menu = mount({ open: false, onOpenChange: changed });
    menu.wrapper.props.onPointerEnter(pointer());
    expect(changed).toHaveBeenCalledWith(true, menu.trigger.props.ref.current);
    expect(menu.trigger.props['aria-expanded']).toBe(false);
  });

  it('provides a back action for touch cascades without dismissing the parent', () => {
    const menu = mount();
    menu.trigger.props.onPointerDown(pointer('touch'));
    menu.trigger.props.onClick({ detail: 1 });
    const content = (menu.panel as UI).props.children as UI;
    const back = (content.props.children as UI[])[0]!;
    expect(back.props['aria-label']).toBe('back from move task');
    back.props.onClick({ detail: 1 });
    expect(menu.trigger.props['aria-expanded']).toBe(false);
    expect(menu.trigger.props.ref.current.focus).toHaveBeenCalledOnce();
  });

  it('never opens a disabled destination', () => {
    const changed = vi.fn();
    const menu = mount({ disabled: true, onOpenChange: changed });
    menu.wrapper.props.onPointerEnter(pointer());
    menu.trigger.props.onClick({ detail: 1 });
    expect(changed).not.toHaveBeenCalled();
    expect(menu.trigger.props['aria-expanded']).toBe(false);
  });
});
