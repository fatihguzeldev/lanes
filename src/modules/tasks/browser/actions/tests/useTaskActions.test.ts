import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../contracts/task';
import type { TaskActionContext } from '../task-actions';
import { useTaskActions } from '../useTaskActions';

const state = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
  read: vi.fn(),
  submit: vi.fn(),
  failure: null as { message: string; operationId?: string } | null,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (value: unknown) => {
        state.slots[index] = value;
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
  useCommands: () => ({ submit: state.submit, getErrorDetails: () => state.failure }),
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: state.read }));
vi.mock('../../../../operations/browser/submission/operation-identity', () => ({
  newOperationId: () => 'quick-receipt',
}));
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
    state.submit.mockResolvedValue(null);
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
