import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSummary } from '../../../contracts/connection';
import { useAccountPreferences } from '../AccountPreferences';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void | (() => void)>,
  read: vi.fn(),
  submit: vi.fn(),
  busy: false,
  error: '',
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
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
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => ({
    submit: hooks.submit,
    busy: hooks.busy,
    error: hooks.error,
    getErrorDetails: () => null,
  }),
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: hooks.read }));
vi.mock('../../../../../shared/browser/connectivity/useServerConnection', () => ({
  useServerConnection: () => 'reachable',
}));
const account = {
  id: 'account',
  state: 'connected',
  planningZone: 'UTC',
  weekStart: 1,
  revision: 7,
} as ConnectionSummary;
let current: ConnectionSummary;
const changed = vi.fn();
const failed = vi.fn();
function render(value = account) {
  hooks.index = 0;
  hooks.effects = [];
  return useAccountPreferences({
    account: value,
    clockOffset: 0,
    onChanged: changed,
    onError: failed,
  });
}
beforeEach(() => {
  hooks.slots = [];
  hooks.busy = false;
  hooks.error = '';
  current = { ...account };
  changed.mockReset();
  failed.mockReset();
  hooks.read.mockReset().mockImplementation(async () => ({ ...current }));
  hooks.submit.mockReset().mockImplementation(async (command) => {
    const { revision: _, ...patch } = command.input;
    current = { ...current, ...patch, revision: current.revision + 1 };
    return { state: 'succeeded' };
  });
});
describe('background account preferences', () => {
  it('shows the chosen settings immediately and queues later changes without disabling the controls', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = hooks.submit.getMockImplementation()!;
    hooks.submit.mockImplementationOnce(async (...args) => {
      await blocked;
      return save(...args);
    });
    render().save({ planningZone: 'Europe/Istanbul' });
    hooks.busy = true;
    expect(render().account.planningZone).toBe('Europe/Istanbul');
    expect(render().disabled).toBe(false);
    render().save({ weekStart: 7 });
    expect(render().account.weekStart).toBe(7);
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledOnce());
    finish();
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(2));
    expect(hooks.submit.mock.calls.map(([command]) => command.input)).toEqual([
      { revision: 7, planningZone: 'Europe/Istanbul' },
      { revision: 8, weekStart: 7 },
    ]);
  });
  it('restores the confirmed settings and discards unsent dependent changes on failure', async () => {
    hooks.submit.mockResolvedValue({ state: 'uncertain' });
    render().save({ planningZone: 'Europe/Istanbul' });
    render().save({ weekStart: 7 });
    await vi.waitFor(() => expect(render().busy).toBe(false));
    expect(render().account).toEqual(account);
    expect(hooks.submit).toHaveBeenCalledOnce();
  });
  it('reports failures outside the settings surface and preserves the receipt', async () => {
    hooks.submit.mockResolvedValue({
      id: 'preference-save',
      state: 'uncertain',
      error: { message: 'check this change' },
    });
    render().save({ planningZone: 'Europe/Istanbul' });
    await vi.waitFor(() => expect(render().busy).toBe(false));
    expect(failed).toHaveBeenCalledWith('check this change', 'preference-save');
    expect(render().error).toBe('check this change');
  });

  it('does not dispatch an old account read after cleanup and strict-mode replay', async () => {
    let finish!: (value: ConnectionSummary) => void;
    hooks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const preferences = render();
    const effect = hooks.effects[0]!;
    const cleanup = effect()!;
    preferences.save({ planningZone: 'Europe/Istanbul' });
    cleanup();
    effect();
    finish(account);
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.submit).not.toHaveBeenCalled();
  });

  it('does not revert a confirmed choice while the account snapshot is still stale', async () => {
    render().save({ planningZone: 'Europe/Istanbul' });
    await vi.waitFor(() => expect(render().busy).toBe(false));
    expect(render().account.planningZone).toBe('Europe/Istanbul');
    expect(render(current).account).toEqual(current);
  });
});
