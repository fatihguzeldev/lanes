import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../contracts/task';
import type { TaskActionContext } from '../task-actions';
import { useTaskChanges, projectTaskCollection } from '../../changes/useTaskChanges';
import { useTaskActions } from '../useTaskActions';
import { RequestError } from '../../../../../shared/browser/http/http';
import { CreateTaskSchema } from '../../../contracts/task';
import { useTaskCreations } from '../../creation/useTaskCreations';

const state = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
  read: vi.fn(),
  created: vi.fn(),
  submit: vi.fn(),
  failure: null as { message: string; operationId?: string } | null,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (value: unknown) => {
        state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    return (state.slots[state.cursor++] ??= { current: initial });
  },
  useEffect(effect: () => void | (() => void)) {
    state.effects.push(effect);
  },
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => ({ submit: state.submit, getErrorDetails: () => state.failure, busy: false }),
}));
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: state.read,
}));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => 'quick-receipt',
}));
vi.mock('../../creation/creation-receipt', () => ({ readCreatedTask: state.created }));
const task = {
  id: 'task',
  accountId: 'account',
  revision: 7,
  starred: false,
  completed: false,
  repeatRule: null,
  seriesId: null,
  scheduledDay: '2026-11-05',
  scheduledTime: null,
} as Task;
let current: Task;
let context: TaskActionContext;
function render() {
  state.cursor = 0;
  return useTaskActions(context, 0);
}
beforeEach(() => {
  state.slots = [];
  state.cursor = 0;
  state.effects = [];
  state.failure = null;
  state.created.mockReset();
  current = { ...task };
  context = {
    accountId: 'account',
    submit: vi.fn(),
    confirm: vi.fn(),
    onNotice: vi.fn(),
    onChanged: vi.fn(),
    onRepeat: vi.fn(),
    onReopen: vi.fn(),
    onTaskDeleted: vi.fn(),
    onListDeleteReady: vi.fn(),
  };
  state.read.mockReset().mockImplementation(async (path: string) =>
    path.endsWith('/consequences')
      ? {
          taskId: current.id,
          revision: current.revision,
          coverageComplete: true,
          openSubtaskCount: 0,
          openBlockerCount: 0,
          openBlockedSubtaskCount: 0,
          unknownBlockerCount: 0,
        }
      : { ...current },
  );
  state.submit.mockReset().mockImplementation(async (command) => {
    current = {
      ...current,
      revision: current.revision + 1,
      ...(command.kind === 'task.patch'
        ? command.patch
        : command.kind === 'task.edit'
          ? command.patch
          : { completed: command.kind === 'task.complete' }),
    };
    return { id: 'quick-receipt', state: 'succeeded' };
  });
});

it('keeps a newer date visible while an earlier clear is dispatched and saved', async () => {
  let releaseRead!: (task: Task) => void;
  state.read.mockImplementationOnce(
    () =>
      new Promise<Task>((resolve) => {
        releaseRead = resolve;
      }),
  );
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const save = state.submit.getMockImplementation()!;
  state.submit.mockImplementationOnce(async (...args) => {
    await writeGate;
    return save(...args);
  });
  function pair() {
    state.cursor = 0;
    const changes = useTaskChanges('account', 0);
    context = { ...context, changes };
    return { changes, actions: useTaskActions(context, 0) };
  }
  const first = pair().actions.reschedule(
    { accountId: 'account', taskId: task.id, revision: task.revision, scheduledDay: null },
    task,
  );
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce());
  const row = projectTaskCollection([task], pair().changes.items)[0]!;
  const second = pair().actions.reschedule(
    { accountId: 'account', taskId: task.id, revision: task.revision, scheduledDay: '2026-11-10' },
    row,
  );
  expect(projectTaskCollection([task], pair().changes.items)[0]?.scheduledDay).toBe('2026-11-10');
  releaseRead({ ...current });
  await vi.waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
  expect(projectTaskCollection([task], pair().changes.items)[0]?.scheduledDay).toBe('2026-11-10');
  expect(pair().changes.items.map((item) => item.id)).toEqual(['date:1', 'date:2']);
  releaseWrite();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(current.scheduledDay).toBe('2026-11-10');
});

describe('queued task actions', () => {
  it('reads the revision produced by the preceding star before capturing completion', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = state.submit.getMockImplementation()!;
    state.submit.mockImplementationOnce(async (...args) => {
      await blocked;
      return save(...args);
    });
    const actions = render();
    const star = actions.toggleStar(task, true);
    const completion = actions.toggleComplete(task, true);
    const unstar = actions.toggleStar(task, false);
    await vi.waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
    expect(state.read).toHaveBeenCalledOnce();
    expect(render().busy).toBe(true);
    finish();
    expect(await Promise.all([star, completion, unstar])).toEqual([true, true, true]);
    expect(state.submit.mock.calls.map(([command]) => command)).toEqual([
      { kind: 'task.patch', taskId: 'task', expectedRevision: 7, patch: { starred: true } },
      { kind: 'task.complete', taskId: 'task', revision: 8, confirmOpenSubtaskCount: 0 },
      { kind: 'task.patch', taskId: 'task', expectedRevision: 9, patch: { starred: false } },
    ]);
    expect(current).toMatchObject({ revision: 10, starred: false, completed: true });
    expect(context.submit).not.toHaveBeenCalled();
    expect(render().busy).toBe(false);
  });

  it('queues calendar dates after quick actions and rebases each change on its confirmed revision', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = state.submit.getMockImplementation()!;
    state.submit.mockImplementationOnce(async (...args) => {
      await blocked;
      return save(...args);
    });
    const actions = render();
    const star = actions.toggleStar(task, true);
    const move = actions.reschedule({
      accountId: task.accountId,
      taskId: task.id,
      revision: task.revision,
      scheduledDay: '2026-11-07',
    });
    const moveAgain = actions.reschedule({
      accountId: task.accountId,
      taskId: task.id,
      revision: task.revision,
      scheduledDay: '2026-11-08',
    });
    await vi.waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
    expect(context.submit).not.toHaveBeenCalled();
    finish();
    expect(await Promise.all([star, move, moveAgain])).toEqual([true, true, true]);
    expect(state.submit.mock.calls.map(([command]) => command)).toEqual([
      { kind: 'task.patch', taskId: 'task', expectedRevision: 7, patch: { starred: true } },
      { kind: 'task.edit', taskId: 'task', revision: 8, patch: { scheduledDay: '2026-11-07' } },
      { kind: 'task.edit', taskId: 'task', revision: 9, patch: { scheduledDay: '2026-11-08' } },
    ]);
    expect(state.read).toHaveBeenCalledTimes(3);
  });

  it('does not send an unchanged calendar date and still refreshes a stale view', async () => {
    expect(
      await render().reschedule({
        accountId: task.accountId,
        taskId: task.id,
        revision: task.revision,
        scheduledDay: task.scheduledDay,
      }),
    ).toBe(true);
    expect(state.submit).not.toHaveBeenCalled();
    expect(context.onChanged).toHaveBeenCalledOnce();
  });

  it('preserves the receipt and rolls back dependent queued intents after uncertainty', async () => {
    state.submit.mockResolvedValue({ id: 'quick-receipt', state: 'uncertain', error: null });
    const actions = render();
    expect(
      await Promise.all([actions.toggleStar(task, true), actions.toggleComplete(task, true)]),
    ).toEqual([false, false]);
    expect(state.submit).toHaveBeenCalledOnce();
    expect(context.onNotice).toHaveBeenCalledWith(
      expect.stringContaining('check its save'),
      'quick-receipt',
    );
    expect(context.onChanged).toHaveBeenCalled();
  });

  it('refreshes a stale row after a queued action is already satisfied without another write', async () => {
    current.starred = true;
    expect(await render().toggleStar(task, true)).toBe(true);
    expect(state.submit).not.toHaveBeenCalled();
    expect(context.onChanged).toHaveBeenCalledOnce();
  });

  it('shows a definite admission error without linking an operation that was never admitted', async () => {
    state.failure = { message: 'this task changed. refresh it.' };
    state.submit.mockImplementation(async (_command, _category, _identity, onFailure) => {
      onFailure(state.failure);
      return null;
    });
    expect(await render().toggleStar(task, true)).toBe(false);
    expect(context.onNotice).toHaveBeenCalledWith('this task changed. refresh it.', null);
  });

  it('does not dispatch a stale account read after cleanup and strict-mode replay', async () => {
    let finish!: (value: Task) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const actions = render();
    const effect = state.effects[0]!;
    const cleanup = effect()!;
    const saving = actions.toggleStar(task, true);
    cleanup();
    effect();
    finish(task);
    expect(await saving).toBe(false);
    expect(state.submit).not.toHaveBeenCalled();
    expect(await render().toggleStar({ ...task, accountId: 'other' }, true)).toBe(false);
    expect(await render().toggleStar(task, true)).toBe(true);
  });
});

function renderOwned() {
  state.cursor = 0;
  const changes = useTaskChanges('account', 0);
  context.changes = changes;
  const actions = useTaskActions(context, 0);
  return { actions, changes };
}

describe('account-owned task presentation', () => {
  it('reports cancellation separately when deleting a newly saved optimistic row', async () => {
    const deleted = render().applyCreation(task, { patch: {}, deleted: true });
    await vi.waitFor(() => expect(context.confirm).toHaveBeenCalledOnce());
    vi.mocked(context.confirm).mock.calls[0]![0].onCancel?.();
    expect(await deleted).toBe('cancelled');
    expect(context.submit).not.toHaveBeenCalled();
  });

  it('preserves the deletion receipt when a new task followup cannot be confirmed', async () => {
    state.submit.mockImplementation(async (_command, _category, _identity, onFailure) => {
      onFailure(new RequestError('uncertain', 'check deletion', undefined, 'delete-receipt'));
      return { id: 'delete-receipt', state: 'uncertain' };
    });
    const deleted = render().applyCreation(task, { patch: {}, deleted: true });
    const rejected = expect(deleted).rejects.toMatchObject({ operationId: 'delete-receipt' });
    await vi.waitFor(() => expect(context.confirm).toHaveBeenCalledOnce());
    await vi.mocked(context.confirm).mock.calls[0]![0].onConfirm('delete-receipt');
    await rejected;
  });
  it('does not invent a deletion receipt after a definite admission rejection', async () => {
    const failure = new RequestError('validation_failed', 'this task cannot be deleted');
    state.submit.mockImplementation(async (_command, _category, _identity, onFailure) => {
      onFailure(failure);
      return null;
    });
    const deleted = render().applyCreation(task, { patch: {}, deleted: true });
    const rejected = expect(deleted).rejects.toBe(failure);
    await vi.waitFor(() => expect(context.confirm).toHaveBeenCalledOnce());
    await vi.mocked(context.confirm).mock.calls[0]![0].onConfirm('not-admitted');
    await rejected;
    expect(failure.operationId).toBeUndefined();
  });
  it('projects completion and date membership before any request resolves', async () => {
    let finish!: (value: Task) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const owner = renderOwned();
    const completion = owner.actions.toggleComplete(task, true);
    expect(projectTaskCollection([task], renderOwned().changes.items)[0]?.completed).toBe(true);
    await Promise.resolve();
    finish(task);
    expect(await completion).toBe(true);
    const dated = owner.actions.reschedule(
      {
        accountId: task.accountId,
        taskId: task.id,
        revision: task.revision,
        scheduledDay: '2026-11-09',
      },
      task,
    );
    expect(projectTaskCollection([task], renderOwned().changes.items)[0]?.scheduledDay).toBe(
      '2026-11-09',
    );
    expect(await dated).toBe(true);
  });

  it('registers an action before a later editor write and rolls back dependent intents on failure', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.submit.mockImplementationOnce(async () => {
      await blocked;
      return { id: 'failed-star', state: 'uncertain' };
    });
    const owner = renderOwned();
    const star = owner.actions.toggleStar(task, true);
    const editor = vi.fn(async () => true);
    const edit = owner.changes.run(task.id, editor);
    const complete = owner.actions.toggleComplete(task, true);
    await vi.waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
    finish();
    expect(await Promise.all([star, edit, complete])).toEqual([false, false, false]);
    expect(editor).not.toHaveBeenCalled();
    expect(renderOwned().changes.items).toHaveLength(0);
    expect(context.onNotice).toHaveBeenCalledWith(
      expect.stringContaining('check its save'),
      'failed-star',
    );
  });

  it('checks deletion against the revision produced by earlier queued work and scopes late close callbacks', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = state.submit.getMockImplementation()!;
    state.submit.mockImplementationOnce(async (...args) => {
      await blocked;
      return save(...args);
    });
    const owner = renderOwned();
    const star = owner.actions.toggleStar(task, true);
    vi.mocked(context.submit).mockResolvedValue(true);
    const deleted = owner.actions.deleteTask(task);
    await vi.waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
    expect(context.confirm).not.toHaveBeenCalled();
    finish();
    expect(await star).toBe(true);
    await vi.waitFor(() => expect(context.confirm).toHaveBeenCalledOnce());
    const choice = vi.mocked(context.confirm).mock.calls[0]![0];
    const lateClose = vi.fn();
    context = { ...context, onTaskDeleted: lateClose };
    renderOwned();
    await choice.onConfirm('delete-receipt');
    expect(await deleted).toBe(true);
    expect(context.submit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task.delete', revision: 8 }),
      'provider',
      'delete-receipt',
    );
    expect(lateClose).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });
});

it('retains a pending creation edit receipt while rebasing its unchanged blocker context', async () => {
  const failure = new RequestError('uncertain', 'check this edit', undefined, 'edit-receipt');
  state.submit.mockImplementation(async (_command, _category, _identity, onFailure) => {
    onFailure(failure);
    return { id: 'edit-receipt', state: 'uncertain' };
  });
  state.read.mockResolvedValueOnce({ ...current }).mockResolvedValueOnce({ revision: 13 });
  const result = await render().applyCreation(task, {
    patch: { blockedBy: ['blocker'] },
    expectedGraphRevision: 12,
  });
  expect(state.submit.mock.calls[0]![0]).toMatchObject({
    kind: 'task.edit',
    expectedGraphRevision: 13,
  });
  expect(result).toEqual({ saved: false, message: 'check this edit', operationId: 'edit-receipt' });
  expect(context.submit).not.toHaveBeenCalled();
});
it('retains the confirmed edit receipt when its following task read fails', async () => {
  state.read
    .mockResolvedValueOnce({ ...task })
    .mockRejectedValueOnce(new Error('read unavailable'));
  const result = await render().applyCreation(task, { patch: { title: 'renamed' } });
  expect(result).toEqual({
    saved: false,
    message: 'read unavailable',
    operationId: 'quick-receipt',
  });
});

it('retains the completion receipt for a pending creation followup', async () => {
  const failure = new RequestError(
    'uncertain',
    'check completion',
    undefined,
    'completion-receipt',
  );
  state.submit.mockImplementation(async (_command, _category, _identity, onFailure) => {
    onFailure(failure);
    return { id: 'completion-receipt', state: 'uncertain' };
  });
  expect(await render().applyCreation(task, { patch: {}, completed: true })).toEqual({
    saved: false,
    message: 'check completion',
    operationId: 'completion-receipt',
  });
});
it('removes the edit overlay when a creation followup preflight fails', async () => {
  state.read.mockRejectedValueOnce(new Error('read unavailable'));
  state.cursor = 0;
  const changes = useTaskChanges('account', 0);
  context = { ...context, changes };
  const actions = useTaskActions(context, 0);
  expect(await actions.applyCreation(task, { patch: { title: 'renamed' } })).toEqual({
    saved: false,
    message: 'read unavailable',
    rejected: true,
  });
  state.cursor = 0;
  expect(useTaskChanges('account', 0).items).toEqual([]);
  expect(state.submit).not.toHaveBeenCalled();
});

it('does not classify a provider failure without a receipt as an unadmitted edit', async () => {
  const error = new RequestError('provider_unavailable', 'provider failed');
  state.submit.mockImplementation(async (_command, _category, _identity, onFailure) => {
    onFailure(error);
    return null;
  });
  expect(await render().applyCreation(task, { patch: { title: 'renamed' } })).toEqual({
    saved: false,
    message: 'provider failed',
  });
});

it('recovers a compound creation one confirmed phase at a time without replaying its edit', async () => {
  const input = CreateTaskSchema.parse({ accountId: 'account', listId: 'list', title: 'task' });
  current = { ...current, ...input };
  state.created.mockImplementation(async () => ({ ...current }));
  let failRead = false;
  const read = state.read.getMockImplementation()!;
  state.read.mockImplementation(async (path: string) => {
    if (path.includes('/operations/'))
      return { id: 'patch-receipt', accountId: 'account', state: 'succeeded' };
    if (failRead) {
      failRead = false;
      throw new RequestError('storage_unavailable', 'post-edit read failed');
    }
    return read(path);
  });
  const save = state.submit.getMockImplementation()!;
  state.submit.mockImplementation(async (command) => {
    const receipt = await save(command);
    if (command.kind === 'task.edit') {
      failRead = true;
      return { ...receipt, id: 'patch-receipt' };
    }
    return receipt;
  });
  function owner() {
    state.cursor = 0;
    const changes = useTaskChanges('account', 0);
    const actions = useTaskActions({ ...context, changes }, 0);
    return useTaskCreations('account', 0, { onReady: actions.applyCreation });
  }
  owner().start(1, input);
  owner().items[0]!.controls!.onStar(true);
  owner().items[0]!.controls!.onComplete(true);
  await owner().finish(1, 'create-receipt');
  expect(state.submit.mock.calls.map((call) => call[0].kind)).toEqual(['task.edit']);
  expect(owner().items[0]!.failure).toBeDefined();
  await owner().finish(1, 'create-receipt');
  expect(state.submit.mock.calls.map((call) => call[0].kind)).toEqual([
    'task.edit',
    'task.complete',
  ]);
  expect(current).toMatchObject({ starred: true, completed: true });
  expect(owner().items[0]!.failure).toBeUndefined();
  expect(owner().items[0]!.confirmedAfter).toBe(0);
});
