import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineField } from '../InlineField';

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  outside: () => {},
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.slots))
      harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      harness.slots[index],
      (value: unknown) => {
        harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = harness.cursor++;
    return (harness.slots[index] ??= { current: initial });
  },
  useEffect(effect: () => void) {
    harness.effects.push(effect);
  },
}));
vi.mock('../../dismiss/useOutsideDismiss', () => ({
  useOutsideDismiss: (_ref: unknown, close: () => void) => {
    harness.outside = close;
  },
}));
type Element = ReactElement<Record<string, any>>;
const commit = vi.fn();
const cancel = vi.fn();
function render(value = 'reading', initialDraft?: string) {
  harness.cursor = 0;
  harness.effects = [];
  const root = InlineField({
    value,
    label: 'name',
    onCommit: commit,
    onCancel: cancel,
    initialDraft,
  }) as Element;
  harness.effects.forEach((effect) => effect());
  return (root.props.children as Element[])[0]!;
}
function type(value: string) {
  render().props.onChange({ target: { value } });
}
function key(key: string, isComposing = false) {
  const event = {
    key,
    nativeEvent: { isComposing },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  render().props.onKeyDown(event);
  return event;
}
beforeEach(() => {
  harness.slots = [];
  commit.mockReset();
  cancel.mockClear();
  commit.mockResolvedValue(true);
});
describe('inline field completion', () => {
  it('restores a failed draft without mistaking it for the confirmed value', async () => {
    const input = render('reading', 'books');
    expect(input.props.value).toBe('books');
    input.props.onBlur();
    expect(commit).toHaveBeenCalledExactlyOnceWith('books');
    await Promise.resolve();
  });
  it('commits a changed name once across enter, blur and outside dismissal', async () => {
    let finish!: (done: boolean) => void;
    commit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    type('  writing  ');
    key('Enter');
    render().props.onBlur();
    harness.outside();
    expect(commit).toHaveBeenCalledExactlyOnceWith('writing');
    finish(true);
    await Promise.resolve();
    expect(render().props.value).toBe('writing');
  });
  it('ignores blank, unchanged and composing entries', () => {
    type('reading');
    render().props.onBlur();
    type('   ');
    render().props.onBlur();
    type('writing');
    key('Enter', true);
    expect(commit).not.toHaveBeenCalled();
  });
  it('discards an unsubmitted edit on escape', () => {
    type('writing');
    key('Escape');
    render().props.onBlur();
    harness.outside();
    expect(render().props.value).toBe('reading');
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not cancel a write already in flight', async () => {
    let finish!: (done: boolean) => void;
    commit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    type('writing');
    key('Enter');
    key('Escape');
    expect(cancel).not.toHaveBeenCalled();
    finish(true);
    await Promise.resolve();
  });
  it('retains a rejected edit for correction', async () => {
    commit.mockResolvedValue(false);
    type('writing');
    render().props.onBlur();
    await Promise.resolve();
    expect(render().props.value).toBe('writing');
    expect(render().props['aria-invalid']).toBe(true);
  });
});
