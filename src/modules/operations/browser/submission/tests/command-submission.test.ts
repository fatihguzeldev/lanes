import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '../../../../../shared/browser/http/http';
import type { OperationSummary } from '../../../contracts/receipt';
import { useCommands } from '../useCommands';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  read: vi.fn(),
  writes: 0,
  effects: [] as Array<() => void | (() => void)>,
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
        state.writes++;
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
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: state.read,
}));

const identity = '1730000000000:abcdefghijklmnop';
const receipt = (patch: Partial<OperationSummary> = {}): OperationSummary => ({
  id: identity,
  accountId: 'account',
  kind: 'task.patch',
  state: 'succeeded',
  createdAt: 1,
  updatedAt: 1,
  cancelRequested: false,
  totalSteps: 1,
  confirmedSteps: 1,
  inputSealed: true,
  error: null,
  nextAttemptAt: null,
  finished: true,
  ...patch,
});
function render(offset = 0, independent = false) {
  state.cursor = 0;
  state.writes = 0;
  state.effects = [];
  return useCommands('account', offset, vi.fn(), { independent });
}
beforeEach(() => {
  state.slots = [];
  state.cursor = 0;
  state.read.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('command submission recovery', () => {
  it.each(['admission', 'recovery', 'continuation'] as const)(
    'ignores a late successful %s response after cleanup',
    async (phase) => {
      let finish!: (operation: OperationSummary) => void;
      const delayed = () =>
        new Promise<OperationSummary>((resolve) => {
          finish = resolve;
        });
      if (phase === 'recovery')
        state.read
          .mockRejectedValueOnce(new Error('lost response'))
          .mockImplementationOnce(delayed);
      else if (phase === 'continuation') {
        vi.useFakeTimers();
        state.read
          .mockResolvedValueOnce(receipt({ state: 'accepted', confirmedSteps: 0, finished: false }))
          .mockImplementationOnce(delayed);
      } else state.read.mockImplementationOnce(delayed);
      const commands = render();
      const cleanup = state.effects[0]!()!;
      const saving = commands.submit(
        { kind: 'task.patch' },
        phase === 'continuation' ? 'provider' : 'local',
        identity,
      );
      if (phase === 'continuation') await vi.advanceTimersByTimeAsync(350);
      else
        await vi.waitFor(() =>
          expect(state.read).toHaveBeenCalledTimes(phase === 'recovery' ? 2 : 1),
        );
      cleanup();
      const writes = state.writes;
      finish(receipt());
      expect(await saving).toBeNull();
      expect(state.writes).toBe(writes);
    },
  );

  it('returns the recovered confirmed receipt after a response is lost', async () => {
    state.read.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(receipt());
    const commands = render();
    expect(await commands.submit({ kind: 'task.patch' }, 'local', identity)).toMatchObject({
      state: 'succeeded',
    });
    expect(render().error).toBe('');
    expect(render().errorDetails).toBeNull();
  });

  it('keeps definite admission errors actionable without inventing or fetching a receipt', async () => {
    const failure = new RequestError('conflict', 'this task changed. refresh it.');
    state.read.mockRejectedValue(failure);
    const commands = render();
    expect(await commands.submit({ kind: 'task.patch' }, 'local', identity)).toBeNull();
    expect(commands.getErrorDetails()).toBe(failure);
    expect(state.read).toHaveBeenCalledOnce();
  });

  it('uses the server clock offset when continuing a provider operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_730_000_000_000);
    state.read
      .mockResolvedValueOnce(
        receipt({
          state: 'accepted',
          confirmedSteps: 0,
          finished: false,
          nextAttemptAt: Date.now() + 120_000,
        }),
      )
      .mockResolvedValueOnce(receipt());
    const saving = render(120_000).submit({ kind: 'task.complete' }, 'provider', identity);
    await vi.advanceTimersByTimeAsync(350);
    expect(await saving).toMatchObject({ state: 'succeeded' });
    expect(state.read).toHaveBeenCalledTimes(2);
  });
});

describe('command submission queue', () => {
  it('runs independent task saves concurrently and keeps the remaining save pending', async () => {
    const complete = new Map<string, (operation: OperationSummary) => void>();
    state.read.mockImplementation(
      (_path, _schema, options) =>
        new Promise((resolve) => {
          complete.set(options.body.operationId, resolve);
        }),
    );
    const commands = render(0, true);
    const first = commands.submit({ kind: 'task.complete', taskId: 'one' }, 'provider', 'first');
    const second = commands.submit({ kind: 'task.patch', taskId: 'two' }, 'local', 'second');
    await vi.waitFor(() => expect(complete.size).toBe(2));
    expect(render(0, true).pendingTaskIds).toEqual(new Set(['one', 'two']));
    complete.get('second')!(receipt({ id: 'second' }));
    await second;
    expect(render(0, true).pendingTaskIds).toEqual(new Set(['one']));
    expect(commands.isBusy()).toBe(true);
    complete.get('first')!(receipt({ id: 'first' }));
    await first;
    expect(render(0, true).busy).toBe(false);
  });
  it('keeps independent admission errors associated with their own submission', async () => {
    const failures = new Map<string, (error: Error) => void>();
    state.read.mockImplementation(
      (_path, _schema, options) =>
        new Promise((_resolve, reject) => {
          failures.set(options.body.operationId, reject);
        }),
    );
    const commands = render(0, true);
    const onFirst = vi.fn(),
      onSecond = vi.fn();
    const first = commands.submit({ kind: 'task.patch', taskId: 'one' }, 'local', 'first', onFirst);
    const second = commands.submit(
      { kind: 'task.patch', taskId: 'two' },
      'local',
      'second',
      onSecond,
    );
    await vi.waitFor(() => expect(failures.size).toBe(2));
    const firstError = new RequestError('conflict', 'one changed');
    const secondError = new RequestError('conflict', 'two changed');
    failures.get('second')!(secondError);
    failures.get('first')!(firstError);
    await Promise.all([first, second]);
    expect(onFirst).toHaveBeenCalledWith(firstError);
    expect(onSecond).toHaveBeenCalledWith(secondError);
  });
  it('aborts every independent request when the account owner unmounts', async () => {
    const signals: AbortSignal[] = [];
    const finish: Array<(operation: OperationSummary) => void> = [];
    state.read.mockImplementation(
      (_path, _schema, options) =>
        new Promise((resolve) => {
          signals.push(options.signal);
          finish.push(resolve);
        }),
    );
    const commands = render(0, true);
    const cleanup = state.effects[0]!()!;
    const first = commands.submit({ kind: 'task.patch', taskId: 'one' }, 'local', 'first');
    const second = commands.submit({ kind: 'task.patch', taskId: 'two' }, 'local', 'second');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    cleanup();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const writes = state.writes;
    finish.forEach((resolve) => resolve(receipt()));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(state.writes).toBe(writes);
  });
  it('keeps distinct rapid changes in order instead of dropping a busy submission', async () => {
    let finish!: (operation: OperationSummary) => void;
    state.read
      .mockImplementationOnce(
        () =>
          new Promise<OperationSummary>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(receipt({ id: 'second' }));
    const commands = render();
    const first = commands.submit({ kind: 'task.patch', taskId: 'one' }, 'local', identity);
    const input = { kind: 'task.patch', taskId: 'two', patch: { starred: true } };
    const second = commands.submit(input, 'local', 'second');
    input.patch.starred = false;
    await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce());
    expect(render().busy).toBe(true);
    finish(receipt());
    expect(await first).toMatchObject({ id: identity });
    expect(await second).toMatchObject({ id: 'second' });
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.read.mock.calls[1]?.[2]).toMatchObject({
      body: { operationId: 'second', command: { taskId: 'two', patch: { starred: true } } },
    });
    expect(render().busy).toBe(false);
  });

  it('does not dispatch queued work after its account owner unmounts', async () => {
    let finish!: (operation: OperationSummary) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise<OperationSummary>((resolve) => {
          finish = resolve;
        }),
    );
    const commands = render();
    const cleanup = state.effects[0]!()!;
    const first = commands.submit({ kind: 'task.patch' }, 'local', identity);
    const second = commands.submit({ kind: 'task.patch' }, 'local', 'second');
    await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce());
    cleanup();
    const writes = state.writes;
    finish(receipt());
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(state.read).toHaveBeenCalledOnce();
    expect(state.writes).toBe(writes);
  });
});

it('does not lock the source row while duplicating a task', async () => {
  let finish!: (value: OperationSummary) => void;
  state.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = render().submit(
    { kind: 'task.duplicate', taskId: 'source' },
    'provider',
    identity,
  );
  await Promise.resolve();
  expect(render().pendingTaskIds.has('source')).toBe(false);
  finish(receipt({ kind: 'task.duplicate' }));
  await saving;
});
