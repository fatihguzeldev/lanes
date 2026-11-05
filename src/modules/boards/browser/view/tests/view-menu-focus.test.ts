import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceViewMenu } from '../WorkspaceViewMenu';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void>,
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
  useLayoutEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (previous && dependencies.every((value, key) => Object.is(value, previous[key]))) return;
    hooks.slots[index] = dependencies;
    hooks.effects.push(effect);
  },
}));

const props: ComponentProps<typeof WorkspaceViewMenu> = {
  allowLayout: true,
  view: 'board',
  sort: 'manual',
  filter: {},
  lists: [],
  labels: [],
  today: '2026-11-05',
  moreLists: false,
  moreLabels: false,
  onView: vi.fn(),
  onSort: vi.fn(),
  onFilter: vi.fn(),
  onClear: vi.fn(),
  onMoreLists: vi.fn(),
  onMoreLabels: vi.fn(),
};

interface Button {
  focus: ReturnType<typeof vi.fn>;
  onClick: () => void;
}

function mount() {
  const buttons = new Map<string, Button>();
  const assigned: RefObject<Button | null>[] = [];
  let focused: string | null = null;
  function attach(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (
        !isValidElement<{
          children?: ReactNode;
          ref?: RefObject<Button | null>;
          onClick?: () => void;
        }>(child)
      )
        return;
      if (child.type === 'button') {
        const label = Children.toArray(child.props.children)
          .filter((item) => typeof item === 'string')
          .join('')
          .trim();
        const button = {
          focus: vi.fn(() => (focused = label)),
          onClick: child.props.onClick ?? (() => {}),
        };
        buttons.set(label, button);
        if (child.props.ref) {
          child.props.ref.current = button;
          assigned.push(child.props.ref);
        }
      }
      attach(child.props.children);
    });
  }
  function render(open: boolean) {
    assigned.splice(0).forEach((ref) => (ref.current = null));
    buttons.clear();
    focused = null;
    hooks.cursor = 0;
    const menu = WorkspaceViewMenu(props);
    if (open && typeof menu.props.children === 'function')
      attach(menu.props.children(vi.fn(), {} as HTMLElement));
    hooks.effects.splice(0).forEach((effect) => effect());
  }
  return { buttons, render, focused: () => focused };
}

describe('view menu page focus', () => {
  beforeEach(() => {
    hooks.cursor = 0;
    hooks.slots.length = 0;
    hooks.effects.length = 0;
  });

  it('focuses the filter page and restores its originating action when returning', () => {
    const menu = mount();
    menu.render(false);
    expect(menu.focused()).toBeNull();
    menu.render(true);
    expect(menu.focused()).toBeNull();
    menu.buttons.get('filter tasks')!.onClick();
    menu.render(true);
    expect(menu.focused()).toBe('view options');
    menu.buttons.get('view options')!.onClick();
    menu.render(true);
    expect(menu.focused()).toBe('filter tasks');
  });

  it('does not move focus when a filter page closes together with its popover', () => {
    const menu = mount();
    menu.render(true);
    menu.buttons.get('filter tasks')!.onClick();
    menu.render(true);
    menu.buttons.get('view options')!.onClick();
    menu.render(false);
    expect(menu.focused()).toBeNull();
  });
});
