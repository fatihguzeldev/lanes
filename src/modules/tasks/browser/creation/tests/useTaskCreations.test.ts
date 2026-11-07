import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema } from '../../../contracts/task';
import { creationAcknowledged, useTaskCreations } from '../useTaskCreations';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => (hooks.slots[hooks.index++] ??= { current: initial }),
}));
const input = (title: string) =>
  CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title });
function render(version = 0) {
  hooks.index = 0;
  return useTaskCreations('account', version);
}

describe('submitted task visibility', () => {
  beforeEach(() => {
    hooks.index = 0;
    hooks.slots = [];
  });

  it('captures the input while submission is pending and keeps concurrent creations separate', () => {
    const draft = input('ring64');
    render().start(1, draft);
    draft.title = 'changed later';
    render().start(2, input('another task'));
    expect(render().items.map((item) => item.input.title)).toEqual(['another task', 'ring64']);
    expect(render().items.every((item) => item.confirmedAfter === null)).toBe(true);
  });

  it('keeps the row until a list read started after confirmation finishes', () => {
    const owner = render(2);
    owner.start(1, input('ring64'));
    render(5);
    owner.confirm(1);
    const [creation] = render(5).items;
    expect(creation!.confirmedAfter).toBe(5);
    expect(creationAcknowledged(creation!)).toBe(false);
    expect(creationAcknowledged(creation!, 4)).toBe(false);
    expect(creationAcknowledged(creation!, 5)).toBe(false);
    expect(creationAcknowledged(creation!, 6)).toBe(true);
    expect(render().items).toHaveLength(1);
  });

  it('does not acknowledge a pending row even when unrelated reads complete', () => {
    render().start(1, input('ring64'));
    expect(creationAcknowledged(render().items[0]!, 100)).toBe(false);
  });

  it('does not move the confirmation boundary when success is reported again', () => {
    render().start(1, input('ring64'));
    render(3).confirm(1);
    render(4).confirm(1);
    expect(render().items[0]!.confirmedAfter).toBe(3);
  });

  it('removes only the acknowledged or failed row', () => {
    render().start(1, input('ring64'));
    render().start(2, input('another task'));
    render().remove(1);
    expect(render().items.map((item) => item.id)).toEqual([2]);
    render().remove(1);
    expect(render().items.map((item) => item.id)).toEqual([2]);
  });

  it('preserves a corrected retry without adding a second local row', () => {
    render().start(1, input('ring64'));
    render().start(1, input('corrected title'));
    expect(render().items.map((item) => item.input.title)).toEqual(['corrected title']);
  });

  it('rejects a creation from another account', () => {
    render().start(1, { ...input('ring64'), accountId: 'other' });
    expect(render().items).toEqual([]);
  });
});
