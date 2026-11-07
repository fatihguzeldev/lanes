import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema, type Task } from '../../../contracts/task';
import { creationAcknowledged, useTaskCreations } from '../useTaskCreations';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
const reads = vi.hoisted(() => ({ created: vi.fn(), task: vi.fn() }));
vi.mock('../creation-receipt', () => ({ readCreatedTask: reads.created }));
vi.mock('../../queries/references', () => ({ readTask: reads.task }));
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
function render(
  version = 0,
  options?: Parameters<typeof useTaskCreations>[2],
  accountId = 'account',
) {
  hooks.index = 0;
  return useTaskCreations(accountId, version, options);
}

describe('submitted task visibility', () => {
  beforeEach(() => {
    hooks.index = 0;
    hooks.slots = [];
    reads.created.mockReset();
    reads.task.mockReset();
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

  it('keeps rejected input and explicit recovery without replaying a create', () => {
    const edit = vi.fn();
    render().start(1, input('keep my draft'));
    render().fail(1, 'list changed', edit);
    const failed = render().items[0]!;
    expect(failed.input.title).toBe('keep my draft');
    expect(failed.failure?.message).toBe('list changed');
    expect(edit).not.toHaveBeenCalled();
    failed.failure!.onEdit();
    expect(edit).toHaveBeenCalledOnce();
    failed.failure!.onDiscard();
    expect(render().items).toEqual([]);
  });

  it('rejects a creation from another account', () => {
    render().start(1, { ...input('ring64'), accountId: 'other' });
    expect(render().items).toEqual([]);
  });
});

describe('interactive submitted tasks', () => {
  const serverTask = (title: string) =>
    ({ ...input(title), id: 'server-task', revision: 1, completed: false }) as Task;
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  beforeEach(() => {
    hooks.index = 0;
    hooks.slots = [];
    reads.created.mockReset();
    reads.task.mockReset();
  });
  it('keeps edit, star and completion interactive while identity is unresolved, then replays only on the confirmed address', async () => {
    const identity = deferred<Task>();
    let task = serverTask('ring64');
    reads.created.mockReturnValue(identity.promise);
    reads.task.mockImplementation(async () => task);
    const changed = vi.fn();
    const onReady = vi.fn(async (saved: Task, intent: { patch: object; completed?: boolean }) => {
      task = {
        ...saved,
        ...intent.patch,
        ...(intent.completed === undefined ? {} : { completed: intent.completed }),
        revision: 2,
      };
      return true;
    });
    const options = { onReady, onChanged: changed };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    render(0, options).items[0]!.controls!.onComplete(true);
    render(0, options).update(1, {
      ...render(0, options).items[0]!.input,
      title: 'ring64 changed',
    });
    const finished = render(0, options).finish(1, 'receipt');
    expect(onReady).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(render(0, options).items[0]!.input.title).toBe('ring64 changed');
    expect(render(0, options).items[0]!.completed).toBe(true);
    identity.resolve(task);
    await finished;
    expect(reads.created).toHaveBeenCalledWith(
      'account',
      'receipt',
      input('ring64'),
      expect.any(Function),
    );
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-task' }), {
      patch: { title: 'ring64 changed', starred: true },
      completed: true,
    });
    expect(render(0, options).items[0]!.resolvedTaskId).toBe('server-task');
    expect(render(0, options).items[0]!.confirmedAfter).toBe(0);
    expect(changed).toHaveBeenCalledOnce();
  });
  it('drains a newer intent after the previous real task write finishes', async () => {
    let task = serverTask('ring64');
    const write = deferred<boolean>();
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi.fn(async (saved: Task, intent: { patch: object; completed?: boolean }) => {
      if (onReady.mock.calls.length === 1) await write.promise;
      task = {
        ...saved,
        ...intent.patch,
        ...(intent.completed === undefined ? {} : { completed: intent.completed }),
        revision: saved.revision + 1,
      };
      return true;
    });
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    const finished = render(0, options).finish(1, 'receipt');
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledOnce();
    render(0, options).items[0]!.controls!.onComplete(true);
    write.resolve(true);
    await finished;
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady.mock.calls[1]![0].revision).toBe(2);
    expect(onReady.mock.calls[1]![1]).toEqual({ patch: {}, completed: true });
  });
  it('does not overwrite unrelated provider changes with the original create input', async () => {
    reads.created.mockResolvedValue({
      ...serverTask('changed elsewhere'),
      notes: 'external notes',
      completed: true,
    });
    const options = { onReady: vi.fn() };
    render(0, options).start(1, input('ring64'));
    await render(0, options).finish(1, 'receipt');
    expect(options.onReady).not.toHaveBeenCalled();
    expect(render(0, options).items[0]!.confirmedAfter).toBe(0);
  });
  it('can reverse the first local intent while its real write is in flight', async () => {
    let task = serverTask('ring64');
    const first = deferred<boolean>();
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi.fn(async (saved: Task, intent: { patch: object }) => {
      if (onReady.mock.calls.length === 1) await first.promise;
      task = { ...saved, ...intent.patch, revision: saved.revision + 1 };
      return true;
    });
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    const finished = render(0, options).finish(1, 'receipt');
    await Promise.resolve();
    render(0, options).items[0]!.controls!.onStar(false);
    first.resolve(true);
    await finished;
    expect(onReady.mock.calls.map((call) => call[1].patch)).toEqual([
      { starred: true },
      { starred: false },
    ]);
    expect(task.starred).toBe(false);
  });
  it('never replays an unconfirmed followup while checking its save', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    const onReady = vi.fn().mockResolvedValue(false);
    const options = { onReady, onError: vi.fn() };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    await render(0, options).finish(1, 'receipt');
    expect(render(0, options).items[0]!.failure?.actionLabel).toBe('check save');
    await render(0, options).finish(1, 'receipt');
    expect(onReady).toHaveBeenCalledOnce();
    expect(render(0, options).items[0]!.confirmedAfter).toBeNull();
    expect(render(0, options).items[0]!.input.starred).toBe(true);
  });
  it('recovers only the identity read after the confirmed create response is delayed', async () => {
    reads.created
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(serverTask('ring64'));
    const onReady = vi.fn();
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    await render(0, options).finish(1, 'receipt');
    expect(render(0, options).items[0]!.failure?.message).toBe('offline');
    await render(0, options).finish(1, 'receipt');
    expect(reads.created).toHaveBeenCalledTimes(2);
    expect(onReady).not.toHaveBeenCalled();
    expect(render(0, options).items[0]!.failure).toBeUndefined();
    expect(render(0, options).busy).toBe(false);
  });
  it('queues a pending deletion without sending a local id to a task command', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    const onReady = vi.fn().mockResolvedValue(true);
    const options = { onReady };
    render(0, options).start(41, input('ring64'));
    render(0, options).items[0]!.controls!.onDelete();
    expect(render(0, options).items[0]!.deleted).toBe(true);
    await render(0, options).finish(41, 'receipt');
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-task' }), {
      patch: {},
      deleted: true,
    });
    expect(render(0, options).items).toEqual([]);
  });
  it('keeps controls live while the confirmed row awaits a newer query', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi.fn(async (saved: Task, intent: { patch: object }) => {
      task = { ...saved, ...intent.patch, revision: saved.revision + 1 };
      return true;
    });
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    await render(0, options).finish(1, 'receipt');
    render(0, options).items[0]!.controls!.onStar(true);
    await render(0, options).finish(1, 'receipt');
    expect(onReady).toHaveBeenCalledOnce();
    expect(render(0, options).items[0]!.input.starred).toBe(true);
  });
  it('does not let an older query acknowledgement discard a newly queued intent', () => {
    render().start(1, input('ring64'));
    render().confirm(1);
    const staleAcknowledgement = render().acknowledge;
    render().items[0]!.controls!.onStar(true);
    staleAcknowledgement(1);
    expect(render().items).toHaveLength(1);
    expect(render().items[0]!.input.starred).toBe(true);
    expect(render().items[0]!.confirmedAfter).toBeNull();
  });
  it('does not accept new local intent while disconnected, including a stale control callback', () => {
    render(0, { editable: true }).start(1, input('ring64'));
    const controls = render(0, { editable: true }).items[0]!.controls!;
    controls.onStar(true);
    const offline = render(0, { editable: false });
    expect(offline.items[0]!.controls?.disabled).toBe(true);
    controls.onComplete(true);
    controls.onDelete();
    offline.update(1, { ...input('changed offline'), starred: false });
    const retained = render(0, { editable: false }).items[0]!;
    expect(retained.input.title).toBe('ring64');
    expect(retained.input.starred).toBe(true);
    expect(retained.completed).toBeUndefined();
    expect(retained.deleted).toBeUndefined();
  });
  it('does not let an older acknowledged row discard a newer confirmed draft in the same version', () => {
    render().start(1, input('ring64'));
    render().confirm(1);
    const oldRead = render().acknowledge;
    render().items[0]!.controls!.onStar(true);
    render().confirm(1);
    oldRead(1);
    expect(render().items).toHaveLength(1);
    render().acknowledge(1);
    expect(render().items).toEqual([]);
  });
  it('ignores late identity reads after the account scope changes', async () => {
    const identity = deferred<Task>();
    reads.created.mockReturnValue(identity.promise);
    const options = { onReady: vi.fn(), onChanged: vi.fn() };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    const finished = render(0, options).finish(1, 'receipt');
    render(0, options, 'other');
    identity.resolve(serverTask('ring64'));
    await finished;
    expect(options.onReady).not.toHaveBeenCalled();
    expect(options.onChanged).not.toHaveBeenCalled();
  });
});

it('guards failed drafts without discarding saves that are still running', () => {
  hooks.index = 0;
  hooks.slots = [];
  render().start(1, input('rejected'));
  render().start(2, input('still saving'));
  expect(render().hasDrafts).toBe(false);
  render().fail(1, 'list changed', () => {});
  expect(render().hasDrafts).toBe(true);
  render().discardDrafts();
  expect(render().items.map((item) => item.id)).toEqual([2]);
  expect(render().hasDrafts).toBe(false);
});
