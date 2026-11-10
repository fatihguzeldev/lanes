import { beforeEach, expect, it, vi } from 'vitest';
import type { ConfirmationChoice } from '../Confirmation';
import { useConfirmationQueue } from '../useConfirmationQueue';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock('react', () => ({
  useCallback: (value: unknown) => value,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = value;
      },
    ];
  },
  useRef: (current: unknown) => (hooks.slots[hooks.index++] ??= { current }),
  useEffect(effect: () => () => void) {
    hooks.cleanup ??= effect();
  },
}));
const choice = (title: string): ConfirmationChoice => ({
  title,
  message: 'confirm this change',
  confirmLabel: 'continue',
  onConfirm: vi.fn(async () => true),
  onCancel: vi.fn(),
});
function render() {
  hooks.index = 0;
  return useConfirmationQueue();
}
beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.cleanup = undefined;
});

it('keeps overlapping decisions reachable in order and ignores a stale close', () => {
  const first = choice('first'),
    second = choice('second');
  render().request(first);
  render().request(second);
  const selected = render().current!;
  expect(selected.choice).toBe(first);
  render().close(selected.id);
  const next = render().current!;
  expect(next.choice).toBe(second);
  expect(next.id).not.toBe(selected.id);
  render().close(selected.id);
  expect(render().current?.choice).toBe(second);
  next.choice.onCancel?.();
  render().close(next.id);
  expect(render().current).toBeNull();
  expect(first.onCancel).not.toHaveBeenCalled();
  expect(second.onCancel).toHaveBeenCalledOnce();
});

it('does not cancel captured work while disposing unresolved decisions exactly once', () => {
  const captured = choice('captured'),
    waiting = choice('waiting');
  const queue = render();
  queue.request(captured);
  queue.request(waiting);
  queue.close(render().current!.id);
  hooks.cleanup!();
  hooks.cleanup!();
  expect(captured.onCancel).not.toHaveBeenCalled();
  expect(waiting.onCancel).toHaveBeenCalledOnce();
  const late = choice('late');
  queue.request(late);
  expect(late.onCancel).toHaveBeenCalledOnce();
});

it('resolves every overlapping request instead of leaving a task lane stranded', async () => {
  const queue = render();
  const outcomes: string[] = [];
  const ask = (title: string) =>
    new Promise<boolean>((resolve) => {
      queue.request({
        ...choice(title),
        onConfirm: async () => {
          outcomes.push(title);
          resolve(true);
          return true;
        },
        onCancel: () => resolve(false),
      });
    });
  const first = ask('first'),
    second = ask('second');
  const a = render().current!;
  const work = a.choice.onConfirm('first-receipt');
  queue.close(a.id);
  const b = render().current!;
  b.choice.onCancel?.();
  queue.close(b.id);
  expect(await Promise.all([first, second])).toEqual([true, false]);
  expect(await work).toBe(true);
  expect(outcomes).toEqual(['first']);
  expect(render().current).toBeNull();
});
