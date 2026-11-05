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

type Changes = { topology: boolean; tasks: boolean };
type Step = SyncAdvance & { status: SyncStatus; changes: Changes };
function step(
  phase: SyncAdvance['phase'],
  {
    pending = false,
    delay = 300,
    errorCode,
    changes = {
      topology: !errorCode && ['default', 'inventory', 'list_check'].includes(phase),
      tasks: !errorCode && ['tasks', 'task_check', 'list_check'].includes(phase),
    },
  }: { pending?: boolean; delay?: number; errorCode?: string; changes?: Changes } = {},
): Step {
  return {
    accountId: 'account-a',
    phase,
    continued: pending,
    changes,
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
    vi.stubGlobal(
      'document',
      Object.assign(new EventTarget(), {
        visibilityState: 'visible',
      }),
    );
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
    expect(boundary.request.mock.calls[0]?.[0]).toBe(
      '/api/accounts/account-a/sync?status=1&changes=1',
    );
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
      '/api/accounts/account-a/sync?status=1&changes=1',
      '/api/accounts/account-a/sync/advance?status=1&changes=1',
      '/api/accounts/account-a/sync/advance?status=1&changes=1',
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
      () => step('idle'),
    );
    const changed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(300);
    await sync.refresh('manual');
    release(step('tasks'));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    await sync.refresh('manual');
    expect(changed.mock.calls).toEqual([
      [{ topology: true, tasks: true }],
      [{ topology: true, tasks: true }],
    ]);
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
      [{ topology: true, tasks: true }],
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

  it('continues ready work without adding a fixed wait between requests', async () => {
    serve(
      () => step('inventory', { pending: true, delay: 0 }),
      () => step('tasks'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(2);
  });

  it('waits only until the actual future retry time', async () => {
    serve(
      () => step('inventory', { pending: true, delay: 125 }),
      () => step('tasks'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(124);
    expect(boundary.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(2);
  });

  it('interprets retry timestamps using the server clock offset', async () => {
    serve(
      () => step('inventory', { pending: true, delay: 60_500 }),
      () => step('tasks'),
    );
    useWorkspaceSync('account-a', vi.fn(), true, 60_000);
    await vi.advanceTimersByTimeAsync(499);
    expect(boundary.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(2);
  });

  it('does not hot-spin when another worker owns already-due work', async () => {
    serve(
      () => step('coalesced', { pending: true, delay: 0 }),
      () => step('idle'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(999);
    expect(boundary.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(2);
  });

  it('backs off consecutive already-due idle and coalesced responses up to ten seconds', async () => {
    serve(
      ...['coalesced', 'idle', 'coalesced', 'idle', 'coalesced', 'idle'].map(
        (phase) => () => step(phase as SyncAdvance['phase'], { pending: true, delay: 0 }),
      ),
      () => step('idle'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    for (const [index, wait] of [1000, 2000, 4000, 8000, 10_000, 10_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(boundary.request).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(boundary.request).toHaveBeenCalledTimes(index + 2);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets no-progress backoff after meaningful work without slowing ready work', async () => {
    serve(
      () => step('coalesced', { pending: true, delay: 0 }),
      () => step('coalesced', { pending: true, delay: 0 }),
      () => step('tasks', { pending: true, delay: 0 }),
      () => step('coalesced', { pending: true, delay: 0 }),
      () => step('idle'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(boundary.request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(boundary.request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(5);
  });

  it('honors a server-clock future retry even after no-progress backoff has increased', async () => {
    serve(
      () => step('coalesced', { pending: true, delay: 60_000 }),
      () => step('coalesced', { pending: true, delay: 60_000 }),
      () => step('coalesced', { pending: true, delay: 60_125 }),
      () => step('idle'),
    );
    useWorkspaceSync('account-a', vi.fn(), true, 60_000);
    await vi.advanceTimersByTimeAsync(3124);
    expect(boundary.request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(4);
  });

  it('respects a future coalesced retry without imposing the no-progress floor', async () => {
    serve(
      () => step('coalesced', { pending: true, delay: 125 }),
      () => step('idle'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(124);
    expect(boundary.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(boundary.request).toHaveBeenCalledTimes(2);
  });

  it('keeps immediate continuations serial while the next response is pending', async () => {
    let release!: (value: Step) => void;
    serve(
      () => step('inventory', { pending: true, delay: 0 }),
      () => new Promise<Step>((resolve) => (release = resolve)),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(boundary.request).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    release(step('tasks'));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not advance a queued slice after the tab becomes hidden', async () => {
    serve(
      () => step('inventory', { pending: true, delay: 125 }),
      () => step('tasks'),
    );
    useWorkspaceSync('account-a', vi.fn(), true);
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(document, { visibilityState: 'hidden' });
    await vi.advanceTimersByTimeAsync(125);
    expect(boundary.request).toHaveBeenCalledTimes(1);
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.request).toHaveBeenCalledTimes(2);
    expect(boundary.request.mock.calls[1]?.[0]).toBe(
      '/api/accounts/account-a/sync?status=1&changes=1',
    );
  });

  it('defers entry while hidden and begins when the account becomes visible', async () => {
    Object.assign(document, { visibilityState: 'hidden' });
    serve(() => step('tasks'));
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.request).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(boundary.request).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate unchanged inventory or task scans', async () => {
    serve(
      () => step('inventory', { pending: true, changes: { topology: false, tasks: false } }),
      () => step('tasks', { changes: { topology: false, tasks: false } }),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(changed).not.toHaveBeenCalled();
  });

  it('reports successful unchanged completion independently of read invalidation', async () => {
    serve(() => step('tasks', { changes: { topology: false, tasks: false } }));
    const changed = vi.fn();
    const refreshed = vi.fn();
    useWorkspaceSync('account-a', changed, true, 0, refreshed);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it.each(['manual', 'stale'] as const)(
    'rereads cached local state once after %s refresh even if provider state already matches',
    async (reason) => {
      const unchanged = { topology: false, tasks: false };
      serve(
        () => step('tasks', { changes: unchanged }),
        () => step('inventory', { pending: true, delay: 125, changes: unchanged }),
        () => step('tasks', { changes: unchanged }),
      );
      const changed = vi.fn();
      const refreshed = vi.fn();
      const sync = useWorkspaceSync('account-a', changed, true, 0, refreshed);
      await vi.advanceTimersByTimeAsync(0);
      expect(changed).not.toHaveBeenCalled();
      refreshed.mockClear();
      await sync.refresh(reason);
      expect(changed).not.toHaveBeenCalled();
      expect(refreshed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(125);
      expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
      expect(refreshed).toHaveBeenCalledTimes(1);
    },
  );

  it('merges confirmed changes into the single manual settlement reread', async () => {
    serve(
      () => step('tasks', { changes: { topology: false, tasks: false } }),
      () => step('tasks', { changes: { topology: false, tasks: true } }),
    );
    const changed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    await sync.refresh('manual');
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
  });

  it('rereads once after a failed manual response without also reporting success', async () => {
    serve(
      () => step('tasks', { changes: { topology: false, tasks: false } }),
      () => {
        throw new Error('response lost');
      },
    );
    const changed = vi.fn();
    const refreshed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true, 0, refreshed);
    await vi.advanceTimersByTimeAsync(0);
    refreshed.mockClear();
    await sync.refresh('manual');
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('reports completion only after continuing work actually settles', async () => {
    serve(
      () => step('inventory', { pending: true, delay: 125 }),
      () => step('tasks'),
    );
    const refreshed = vi.fn();
    useWorkspaceSync('account-a', vi.fn(), true, 0, refreshed);
    await vi.advanceTimersByTimeAsync(124);
    expect(refreshed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it('does not report successful completion during a retained long backoff', async () => {
    serve(() => step('tasks', { pending: true, delay: 31_000 }));
    const refreshed = vi.fn();
    useWorkspaceSync('account-a', vi.fn(), true, 0, refreshed);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('does not report completion when the response settles in a hidden tab', async () => {
    let release!: (value: Step) => void;
    serve(() => new Promise<Step>((resolve) => (release = resolve)));
    const refreshed = vi.fn();
    useWorkspaceSync('account-a', vi.fn(), true, 0, refreshed);
    Object.assign(document, { visibilityState: 'hidden' });
    release(step('tasks'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshed).not.toHaveBeenCalled();
  });

  it.each([undefined, 'reconnect_required'] as const)(
    'does not report completion after an unsuccessful refresh: %s',
    async (errorCode) => {
      serve(() => {
        if (!errorCode) throw new Error('response lost');
        return step('tasks', { errorCode });
      });
      const refreshed = vi.fn();
      useWorkspaceSync('account-a', vi.fn(), true, 0, refreshed);
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshed).not.toHaveBeenCalled();
    },
  );

  it('reports successful settlement by another worker once', async () => {
    serve(() => step('coalesced'));
    const changed = vi.fn();
    const refreshed = vi.fn();
    useWorkspaceSync('account-a', changed, true, 0, refreshed);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it('uses the actual batch flags rather than inferring changes from its last phase', async () => {
    serve(() => step('tasks', { changes: { topology: true, tasks: false } }));
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: false }]]);
  });

  it('retains confirmed batch changes when a later step in that batch fails', async () => {
    serve(() =>
      step('tasks', {
        errorCode: 'reconnect_required',
        changes: { topology: true, tasks: false },
      }),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: false }]]);
  });

  it.each([
    ['idle', undefined],
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

  it('refreshes once after externally claimed work finishes between polls', async () => {
    serve(
      () => step('coalesced', { pending: true, delay: 5_000 }),
      () => step('coalesced', { pending: true, delay: 5_000 }),
      () => step('coalesced', { pending: true, delay: 5_000 }),
      () => step('idle'),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
  });

  it('refreshes once when another worker removes the job before status is read', async () => {
    serve(() => step('coalesced'));
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes once when previously pending work disappears during an idle poll', async () => {
    serve(
      () => step('idle', { pending: true }),
      () => step('idle'),
    );
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
  });

  it('reconciles a job that finishes between its committed slice and status read', async () => {
    serve(() => ({ ...step('inventory'), continued: true }));
    const changed = vi.fn();
    useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
  });

  it('retains pending external work across a foreground backoff pause', async () => {
    serve(
      () => step('coalesced', { pending: true, delay: 31_000 }),
      () => step('idle'),
    );
    const changed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    expect(vi.getTimerCount()).toBe(0);
    await sync.refresh('manual');
    expect(changed.mock.calls).toEqual([
      [{ topology: true, tasks: true }],
      [{ topology: true, tasks: true }],
    ]);
  });

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

  it('retains unknown work after a lost first response until a later refresh settles', async () => {
    serve(
      () => {
        throw new Error('the first response was lost');
      },
      () => step('idle'),
    );
    const changed = vi.fn();
    const sync = useWorkspaceSync('account-a', changed, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed.mock.calls).toEqual([[{ topology: true, tasks: true }]]);
    await sync.refresh('manual');
    expect(changed.mock.calls).toEqual([
      [{ topology: true, tasks: true }],
      [{ topology: true, tasks: true }],
    ]);
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
