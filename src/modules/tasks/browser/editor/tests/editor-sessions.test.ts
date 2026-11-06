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
const readLocation = vi.fn();
const notice = vi.fn();
function render() {
  hooks.index = 0;
  return useTaskEditor(readLocation, notice);
}

describe('task editor session ownership', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
    readLocation.mockReset().mockResolvedValue(location);
    notice.mockReset();
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

  it('exposes dirty changes to a guard from the same pointer event', () => {
    render().open(task('first'), location);
    const current = render();
    current.setDirty(true);
    expect(current.isDirty()).toBe(true);
    current.setDirty(false);
    expect(current.isDirty()).toBe(false);
  });

  it('exposes save admission before a following account action can unmount it', () => {
    render().open(task('first'), location);
    const current = render();
    const id = current.session!.id;
    current.setSaving(id, true);
    expect(current.isSaving()).toBe(true);
    current.setSaving(id, false);
    expect(current.isSaving()).toBe(false);
  });

  it('continues an outside navigation after an inline create has captured its receipt', async () => {
    render().createInline(location);
    const current = render();
    const id = current.session!.id;
    current.setDirty(true);
    current.setSaving(id, true);
    const navigate = vi.fn();
    expect(current.deferCreateExit(navigate)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    current.setDirty(false);
    current.close(id);
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('keeps an unadmitted failed create and drops its deferred navigation', async () => {
    render().createInline(location);
    const current = render();
    const id = current.session!.id;
    current.setDirty(true);
    current.setSaving(id, true);
    const navigate = vi.fn();
    current.deferCreateExit(navigate);
    current.setSaving(id, false);
    current.setDirty(false);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(render().selection?.inlineCreate).toBe(true);
  });

  it('does not run a deferred create exit over a newer editor choice', async () => {
    render().createInline(location);
    const current = render();
    current.setDirty(true);
    current.setSaving(current.session!.id, true);
    const navigate = vi.fn();
    current.deferCreateExit(navigate);
    current.setDirty(false);
    current.open(task('newer'), location);
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(render().selection?.task?.id).toBe('newer');
  });

  it('does not replace a newer dirty editor when an older location lookup finishes', async () => {
    let resolve!: (value: EditorLocation) => void;
    readLocation.mockImplementation(() => new Promise((done) => (resolve = done)));
    render().open(task('old-lookup'));
    render().open(task('new-draft'), location);
    render().setDirty(true);
    resolve(location);
    await Promise.resolve();
    expect(render().selection?.task?.id).toBe('new-draft');
    expect(render().dirty).toBe(true);
  });

  it('does not open a creation lookup after the owner dismisses it', async () => {
    let resolve!: (value: EditorLocation) => void;
    readLocation.mockImplementation(() => new Promise((done) => (resolve = done)));
    render().create('list', '2026-11-06');
    render().close();
    resolve(location);
    await Promise.resolve();
    expect(render().selection).toBeNull();
  });

  it('lets a chosen subtask entry supersede an older location lookup', async () => {
    let resolve!: (value: EditorLocation) => void;
    readLocation.mockImplementation(() => new Promise((done) => (resolve = done)));
    render().open(task('parent'), location);
    render().open(task('old-lookup'));
    render().createSubtask(task('parent'));
    resolve(location);
    await Promise.resolve();
    expect(render().selection?.task).toBeNull();
    expect(render().selection?.parent?.id).toBe('parent');
  });

  it('ignores a stale lookup failure after another editor opens', async () => {
    let reject!: (reason: Error) => void;
    readLocation.mockImplementation(() => new Promise((_done, failed) => (reject = failed)));
    render().open(task('old-lookup'));
    render().open(task('new-draft'), location);
    reject(new Error('old list could not load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(notice).not.toHaveBeenCalled();
    expect(render().selection?.task?.id).toBe('new-draft');
  });

  it('keeps a new pending lookup when an old session finishes saving', async () => {
    let resolve!: (value: EditorLocation) => void;
    readLocation.mockImplementation(() => new Promise((done) => (resolve = done)));
    render().open(task('saved'), location);
    const oldId = render().session!.id;
    render().open(task('new-lookup'));
    render().closeSaved(oldId);
    resolve(location);
    await Promise.resolve();
    expect(render().selection?.task?.id).toBe('new-lookup');
  });

  it('cancels a pending lookup when the current editor is explicitly dismissed', async () => {
    let resolve!: (value: EditorLocation) => void;
    readLocation.mockImplementation(() => new Promise((done) => (resolve = done)));
    render().open(task('current'), location);
    const currentId = render().session!.id;
    render().open(task('pending'));
    render().close(currentId);
    resolve(location);
    await Promise.resolve();
    expect(render().selection).toBeNull();
  });
});
