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
  it('removes a non-selected account when a complete session refresh no longer contains it', async () => {
    const seed = snapshot([first, second]);
    vi.mocked(request).mockResolvedValue(snapshot([first]));
    await render(seed).load();
    const owner = render(seed);
    expect(owner.selected?.id).toBe(first.id);
    expect(owner.session?.accounts?.items).toEqual([first]);
  });
  it('keeps previously loaded later pages when the refreshed first page is still partial', async () => {
    const seed = snapshot([first, second], 'more');
    const refreshed = { ...first, displayName: 'updated first', revision: 2 };
    vi.mocked(request).mockResolvedValue(snapshot([refreshed], 'more'));
    await render(seed).load();
    expect(render(seed).session?.accounts?.items).toEqual([refreshed, second]);
  });
  it('retains the selected and visited accounts while a partial refresh resolves its later-page selection', async () => {
    const seed = snapshot([first, second], 'more');
    let finishSession!: (next: SessionSnapshot) => void;
    let finishSelection!: (next: ConnectionSummary) => void;
    vi.mocked(request).mockImplementation((path) =>
      path === '/api/session'
        ? new Promise((resolve) => {
            finishSession = resolve;
          })
        : new Promise((resolve) => {
            finishSelection = resolve;
          }),
    );
    render(seed).selectAccount(second.id);
    expect(render(seed).session?.accounts?.items).toEqual([first, second]);
    expect(render(seed).selected?.id).toBe(second.id);
    finishSession(snapshot([first], 'more'));
    await settle();
    // A selected account outside the first page is resolved before publishing the new session.
    expect(render(seed).session?.accounts?.items).toEqual([first, second]);
    expect(render(seed).selected?.id).toBe(second.id);
    finishSelection(second);
    await settle();
    const owner = render(seed);
    expect(owner.selected?.id).toBe(second.id);
    expect(owner.session?.accounts?.items).toEqual([first, second]);
  });
  it('ignores a stale account page after an authoritative session refresh', async () => {
    const seed = snapshot([first], 'more');
    let finish!: (page: NonNullable<SessionSnapshot['accounts']>) => void;
    vi.mocked(request).mockImplementation((path) =>
      path.startsWith('/api/accounts?')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(snapshot([first])),
    );
    const owner = render(seed);
    owner.loadMoreAccounts();
    await owner.load();
    finish(snapshot([second]).accounts!);
    await settle();
    expect(render(seed).session?.accounts?.items).toEqual([first]);
    expect(vi.mocked(request).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });
  it('coalesces repeated requests for the same pending account page', async () => {
    const seed = snapshot([first], 'more');
    let finish!: (page: NonNullable<SessionSnapshot['accounts']>) => void;
    vi.mocked(request).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const owner = render(seed);
    owner.loadMoreAccounts();
    owner.loadMoreAccounts();
    expect(request).toHaveBeenCalledOnce();
    finish(snapshot([second]).accounts!);
    await settle();
    expect(render(seed).session?.accounts?.items).toEqual([first, second]);
  });
  it('does not open an old account page while its session refresh is pending', async () => {
    const seed = snapshot([first], 'more');
    let finish!: (next: SessionSnapshot) => void;
    vi.mocked(request).mockImplementation((path) =>
      path === '/api/session'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(snapshot([second]).accounts!),
    );
    const owner = render(seed);
    const loading = owner.load();
    owner.loadMoreAccounts();
    finish(snapshot([first]));
    await loading;
    await settle();
    expect(vi.mocked(request).mock.calls.map(([path]) => path)).toEqual(['/api/session']);
    expect(render(seed).session?.accounts?.items).toEqual([first]);
  });
  it('allows account pagination again once the current session refresh has settled', async () => {
    const seed = snapshot([first], 'more');
    vi.mocked(request).mockImplementation(async (path) =>
      path === '/api/session' ? seed : snapshot([second]).accounts!,
    );
    await render(seed).load();
    render(seed).loadMoreAccounts();
    await settle();
    expect(render(seed).session?.accounts?.items).toEqual([first, second]);
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
