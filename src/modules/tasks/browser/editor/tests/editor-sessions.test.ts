import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskEditor } from '../useTaskEditor';
import type { EditorLocation } from '../editor-contract';
import type { Task } from '../../../contracts/task';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
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
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
}));
const task = (id: string) => ({ id, accountId: 'account', listId: 'list', title: id }) as Task;
const location = { list: { id: 'list', accountId: 'account' }, boardId: 'board' } as EditorLocation;
function render() {
  hooks.index = 0;
  return useTaskEditor(async () => location, vi.fn());
}

describe('task editor session ownership', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
  });

  it('retains saving ownership after the editor presentation closes', () => {
    render().open(task('first'), location);
    const current = render();
    const id = current.session!.id;
    current.setSaving(id, true);
    current.close(id);
    expect(render().selection).toBeNull();
    expect(render().saving).toBe(true);
    render().setSaving(id, false);
    expect(render().saving).toBe(false);
  });

  it('does not close a new editor when an older save completes', () => {
    render().open(task('first'), location);
    const old = render();
    const oldId = old.session!.id;
    old.close(oldId);
    render().open(task('second'), location);
    const nextId = render().session!.id;
    expect(nextId).not.toBe(oldId);
    old.close(oldId);
    expect(render().selection?.task?.id).toBe('second');
  });

  it('ignores dirty callbacks from a retired presentation', () => {
    render().open(task('first'), location);
    const old = render();
    const oldId = old.session!.id;
    render().open(task('second'), location);
    const nextId = render().session!.id;
    render().setDirty(true, nextId);
    old.setDirty(false, oldId);
    expect(render().dirty).toBe(true);
    old.setDirty(true, oldId);
    render().setDirty(false, nextId);
    expect(render().dirty).toBe(false);
  });

  it('tracks each save independently instead of sharing a busy flag between editors', () => {
    render().open(task('first'), location);
    const first = render().session!.id;
    render().setSaving(first, true);
    render().open(task('second'), location);
    const second = render().session!.id;
    render().setSaving(second, true);
    render().setSaving(first, false);
    expect(render().saving).toBe(true);
    render().setSaving(second, false);
    expect(render().saving).toBe(false);
  });
});
