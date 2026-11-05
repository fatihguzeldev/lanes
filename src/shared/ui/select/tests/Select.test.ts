import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../Select';

const state = vi.hoisted(() => ({ open: true, setOpen: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) =>
    typeof initial === 'boolean' ? [state.open, state.setOpen] : [initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useId: () => 'select',
  useLayoutEffect: () => {},
}));

function escape(open: boolean) {
  state.open = open;
  state.setOpen.mockClear();
  const tree = Select({ value: 'none', onChange: vi.fn(), options: [] });
  const button = tree.props.children[0] as ReactElement<{
    onKeyDown(event: unknown): void;
  }>;
  const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
  button.props.onKeyDown(event);
  return event;
}

describe('select inside an editor', () => {
  it('dismisses its open options without dismissing the parent editor', () => {
    const event = escape(true);
    expect(state.setOpen).toHaveBeenCalledWith(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('leaves Escape available to its parent when options are already closed', () => {
    const event = escape(false);
    expect(state.setOpen).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
