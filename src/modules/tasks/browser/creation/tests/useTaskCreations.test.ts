import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskSchema, type Task } from '../../../contracts/task';
import { useTaskCreations } from '../useTaskCreations';
import { creationAcknowledged } from '../creation-model';
import { RequestError } from '../../../../../shared/browser/http/http';
import { TaskCreationPreview } from '../TaskCreationPreview';
import type { OperationSummary } from '../../../../operations/contracts/receipt';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { TaskQueries } from '../../../server/queries/tasks';
import { TaskMetadataService } from '../../../server/metadata/tasks';
import { HistoryService } from '../../../../history/server/events/event-store';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
const reads = vi.hoisted(() => ({ created: vi.fn(), task: vi.fn(), operation: vi.fn() }));
vi.mock('../creation-receipt', () => ({ readCreatedTask: reads.created }));
vi.mock('../../queries/references', () => ({ readTask: reads.task }));
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: reads.operation,
}));
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
    reads.operation.mockReset();
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
    const creation = { ...render(5).items[0]!, resolvedTaskId: 'saved-task' };
    expect(creation.confirmedAfter).toBe(5);
    expect(creationAcknowledged(creation)).toBe(false);
    expect(creationAcknowledged(creation, 4, ['saved-task'])).toBe(false);
    expect(creationAcknowledged(creation, 5, ['saved-task'])).toBe(false);
    expect(creationAcknowledged(creation, 6, ['saved-task'])).toBe(true);
    expect(render().items).toHaveLength(1);
  });

  it('does not acknowledge a pending row even when unrelated reads complete', () => {
    render().start(1, input('ring64'));
    expect(creationAcknowledged(render().items[0]!, 100)).toBe(false);
  });

  it('keeps a confirmed creation until a fresh read verifies that task’s own order', () => {
    const creation = {
      id: 1,
      input: input('gdg gaziantep'),
      resolvedTaskId: 'saved-task',
      confirmedAfter: 5,
    };
    expect(creationAcknowledged(creation, 6, [])).toBe(false);
    expect(creationAcknowledged(creation, 6, ['other-task'])).toBe(false);
    expect(creationAcknowledged(creation, 5, ['saved-task'])).toBe(false);
    expect(creationAcknowledged(creation, 6, ['saved-task'])).toBe(true);
    const { resolvedTaskId: _id, ...unresolved } = creation;
    expect(creationAcknowledged(unresolved, 6, ['saved-task'])).toBe(false);
  });

  it('retains a confirmed creation while its editor owns a draft and rereads on release', async () => {
    reads.created.mockResolvedValue({
      ...input('original'),
      id: 'saved-task',
      completed: false,
    } as Task);
    const changed = vi.fn();
    const options = { onChanged: changed };
    render(0, options).start(1, input('original'));
    await render(0, options).finish(1, 'receipt');
    changed.mockClear();
    const oldRead = render(1, options).acknowledge;
    const release = render(1, options).retainEditor(1);
    oldRead(1);
    const editing = render(1, options).items[0]!;
    expect(creationAcknowledged(editing, 1, ['saved-task'])).toBe(false);
    expect(render(1, options).update(1, input('draft'))).toBe(true);
    release();
    release();
    expect(render(1, options).items[0]!.input.title).toBe('draft');
    expect(render(1, options).items[0]!.editing).toBe(false);
  });

  it('rereads a confirmed creation once when its last editor closes without submitting a change', async () => {
    reads.created.mockResolvedValue({
      ...input('original'),
      id: 'saved-task',
      completed: false,
    } as Task);
    const changed = vi.fn();
    const options = { onChanged: changed };
    render(0, options).start(1, input('original'));
    await render(0, options).finish(1, 'receipt');
    const release = render(1, options).retainEditor(1);
    const other = render(1, options).retainEditor(1);
    changed.mockClear();
    release();
    expect(changed).not.toHaveBeenCalled();
    other();
    other();
    expect(changed).toHaveBeenCalledOnce();
    expect(creationAcknowledged(render(1, options).items[0]!, 1, ['saved-task'])).toBe(true);
  });

  it('rejects an update to a creation that no longer exists', () => {
    expect(render().update(42, input('keep this draft'))).toBe(false);
    expect(render().items).toEqual([]);
  });
  it('retires a filtered or locally paged row only with its own reconciled list proof', () => {
    const creation = {
      id: 1,
      input: input('saved'),
      resolvedTaskId: 'saved-task',
      confirmedAfter: 5,
    };
    expect(creationAcknowledged(creation, 6, [], ['list'])).toBe(true);
    expect(creationAcknowledged(creation, 6, [], ['other-list'])).toBe(false);
    expect(creationAcknowledged(creation, 5, [], ['list'])).toBe(false);
    expect(creationAcknowledged({ ...creation, editing: true }, 6, [], ['list'])).toBe(false);
  });

  it('refreshes a confirmed task when a failed identity read is discarded', async () => {
    reads.created.mockImplementation(async (_account, _receipt, _input, onAddress) => {
      onAddress('saved-task');
      throw new Error('temporary task read failure');
    });
    const changed = vi.fn();
    const options = { onChanged: changed };
    render(0, options).start(1, input('already created'));
    await render(0, options).finish(1, 'confirmed-receipt');
    render(0, options).items[0]!.failure!.onDiscard();
    expect(changed).toHaveBeenCalled();
    expect(render(0, options).items).toEqual([]);
    expect(reads.created).toHaveBeenCalledOnce();
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
    reads.operation.mockReset();
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
    expect(onReady).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'server-task' }), {
      patch: { title: 'ring64 changed', starred: true },
    });
    expect(onReady).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'server-task' }), {
      patch: {},
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
  it('resumes order reads after confirmation without keeping the save busy', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    const reconciliation = deferred<void>();
    const onOrderRefresh = vi.fn(() => reconciliation.promise);
    const options = { onOrderRefresh };
    render(0, options).start(1, input('ring64'));
    await render(0, options).finish(1, 'receipt');
    expect(onOrderRefresh).toHaveBeenCalledOnce();
    expect(render(0, options).busy).toBe(false);
    expect(render(0, options).items[0]!.confirmedAfter).toBe(0);
    expect(render(0, options).items[0]!.controls?.disabled).toBe(false);
    reconciliation.resolve();
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
  it('accepts label and blocker sets returned in a different order after a queued edit', async () => {
    let task: Task = { ...serverTask('ring64'), labelIds: [], blockedBy: [] };
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi.fn(async (_saved: Task, intent: { patch: object }) => {
      task = { ...task, ...intent.patch, labelIds: ['a', 'z'], blockedBy: ['first', 'last'] };
      return true;
    });
    const options = { onReady, onError: vi.fn() };
    render(0, options).start(1, input('ring64'));
    render(0, options).update(
      1,
      { ...input('ring64'), labelIds: ['z', 'a'], blockedBy: ['last', 'first'] },
      12,
    );
    await render(0, options).finish(1, 'create-receipt');
    expect(render(0, options).items[0]!.failure).toBeUndefined();
    expect(render(0, options).items[0]!.confirmedAfter).toBe(0);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0]![1]).toMatchObject({ expectedGraphRevision: 12 });
  });
  it('hands off multiple labels after their real sqlite persistence normalizes their order', async () => {
    const database = testDatabase();
    try {
      const now = Date.now();
      await seedAccount(database.db, 'account', now);
      await database.db
        .prepare('INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES (?,?,?,?)')
        .bind('list', 'account', 'google-list', 'list')
        .run();
      await database.db
        .prepare(
          'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES (?,?,?,?,?)',
        )
        .bind('server-task', 'account', 'list', 'google-task', 'ring64')
        .run();
      for (const id of ['z', 'a'])
        await database.db
          .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES (?,?,?,?,?)')
          .bind(id, 'account', id, id, '#123456')
          .run();
      const queries = new TaskQueries(database.db);
      const metadata = new TaskMetadataService(database.db, {
        history: new HistoryService(database.db, { now: () => now }),
        commitWrites: async (writes) => {
          await database.db.batch(writes);
        },
      });
      reads.created.mockImplementation(() => queries.getTask('account', 'server-task'));
      reads.task.mockImplementation(() => queries.getTask('account', 'server-task'));
      const options = {
        onReady: vi.fn(async (task: Task, intent: { patch: object }) => {
          await metadata.patchTask('account', task.id, intent.patch, task.revision, {
            operationId: 'edit',
            stepKey: 'metadata',
            origin: 'owner',
            recordedAt: new Date(now).toISOString(),
          });
          return true;
        }),
      };
      render(0, options).start(1, input('ring64'));
      render(0, options).update(1, { ...input('ring64'), labelIds: ['z', 'a'] });
      await render(0, options).finish(1, 'create');
      expect((await queries.getTask('account', 'server-task')).labelIds).toEqual(['a', 'z']);
      expect(render(0, options).items[0]!.failure).toBeUndefined();
      expect(render(0, options).items[0]!.confirmedAfter).toBe(0);
      expect(options.onReady).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });
  it('recovers the actual successful followup receipt without issuing another write', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const failure = {
      saved: false as const,
      message: 'check the edit',
      operationId: 'edit-receipt',
    };
    const onReady = vi.fn().mockResolvedValue(failure);
    const options = { onReady, onError: vi.fn(), onInspect: vi.fn() };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    await render(0, options).finish(1, 'create-receipt');
    expect(options.onError).toHaveBeenLastCalledWith('check the edit', 'edit-receipt');
    task = { ...task, starred: true };
    reads.operation.mockResolvedValue({
      id: 'edit-receipt',
      accountId: 'account',
      state: 'succeeded',
    });
    await render(0, options).finish(1, 'create-receipt');
    expect(reads.operation).toHaveBeenCalledWith(
      '/api/accounts/account/operations/edit-receipt',
      expect.anything(),
    );
    expect(onReady).toHaveBeenCalledOnce();
    expect(render(0, options).items[0]!.failure).toBeUndefined();
    expect(render(0, options).items[0]!.confirmedAfter).toBe(0);
  });
  it('keeps an uncertain followup blocked and inspects that exact receipt', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    const failure = {
      saved: false as const,
      message: 'check the edit',
      operationId: 'edit-receipt',
    };
    const options = {
      onReady: vi.fn().mockResolvedValue(failure),
      onError: vi.fn(),
      onInspect: vi.fn(),
    };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    await render(0, options).finish(1, 'create-receipt');
    reads.operation.mockResolvedValue({
      id: 'edit-receipt',
      accountId: 'account',
      state: 'uncertain',
      finished: false,
    });
    render(0, options).items[0]!.failure!.onEdit();
    await vi.waitFor(() => expect(options.onInspect).toHaveBeenCalledWith('edit-receipt'));
    expect(options.onReady).toHaveBeenCalledOnce();
    expect(render(0, options).items[0]!.confirmedAfter).toBeNull();
  });
  it('does not trust a successful followup receipt from another account or identity', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const options = {
      onReady: vi.fn().mockResolvedValue({
        saved: false,
        message: 'check the edit',
        operationId: 'edit-receipt',
      }),
      onError: vi.fn(),
    };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    await render(0, options).finish(1, 'create-receipt');
    task = { ...task, starred: true };
    for (const receipt of [
      { id: 'edit-receipt', accountId: 'other', state: 'succeeded' },
      { id: 'other-receipt', accountId: 'account', state: 'succeeded' },
    ]) {
      reads.operation.mockResolvedValue(receipt);
      await render(0, options).finish(1, 'create-receipt');
      expect(render(0, options).items[0]!.failure).toBeDefined();
      expect(render(0, options).items[0]!.confirmedAfter).toBeNull();
    }
    expect(options.onReady).toHaveBeenCalledOnce();
  });
  it('requires a corrected draft and verified terminal rejection before another followup write', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const openEditor = vi.fn();
    const onReady = vi
      .fn()
      .mockResolvedValueOnce({
        saved: false,
        message: 'invalid title',
        operationId: 'edit-receipt',
      })
      .mockImplementationOnce(async (_saved: Task, intent: { patch: object }) => {
        task = { ...task, ...intent.patch };
        return true;
      });
    const options = { onReady, onError: vi.fn() };
    render(0, options).start(1, input('ring64'), openEditor);
    render(0, options).update(1, input('invalid'), 12);
    await render(0, options).finish(1, 'create-receipt');
    reads.operation.mockResolvedValue({
      id: 'edit-receipt',
      accountId: 'account',
      state: 'failed',
      finished: true,
      confirmedSteps: 0,
      error: { message: 'invalid title' },
    });
    await render(0, options).finish(1, 'create-receipt');
    expect(onReady).toHaveBeenCalledOnce();
    expect(render(0, options).items[0]!.failure?.actionLabel).toBe('edit');
    render(0, options).items[0]!.failure!.onEdit();
    expect(openEditor).toHaveBeenCalledWith(input('invalid'));
    render(0, options).update(1, input('corrected'), 12);
    await render(0, options).finish(1, 'create-receipt');
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(task.title).toBe('corrected');
    expect(render(0, options).items[0]!.failure).toBeUndefined();
  });
  it('does not apply a corrected rejected draft over a changed task field', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const options = {
      onReady: vi
        .fn()
        .mockResolvedValue({ saved: false, message: 'invalid title', operationId: 'edit-receipt' }),
    };
    render(0, options).start(1, input('ring64'));
    render(0, options).update(1, input('invalid'));
    await render(0, options).finish(1, 'create-receipt');
    task = { ...task, title: 'external edit' };
    reads.operation.mockResolvedValue({
      id: 'edit-receipt',
      accountId: 'account',
      state: 'failed',
      finished: true,
      confirmedSteps: 0,
    });
    render(0, options).update(1, input('corrected'));
    await render(0, options).finish(1, 'create-receipt');
    expect(options.onReady).toHaveBeenCalledOnce();
    expect(task.title).toBe('external edit');
    expect(render(0, options).items[0]!.failure?.message).toContain('changed before');
  });
  it('allows correcting a never-dispatched followup but does not replay an unknown receiptless outcome', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const options = {
      onReady: vi
        .fn()
        .mockResolvedValueOnce({ saved: false, message: 'preflight unavailable', rejected: true })
        .mockImplementationOnce(async (_task: Task, intent: { patch: object }) => {
          task = { ...task, ...intent.patch };
          return true;
        }),
    };
    render(0, options).start(1, input('ring64'));
    render(0, options).update(1, input('first title'));
    await render(0, options).finish(1, 'create');
    expect(render(0, options).items[0]!.failure).toBeDefined();
    render(0, options).update(1, input('corrected'));
    await render(0, options).finish(1, 'create');
    expect(task.title).toBe('corrected');
    expect(options.onReady).toHaveBeenCalledTimes(2);
    render(0, options).items[0]!.controls!.onStar(true);
    options.onReady.mockResolvedValueOnce({ saved: false, message: 'unknown provider failure' });
    await render(0, options).finish(1, 'create');
    render(0, options).update(1, { ...input('do not replay'), starred: true });
    await render(0, options).finish(1, 'create');
    expect(options.onReady).toHaveBeenCalledTimes(3);
    expect(task.title).toBe('corrected');
    expect(render(0, options).items[0]!.failure).toBeDefined();
  });
  it('recovers only the issued edit phase before dispatching its unissued completion', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi.fn(async (_saved: Task, intent: { patch: object; completed?: boolean }) => {
      if (Object.keys(intent.patch).length) {
        task = { ...task, ...intent.patch };
        return {
          saved: false as const,
          message: 'post-edit read failed',
          operationId: 'edit-receipt',
        };
      }
      task = { ...task, completed: intent.completed! };
      return true;
    });
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    render(0, options).items[0]!.controls!.onComplete(true);
    await render(0, options).finish(1, 'create-receipt');
    expect(task.starred).toBe(true);
    expect(task.completed).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0]![1]).toEqual({ patch: { starred: true } });
    reads.operation.mockResolvedValue({
      id: 'edit-receipt',
      accountId: 'account',
      state: 'succeeded',
    });
    await render(0, options).finish(1, 'create-receipt');
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady.mock.calls[1]![1]).toEqual({ patch: {}, completed: true });
    expect(task.completed).toBe(true);
    expect(render(0, options).items[0]!.failure).toBeUndefined();
  });
  it('compares a rejected completion retry against the preceding confirmed edit phase', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi
      .fn()
      .mockImplementationOnce(async (_saved: Task, intent: { patch: object }) => {
        task = { ...task, ...intent.patch };
        return true;
      })
      .mockResolvedValueOnce({
        saved: false,
        message: 'completion rejected',
        operationId: 'completion-receipt',
      })
      .mockImplementation(async (_saved: Task, intent: { patch: object; completed?: boolean }) => {
        task = {
          ...task,
          ...intent.patch,
          ...(intent.completed === undefined ? {} : { completed: intent.completed }),
        };
        return true;
      });
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    render(0, options).items[0]!.controls!.onComplete(true);
    await render(0, options).finish(1, 'create');
    reads.operation.mockResolvedValue({
      id: 'completion-receipt',
      accountId: 'account',
      state: 'failed',
      finished: true,
      confirmedSteps: 0,
    });
    render(0, options).update(1, { ...input('corrected'), starred: true });
    await render(0, options).finish(1, 'create');
    expect(onReady.mock.calls.map((call) => call[1])).toEqual([
      { patch: { starred: true } },
      { patch: {}, completed: true },
      { patch: { title: 'corrected' } },
      { patch: {}, completed: true },
    ]);
    expect(task).toMatchObject({ title: 'corrected', starred: true, completed: true });
    expect(render(0, options).items[0]!.failure).toBeUndefined();
  });
  it('uses a corrected draft captured while its rejected receipt is being read', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    reads.task.mockImplementation(async () => task);
    const onReady = vi
      .fn()
      .mockResolvedValueOnce({
        saved: false,
        message: 'invalid title',
        operationId: 'edit-receipt',
      })
      .mockImplementationOnce(async (_saved: Task, intent: { patch: object }) => {
        task = { ...task, ...intent.patch };
        return true;
      });
    const options = { onReady };
    render(0, options).start(1, input('ring64'));
    render(0, options).update(1, input('invalid'));
    await render(0, options).finish(1, 'create');
    const receipt = deferred<{
      id: string;
      accountId: string;
      state: string;
      finished: boolean;
      confirmedSteps: number;
    }>();
    reads.operation.mockReturnValueOnce(receipt.promise);
    const checking = render(0, options).finish(1, 'create');
    await vi.waitFor(() => expect(reads.operation).toHaveBeenCalled());
    render(0, options).update(1, input('corrected while checking'));
    receipt.resolve({
      id: 'edit-receipt',
      accountId: 'account',
      state: 'failed',
      finished: true,
      confirmedSteps: 0,
    });
    await checking;
    expect(task.title).toBe('corrected while checking');
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(render(0, options).items[0]!.failure).toBeUndefined();
  });
  it.each(['starred', 'completed'] as const)(
    'does not replay confirmed %s after its owner read fails and another client reverses it',
    async (field) => {
      let task = serverTask('ring64');
      reads.created.mockImplementation(async () => task);
      reads.task
        .mockRejectedValueOnce(new Error('owner read unavailable'))
        .mockImplementation(async () => task);
      const options = {
        onReady: vi.fn(async (_task: Task, intent: { patch: object; completed?: boolean }) => {
          task = {
            ...task,
            ...intent.patch,
            ...(intent.completed === undefined ? {} : { completed: intent.completed }),
          };
          return true;
        }),
      };
      render(0, options).start(1, input('ring64'));
      if (field === 'starred') render(0, options).items[0]!.controls!.onStar(true);
      else render(0, options).items[0]!.controls!.onComplete(true);
      await render(0, options).finish(1, 'create');
      expect(render(0, options).items[0]!.failure).toBeDefined();
      task = { ...task, [field]: false };
      await render(0, options).finish(1, 'create');
      expect(options.onReady).toHaveBeenCalledOnce();
      expect(task[field]).toBe(false);
      expect(render(0, options).items[0]!.failure).toBeUndefined();
    },
  );
  it('adopts a newer external value after the exact followup receipt confirms an older value', async () => {
    const task = serverTask('ring64');
    reads.created.mockResolvedValue(task);
    reads.task.mockResolvedValue(task);
    const options = {
      onReady: vi
        .fn()
        .mockResolvedValue({ saved: false, message: 'check save', operationId: 'edit' }),
    };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    await render(0, options).finish(1, 'create');
    reads.operation.mockResolvedValue({ id: 'edit', accountId: 'account', state: 'succeeded' });
    await render(0, options).finish(1, 'create');
    expect(options.onReady).toHaveBeenCalledOnce();
    expect(task.starred).toBe(false);
    expect(render(0, options).items[0]!.failure).toBeUndefined();
  });
  it('retains newer local intent captured while a confirmed phase awaits its owner read', async () => {
    let task = serverTask('ring64');
    reads.created.mockImplementation(async () => task);
    let reject!: (error: Error) => void;
    reads.task
      .mockReturnValueOnce(
        new Promise<Task>((_resolve, fail) => {
          reject = fail;
        }),
      )
      .mockImplementation(async () => task);
    const options = {
      onReady: vi.fn(async (_task: Task, intent: { patch: object }) => {
        task = { ...task, ...intent.patch };
        return true;
      }),
    };
    render(0, options).start(1, input('ring64'));
    render(0, options).items[0]!.controls!.onStar(true);
    const saving = render(0, options).finish(1, 'create');
    await vi.waitFor(() => expect(reads.task).toHaveBeenCalledOnce());
    render(0, options).items[0]!.controls!.onStar(false);
    reject(new Error('owner read unavailable'));
    await saving;
    await render(0, options).finish(1, 'create');
    expect(options.onReady.mock.calls.map((call) => call[1])).toEqual([
      { patch: { starred: true } },
      { patch: { starred: false } },
    ]);
    expect(task.starred).toBe(false);
    expect(render(0, options).items[0]!.failure).toBeUndefined();
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
  it('restores a saved row when its pending deletion is cancelled', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    reads.task.mockResolvedValue(serverTask('ring64'));
    const options = { onReady: vi.fn().mockResolvedValue('cancelled'), onError: vi.fn() };
    render(0, options).start(41, input('ring64'));
    render(0, options).items[0]!.controls!.onDelete();
    await render(0, options).finish(41, 'receipt');
    const restored = render(0, options).items[0]!;
    expect(restored.deleted).toBe(false);
    expect(restored.failure).toBeUndefined();
    expect(restored.confirmedAfter).toBe(0);
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onReady).toHaveBeenCalledOnce();
  });
  it('restores visible recovery after a pending deletion fails without submitting it twice', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    const options = { onReady: vi.fn().mockResolvedValue(false), onError: vi.fn() };
    render(0, options).start(41, input('ring64'));
    render(0, options).items[0]!.controls!.onDelete();
    await render(0, options).finish(41, 'receipt');
    const failed = render(0, options).items[0]!;
    expect(failed.deleted).toBe(false);
    expect(failed.resolvedTaskId).toBe('server-task');
    expect(failed.failure?.actionLabel).toBe('show task');
    expect(TaskCreationPreview({ creation: failed })).not.toBeNull();
    await render(0, options).finish(41, 'receipt');
    expect(options.onReady).toHaveBeenCalledOnce();
    expect(render(0, options).items[0]!.failure).toBeDefined();
  });
  it('checks the uncertain deletion receipt without replaying creation or deletion', async () => {
    reads.created.mockResolvedValue(serverTask('ring64'));
    const failure = new RequestError('uncertain', 'check deletion', undefined, 'delete-receipt');
    const options = {
      onReady: vi.fn().mockRejectedValue(failure),
      onError: vi.fn(),
      onInspect: vi.fn(),
    };
    render(0, options).start(41, input('ring64'));
    render(0, options).items[0]!.controls!.onDelete();
    await render(0, options).finish(41, 'create-receipt');
    const restored = render(0, options).items[0]!;
    expect(restored.deleted).toBe(false);
    expect(options.onError).toHaveBeenLastCalledWith('check deletion', 'delete-receipt');
    restored.failure!.onEdit();
    expect(options.onInspect).toHaveBeenCalledWith('delete-receipt');
    expect(options.onError).toHaveBeenCalledOnce();
    expect(reads.created).toHaveBeenCalledOnce();
    expect(options.onReady).toHaveBeenCalledOnce();
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

describe('ordered creation submission', () => {
  const receipt = (state = 'succeeded', finished = true) =>
    ({ state, finished, confirmedSteps: state === 'succeeded' ? 1 : 0 }) as OperationSummary;
  beforeEach(() => {
    hooks.index = 0;
    hooks.slots = [];
    reads.created.mockReset();
    reads.operation.mockReset();
  });

  it('submits captured creates in list order without blocking another list', async () => {
    let release!: (value: OperationSummary) => void;
    render().start(1, input('A'));
    render().start(2, input('B'));
    render().start(3, { ...input('other'), listId: 'other' });
    const calls: string[] = [];
    const a = render().run(1, () => {
      calls.push('A');
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const b = render().run(2, async () => {
      calls.push('B');
      return receipt();
    });
    const other = render().run(3, async () => {
      calls.push('other');
      return receipt();
    });
    await other;
    expect(calls).toEqual(['A', 'other']);
    release(receipt());
    await Promise.all([a, b]);
    expect(calls).toEqual(['A', 'other', 'B']);
  });

  it('stops unsent same-list creates after uncertainty until the original identity is confirmed', async () => {
    render().start(1, input('A'));
    render().start(2, input('B'));
    const a = render().run(1, async () => receipt('uncertain', false));
    const sendB = vi.fn(async () => receipt());
    const b = render().run(2, sendB);
    await expect(a).resolves.toBe(false);
    await expect(b).rejects.toThrow('earlier');
    expect(sendB).not.toHaveBeenCalled();
    reads.created.mockResolvedValue({ ...input('A'), id: 'saved-A', completed: false } as Task);
    await render().finish(1, 'real-receipt');
    render().start(3, input('C'));
    await expect(render().run(3, async () => receipt())).resolves.toBe(true);
    expect(reads.created).toHaveBeenCalledOnce();
  });

  it('allows the next creation after a definite zero-step rejection', async () => {
    render().start(1, input('rejected'));
    render().start(2, input('valid'));
    await expect(render().run(1, async () => receipt('failed'))).resolves.toBe(false);
    await expect(render().run(2, async () => receipt())).resolves.toBe(true);
  });
  it('recovers a discarded unresolved creation from its real receipt without replaying it', async () => {
    render().start(1, input('A'));
    await render().run(1, async () => ({ ...receipt('uncertain', false), id: 'receipt-A' }));
    render().remove(1);
    reads.operation.mockResolvedValue({ ...receipt(), id: 'receipt-A', accountId: 'account' });
    render().start(2, input('B'));
    const submit = vi.fn(async () => receipt());
    await expect(render().run(2, submit)).resolves.toBe(true);
    expect(reads.operation).toHaveBeenCalledWith(
      '/api/accounts/account/operations/receipt-A',
      expect.anything(),
    );
    expect(submit).toHaveBeenCalledOnce();
    expect(reads.created).not.toHaveBeenCalled();
  });
});
