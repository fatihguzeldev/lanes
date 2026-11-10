import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSchema } from '../../../contracts/task';
import {
  taskChangeAcknowledged,
  projectTaskChanges,
  projectTaskCollection,
  useTaskChanges,
} from '../useTaskChanges';

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
  return useTaskChanges('account', version);
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
    expect(projectTaskChanges(task, render().items).title).toBe('new title');
    expect(task.title).toBe('old title');
    expect(projectTaskChanges({ ...task, accountId: 'other' }, render().items).title).toBe(
      'old title',
    );
  });

  it('keeps a captured intent in place when dispatch adds its dependent fields', () => {
    render().start('clear-date', task, { ...save('old title'), patch: { scheduledDay: null } });
    render().start('new-date', task, {
      ...save('old title'),
      patch: { scheduledDay: '2026-11-10' },
    });
    render().start('clear-date', task, {
      ...save('old title'),
      patch: { scheduledDay: null, scheduledTime: null, timeZone: null, repeatRule: null },
    });
    expect(render().items.map((item) => item.id)).toEqual(['clear-date', 'new-date']);
    expect(projectTaskCollection([task], render().items)[0]?.scheduledDay).toBe('2026-11-10');
  });

  it('keeps the patch through confirmation until a newer settled read replaces it', () => {
    render().start(1, task, save('new title'));
    const owner = render(2);
    render(5);
    owner.confirm(1);
    const edit = render(5).items[0]!;
    expect(taskChangeAcknowledged(edit, 5)).toBe(false);
    expect(taskChangeAcknowledged(edit, 6)).toBe(true);
    expect(projectTaskChanges(task, [edit], 5).title).toBe('new title');
    expect(projectTaskChanges({ ...task, title: 'confirmed title' }, [edit], 6).title).toBe(
      'confirmed title',
    );
  });

  it('does not remove another task edit when one fails or is acknowledged', () => {
    render().start(1, task, save('first'));
    render().start(2, task, save('second'));
    expect(projectTaskChanges(task, render().items).title).toBe('second');
    render().remove(2);
    expect(projectTaskChanges(task, render().items).title).toBe('first');
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
    render().start(2, projectTaskChanges(task, render().items), save('second'));
    const send = vi.fn(async () => true);
    await render().run('task', send);
    expect(send).toHaveBeenCalledWith(true);
  });
});

it('keeps quick actions and editor changes in one intent order across view reads', () => {
  hooks.slots = [];
  hooks.index = 0;
  render().start('date', task, { ...save('old title'), patch: { scheduledDay: '2026-11-02' } });
  render().start('editor', task, {
    ...save('old title'),
    patch: { scheduledDay: '2026-11-03', starred: true },
  });
  const changes = render().items;
  expect(projectTaskChanges(task, changes).scheduledDay).toBe('2026-11-03');
  expect(projectTaskCollection([task], changes)[0]?.starred).toBe(true);
  expect(projectTaskCollection([], changes)[0]?.scheduledDay).toBe('2026-11-03');
});

it('projects completion and removal through the parent checklist', () => {
  hooks.slots = [];
  hooks.index = 0;
  const child = { ...task, id: 'child', parentId: task.id };
  render().start('complete', task, { ...save('old title'), patch: { completed: true } });
  expect(projectTaskCollection([task, child], render().items).every((item) => item.completed)).toBe(
    true,
  );
  render().start('reopen-child', child, {
    ...save('old title'),
    taskId: child.id,
    patch: { completed: false },
  });
  expect(
    projectTaskCollection([task, child], render().items).every((item) => !item.completed),
  ).toBe(true);
  render().start('delete', task, { ...save('old title'), patch: { removed: true } });
  expect(projectTaskCollection([task, child], render().items)).toEqual([]);
});

it('keeps a confirmed date through an empty intermediate query and hands off only after a newer settled read', () => {
  hooks.slots = [];
  hooks.index = 0;
  const dated = { ...task, scheduledDay: '2026-11-05', scheduledTime: '09:00', timeZone: 'UTC' };
  render().start('date', dated, { ...save('old title'), patch: { scheduledDay: '2026-11-07' } });
  expect(projectTaskCollection([dated], render().items)[0]).toMatchObject({
    scheduledDay: '2026-11-07',
    scheduledTime: '09:00',
    revision: dated.revision,
  });
  render(2).confirm('date');
  expect(projectTaskCollection([], render(2).items, 2)[0]?.scheduledDay).toBe('2026-11-07');
  expect(projectTaskCollection([], render(3).items)[0]?.scheduledDay).toBe('2026-11-07');
  expect(projectTaskCollection([], render(3).items, 3)).toEqual([]);
});

it('keeps the newest date when an older save confirms and restores the earlier confirmed date on failure', async () => {
  hooks.slots = [];
  hooks.index = 0;
  let finish!: (saved: boolean) => void;
  const owner = render();
  owner.start('first-date', task, { ...save('old title'), patch: { scheduledDay: '2026-11-07' } });
  const first = owner.run(
    task.id,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  owner.start('second-date', task, { ...save('old title'), patch: { scheduledDay: '2026-11-08' } });
  const second = owner.run(task.id, async () => false);
  await Promise.resolve();
  finish(true);
  expect(await first).toBe(true);
  render(2).confirm('first-date');
  expect(projectTaskCollection([task], render().items)[0]?.scheduledDay).toBe('2026-11-08');
  expect(await second).toBe(false);
  render().remove('second-date');
  expect(projectTaskCollection([task], render().items)[0]?.scheduledDay).toBe('2026-11-07');
});

it('keeps a date stable if its confirming read finishes before the save callback', () => {
  hooks.slots = [];
  hooks.index = 0;
  render().start('date', task, { ...save('old title'), patch: { scheduledDay: '2026-11-07' } });
  const confirmed = { ...task, scheduledDay: '2026-11-07', revision: task.revision + 1 };
  render(2).confirm('date');
  expect(projectTaskCollection([confirmed], render(2).items, 2)[0]?.scheduledDay).toBe(
    '2026-11-07',
  );
  expect(projectTaskCollection([confirmed], render(3).items, 3)[0]).toEqual(confirmed);
});

it('does not resurrect a deleted task from an older pending movement snapshot', () => {
  hooks.slots = [];
  hooks.index = 0;
  render().start('delete-after-move', task, { ...save('old title'), patch: { removed: true } });
  const moves = [
    {
      id: 'move',
      intent: {
        accountId: 'account',
        taskId: task.id,
        revision: 1,
        sourceListId: 'list',
        destinationListId: 'other-list',
        parentId: null,
        previousTaskId: null,
      },
      task,
      children: [{ ...task, id: 'child', parentId: task.id }],
      readyListIds: [],
      scope: 'account',
      confirmed: false,
    },
  ];
  expect(projectTaskCollection([task], render().items, undefined, () => true, moves)).toEqual([]);
});
