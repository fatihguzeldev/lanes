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
function render(offset = 0) {
  state.cursor = 0;
  state.writes = 0;
  state.effects = [];
  return useCommands('account', offset, vi.fn());
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
});
