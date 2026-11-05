import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncAdvance, SyncStatus } from '../../../contracts/sync';

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  cleanups: [] as (() => void)[],
}));
vi.mock('react', () => ({
  useState: (value: unknown) => [value, () => {}],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) boundary.cleanups.push(cleanup);
  },
}));
vi.mock('../../../../../shared/browser/http/http', () => ({ request: boundary.request }));

import { useWorkspaceSync } from '../useWorkspaceSync';

type Step = SyncAdvance & { status: SyncStatus };
function step(
  phase: SyncAdvance['phase'],
  {
    pending = false,
    delay = 300,
    errorCode,
  }: { pending?: boolean; delay?: number; errorCode?: string } = {},
): Step {
  return {
    accountId: 'account-a',
    phase,
    continued: pending,
    ...(errorCode ? { errorCode } : {}),
    status: {
      initialized: true,
      pending,
      nextAttemptAt: pending ? Date.now() + delay : null,
      phase,
      errorCode: errorCode ?? null,
    },
  };
}
function serve(...steps: (() => Step | Promise<Step>)[]) {
  let last = step('idle');
  boundary.request.mockImplementation(
    async (_path: string, _schema: unknown, options: { method?: string }) => {
      if (options.method !== 'POST') return last.status;
      const next = steps.shift();
      if (!next) throw new Error('the refresh requested an unexpected extra slice');
      last = await next();
      return last;
    },
  );
}

describe('workspace sync flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    boundary.request.mockReset();
    boundary.cleanups = [];
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    });
  });
  afterEach(() => {
    boundary.cleanups.forEach((cleanup) => cleanup());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the status returned by each slice without a second status request', async () => {
    serve(() => step('coalesced'));
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.request).toHaveBeenCalledTimes(1);
    expect(boundary.request.mock.calls[0]?.[0]).toBe('/api/accounts/account-a/sync?status=1');
    expect(boundary.request.mock.calls[0]?.[2].method).toBe('POST');
  });

  it('refreshes a retained workspace once after inventory and task work finish', async () => {
    serve(
      () => step('inventory', { pending: true }),
      () => step('tasks', { pending: true }),
      () => step('tasks'),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(boundary.request.mock.calls.map(([path]) => path)).toEqual([
      '/api/accounts/account-a/sync?status=1',
      '/api/accounts/account-a/sync/advance?status=1',
      '/api/accounts/account-a/sync/advance?status=1',
    ]);
  });

  it('retains committed changes when another refresh supersedes the pending run', async () => {
    serve(
      () => step('inventory', { pending: true }),
      () => step('tasks'),
    );
    const changed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    await sync.refresh('manual');
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not merge a superseded late response into the replacement refresh', async () => {
    let release!: (value: Step) => void;
    serve(
      () => step('inventory', { pending: true }),
      () => new Promise<Step>((resolve) => (release = resolve)),
      () => step('coalesced'),
    );
    const changed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(300);
    await sync.refresh('manual');
    release(step('tasks'));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: false }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bootstraps cold topology early without a second special first-task invalidation', async () => {
    serve(
      () => step('inventory', { pending: true }),
      () => step('tasks', { pending: true }),
      () => step('idle'),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: false }]]);
    await vi.advanceTimersByTimeAsync(300);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(changed.mock.calls).toEqual([
      [{ topology: true, tasks: false }],
      [{ topology: false, tasks: true }],
    ]);
  });

  it('coalesces long retained refreshes until ten seconds or final settlement', async () => {
    serve(
      () => step('inventory', { pending: true, delay: 5_000 }),
      () => step('tasks', { pending: true, delay: 5_000 }),
      () => step('tasks', { pending: true, delay: 5_000 }),
      () => step('tasks'),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changed.mock.calls).toEqual([
      [{ topology: true, tasks: true }],
      [{ topology: false, tasks: true }],
    ]);
  });

  it.each([
    ['idle', undefined],
    ['coalesced', undefined],
    ['tasks', 'reconnect_required'],
  ] as const)(
    'does not invalidate unchanged reads for %s with error %s',
    async (phase, errorCode) => {
      serve(() => step(phase, errorCode ? { errorCode } : {}));
      const changed = vi.fn();
      useWorkspaceSync('account-a', changed, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it('reconciles all possibly committed progress when a later response is lost', async () => {
    serve(
      () => step('inventory', { pending: true }),
      () => {
        throw new Error('the next slice failed');
      },
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
  });

  it('reconciles possibly committed writes when the first response is lost', async () => {
    serve(() => {
      throw new Error('the first slice failed');
    });
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not invalidate a cancelled account from its late response', async () => {
    let release!: (value: Step) => void;
    serve(() => new Promise<Step>((resolve) => (release = resolve)));
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    boundary.cleanups[0]!();
    release(step('inventory'));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
