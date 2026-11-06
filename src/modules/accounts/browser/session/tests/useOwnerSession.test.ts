import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../../../contracts/session';
import type { ConnectionSummary } from '../../../contracts/connection';
import { request } from '../../../../../shared/browser/http/http';
import { useOwnerSession } from '../useOwnerSession';

const state = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as (() => void)[] }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (next: unknown) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    return (state.slots[state.cursor++] ??= { current: initial });
  },
  useCallback(callback: unknown, dependencies: unknown[]) {
    const index = state.cursor++;
    const previous = state.slots[index];
    if (
      !previous ||
      dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))
    ) {
      state.slots[index] = { callback, dependencies };
    }
    return state.slots[index].callback;
  },
  useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
    const index = state.cursor++;
    const previous = state.slots[index];
    if (
      !previous ||
      dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))
    ) {
      const next = { effect, dependencies, cleanup: undefined as (() => void) | void };
      state.slots[index] = next;
      state.effects.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect();
      });
    }
  },
}));
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: vi.fn(),
}));

const account = (id: string): ConnectionSummary => ({
  id,
  email: `${id}@example.com`,
  displayName: id,
  pictureUrl: null,
  state: 'connected',
  grantExpiresAt: null,
  permissions: { tasks: true, sheetsImport: false, sheetsExport: false },
  planningZone: 'UTC',
  weekStart: 1,
  revision: 1,
});
const first = account('first'),
  second = account('second');
const snapshot = (items = [first], nextCursor: string | null = null): SessionSnapshot => ({
  configured: true,
  authenticated: true,
  serverTime: 90700,
  accounts: {
    items,
    nextCursor,
    coverage: { complete: nextCursor === null, lastSyncedAt: null, stale: false },
  },
});
const anonymous: SessionSnapshot = { configured: true, authenticated: false, serverTime: 100500 };
let values: Map<string, string>;
let windowTarget: EventTarget;
function render(seed: SessionSnapshot | null, error = '') {
  state.cursor = 0;
  state.effects = [];
  const result = useOwnerSession(() => null, seed, error);
  state.effects.forEach((effect) => effect());
  return result;
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
beforeEach(() => {
  state.slots = [];
  state.cursor = 0;
  state.effects = [];
  vi.mocked(request).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal('performance', {
    timeOrigin: 90000,
    getEntriesByType: () => [{ responseStart: 200 }],
  });
  values = new Map([['lanes.account', first.id]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('localStorage', storage);
  windowTarget = Object.assign(new EventTarget(), { location: { search: '' } });
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('BroadcastChannel', undefined);
});
afterEach(() => {
  state.slots.forEach((slot) => slot?.cleanup?.());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('seeded owner session', () => {
  it('reveals the authorized selection without another session request, including strict effect replay', () => {
    const seed = snapshot();
    const owner = render(seed);
    expect(owner.session).toBe(seed);
    expect(owner.selected?.id).toBe(first.id);
    expect(owner.loadingInitial).toBe('f');
    expect(owner.clockOffset).toBe(500);
    for (const slot of state.slots) {
      if (slot?.effect) {
        slot.cleanup?.();
        slot.cleanup = slot.effect();
      }
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('resolves a remembered paged account using the document snapshot without mutating it', async () => {
    values.set('lanes.account', second.id);
    const seed = snapshot([first], 'more');
    vi.mocked(request).mockImplementation(async () => {
      vi.setSystemTime(280000);
      return second;
    });
    expect(render(seed).selected).toBeUndefined();
    await settle();
    const owner = render(seed);
    expect(owner.selected?.id).toBe(second.id);
    expect(owner.clockOffset).toBe(500);
    expect(seed.accounts?.items).toEqual([first]);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe('/api/accounts/second');
  });
  it('refreshes after switching away from and back to the initial account', async () => {
    const seed = snapshot([first, second]);
    vi.mocked(request).mockResolvedValue(seed);
    render(seed).selectAccount(second.id);
    render(seed);
    await settle();
    const secondOwner = render(seed);
    expect(secondOwner.selected?.id).toBe(second.id);
    secondOwner.selectAccount(first.id);
    render(seed);
    await settle();
    expect(render(seed).selected?.id).toBe(first.id);
    expect(vi.mocked(request).mock.calls.map(([path]) => path)).toEqual([
      '/api/session',
      '/api/session',
    ]);
  });
  it('keeps a server entry error visible until explicit retry', async () => {
    vi.mocked(request).mockResolvedValue(anonymous);
    const owner = render(null, 'try again');
    expect(owner.error).toBe('try again');
    expect(request).not.toHaveBeenCalled();
    await owner.load();
    expect(render(null, 'try again').session).toEqual(anonymous);
    expect(render(null, 'try again').error).toBe('');
  });
  it('clears seeded private state and revalidates on session expiry', async () => {
    const seed = snapshot();
    vi.mocked(request).mockResolvedValue(anonymous);
    render(seed);
    windowTarget.dispatchEvent(new Event('lanes.session-expired'));
    await settle();
    const owner = render(seed);
    expect(owner.session).toEqual(anonymous);
    expect(owner.selected).toBeUndefined();
    expect(owner.loadingInitial).toBeNull();
    expect(request).toHaveBeenCalledOnce();
    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe('/api/session');
  });
});
