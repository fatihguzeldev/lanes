import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSchema } from '../../../contracts/task';
import { editAcknowledged, projectTaskEdits, useTaskEdits } from '../useTaskEdits';

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
const task = TaskSchema.parse({
  id: 'task',
  accountId: 'account',
  listId: 'list',
  parentId: null,
  title: 'old title',
  notes: '',
  completed: false,
  completedAt: null,
  scheduledDay: null,
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  seriesId: null,
  occurrenceId: null,
  labelIds: [],
  priority: 'none',
  starred: false,
  blockedBy: [],
  revision: 1,
  provider: {
    id: 'provider',
    listId: 'provider-list',
    etag: null,
    position: null,
    updatedAt: null,
  },
  capabilities: {
    canEdit: true,
    canEditNotes: true,
    canMove: true,
    canDelete: true,
    canHaveChildren: true,
    canNest: true,
    assignmentSource: null,
    sourceUrl: null,
    restriction: null,
  },
  unsupportedHierarchy: false,
});
const save = (title: string) => ({
  accountId: 'account',
  taskId: 'task',
  listId: 'list',
  expectedRevision: 1,
  patch: { title },
});
function render(version = 0) {
  hooks.index = 0;
  return useTaskEdits('account', version);
}

describe('background task edits', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
  });

  it('shows the captured patch immediately without modifying confirmed task data', () => {
    const input = save('new title');
    render().start(1, task, input);
    input.patch.title = 'later mutation';
    expect(projectTaskEdits(task, render().items).title).toBe('new title');
    expect(task.title).toBe('old title');
    expect(projectTaskEdits({ ...task, accountId: 'other' }, render().items).title).toBe(
      'old title',
    );
  });

  it('keeps the patch through confirmation until a newer settled read replaces it', () => {
    render().start(1, task, save('new title'));
    const owner = render(2);
    render(5);
    owner.confirm(1);
    const edit = render(5).items[0]!;
    expect(editAcknowledged(edit, 5)).toBe(false);
    expect(editAcknowledged(edit, 6)).toBe(true);
    expect(projectTaskEdits(task, [edit], 5).title).toBe('new title');
    expect(projectTaskEdits({ ...task, title: 'confirmed title' }, [edit], 6).title).toBe(
      'confirmed title',
    );
  });

  it('does not remove another task edit when one fails or is acknowledged', () => {
    render().start(1, task, save('first'));
    render().start(2, task, save('second'));
    expect(projectTaskEdits(task, render().items).title).toBe('second');
    render().remove(2);
    expect(projectTaskEdits(task, render().items).title).toBe('first');
  });

  it('serializes writes to one task and marks only waiting jobs for rebasing', async () => {
    let finish!: (saved: boolean) => void;
    const first = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const second = vi.fn(async () => true);
    const owner = render();
    const a = owner.run('task', first);
    const b = owner.run('task', second);
    await Promise.resolve();
    expect(first).toHaveBeenCalledWith(false);
    expect(second).not.toHaveBeenCalled();
    finish(true);
    await Promise.all([a, b]);
    expect(second).toHaveBeenCalledWith(true);
  });

  it('does not send dependent queued edits after their predecessor fails', async () => {
    const owner = render();
    const first = owner.run('task', async () => false);
    const secondJob = vi.fn(async () => true);
    const second = owner.run('task', secondJob);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(secondJob).not.toHaveBeenCalled();
    expect(await owner.run('task', async () => true)).toBe(true);
  });

  it('rebases an edit captured from a confirmed preview before the next query arrives', async () => {
    const owner = render();
    owner.start(1, task, save('first'));
    await owner.run('task', async () => true);
    render(2).confirm(1);
    render().start(2, projectTaskEdits(task, render().items), save('second'));
    const send = vi.fn(async () => true);
    await render().run('task', send);
    expect(send).toHaveBeenCalledWith(true);
  });
});
