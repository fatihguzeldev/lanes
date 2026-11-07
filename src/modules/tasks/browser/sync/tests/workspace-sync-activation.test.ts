import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncForeground } from '../../../contracts/sync';
import { useWorkspaceSync } from '../useWorkspaceSync';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void>,
  writes: [] as unknown[],
  request: vi.fn(),
}));
const same = (prior: unknown[] | undefined, next: unknown[]) =>
  prior?.length === next.length && next.every((value, index) => Object.is(value, prior[index]));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = next;
        hooks.writes.push(next);
      },
    ];
  },
  useRef: (current: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown, dependencies: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.slots[index] as
      { dependencies: unknown[]; callback: unknown } | undefined;
    if (!same(previous?.dependencies, dependencies))
      hooks.slots[index] = { dependencies, callback };
    return (hooks.slots[index] as { callback: unknown }).callback;
  },
  useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]) => {
    const index = hooks.index++;
    const previous = hooks.slots[index] as
      { dependencies: unknown[]; cleanup?: (() => void) | undefined } | undefined;
    if (same(previous?.dependencies, dependencies)) return;
    hooks.effects.push(() => {
      previous?.cleanup?.();
      hooks.slots[index] = { dependencies, cleanup: effect() };
    });
  },
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: hooks.request }));

const finished = (): SyncForeground => ({
  accountId: 'account',
  phase: 'tasks',
  continued: false,
  changes: { topology: false, tasks: true },
  status: {
    initialized: true,
    pending: false,
    nextAttemptAt: null,
    phase: 'tasks',
    errorCode: null,
  },
});
const tick = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};
function mount() {
  const changed = vi.fn(),
    refreshed = vi.fn();
  const render = (enabled: boolean) => {
    hooks.index = 0;
    hooks.effects = [];
    const sync = useWorkspaceSync('account', changed, true, 0, refreshed, enabled);
    hooks.effects.forEach((effect) => effect());
    return sync;
  };
  return { changed, refreshed, render };
}
beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.effects = [];
  hooks.writes = [];
  hooks.request.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
});
afterEach(() => {
  for (const value of hooks.slots) (value as { cleanup?: () => void } | null)?.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('retained account sync activation', () => {
  it('does not read, schedule continuations, or subscribe to visibility while inactive', async () => {
    const listen = vi.spyOn(document, 'addEventListener');
    const owner = mount();
    owner.render(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks.request).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(hooks.writes).toEqual([]);
    expect(owner.changed).not.toHaveBeenCalled();
  });

  it('aborts an active read and ignores its late values after account selection changes', async () => {
    let release!: (value: SyncForeground) => void;
    hooks.request.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const owner = mount();
    owner.render(true);
    const signal = hooks.request.mock.calls[0]![2].signal as AbortSignal;
    owner.render(false);
    expect(signal.aborted).toBe(true);
    hooks.writes = [];
    release(finished());
    await tick();
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(hooks.request).toHaveBeenCalledOnce();
    expect(hooks.writes).toEqual([]);
    expect(owner.changed).not.toHaveBeenCalled();
    expect(owner.refreshed).not.toHaveBeenCalled();
  });

  it('cancels a queued continuation while inactive, then starts fresh on return', async () => {
    hooks.request
      .mockResolvedValueOnce({
        ...finished(),
        continued: true,
        status: { ...finished().status, pending: true, nextAttemptAt: 100_500 },
      })
      .mockResolvedValue(finished());
    const owner = mount();
    owner.render(true);
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    owner.render(false);
    expect(vi.getTimerCount()).toBe(0);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hooks.request).toHaveBeenCalledOnce();
    owner.render(true);
    await tick();
    expect(hooks.request).toHaveBeenCalledTimes(2);
    expect(hooks.request.mock.calls[1]![0]).toBe('/api/accounts/account/sync?status=1&changes=1');
    expect(owner.changed).toHaveBeenCalledExactlyOnceWith({ topology: true, tasks: true });
    expect(owner.refreshed).toHaveBeenCalledOnce();
  });
  it('does not let an old refresh callback start work after its account becomes inactive', async () => {
    const owner = mount();
    const inactive = owner.render(false);
    await inactive.refresh('manual');
    await tick();
    expect(hooks.request).not.toHaveBeenCalled();
    hooks.request.mockResolvedValue(finished());
    const active = owner.render(true);
    await tick();
    owner.render(false);
    await active.refresh('manual');
    await tick();
    expect(hooks.request).toHaveBeenCalledOnce();
  });

  it('rereads kept local data once on return even when unchanged provider work replaced an aborted refresh', async () => {
    hooks.request
      .mockResolvedValueOnce({
        ...finished(),
        phase: 'inventory',
        continued: true,
        changes: { topology: true, tasks: false },
        status: { ...finished().status, pending: true, nextAttemptAt: 100_500 },
      })
      .mockResolvedValue({ ...finished(), changes: { topology: false, tasks: false } });
    const owner = mount();
    owner.render(true);
    await tick();
    expect(owner.changed).not.toHaveBeenCalled();
    owner.render(false);
    owner.render(true);
    await tick();
    expect(hooks.request.mock.calls.map((call) => call[2].body.reason)).toEqual(['entry', 'stale']);
    expect(owner.changed).toHaveBeenCalledExactlyOnceWith({ topology: true, tasks: true });
  });

  it('keeps the first unchanged activation free of a redundant local reread', async () => {
    hooks.request.mockResolvedValue({ ...finished(), changes: { topology: false, tasks: false } });
    const owner = mount();
    owner.render(false);
    owner.render(true);
    await tick();
    expect(hooks.request.mock.calls[0]![2].body.reason).toBe('entry');
    expect(owner.changed).not.toHaveBeenCalled();
  });
});
