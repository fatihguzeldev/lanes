import { describe, expect, it } from 'vitest';
import { syncPresentation } from './sync-presentation';

const ready = { connected: true, reachable: true, busy: false, error: '', status: null };

describe('workspace sync presentation', () => {
  it('does not report success before the account has been read', () => {
    expect(syncPresentation(ready).kind).toBe('unknown');
  });

  it('keeps a stopped refresh with pending work distinct from success', () => {
    expect(
      syncPresentation({
        ...ready,
        status: { initialized: true, pending: true, errorCode: null },
      }).kind,
    ).toBe('paused');
  });

  it('reports a completed refresh only while the connection is available', () => {
    const input = {
      ...ready,
      status: { initialized: true, pending: false, errorCode: null },
    };
    expect(syncPresentation(input).kind).toBe('synced');
    expect(syncPresentation({ ...input, reachable: false }).kind).toBe('error');
    expect(syncPresentation({ ...input, connected: false }).kind).toBe('paused');
  });

  it('shows provider failure and active refresh instead of stale success', () => {
    const status = { initialized: true, pending: false, errorCode: null };
    expect(syncPresentation({ ...ready, status, busy: true }).kind).toBe('syncing');
    expect(
      syncPresentation({
        ...ready,
        status: { ...status, errorCode: 'provider_unavailable' },
        busy: true,
      }).kind,
    ).toBe('syncing');
    expect(
      syncPresentation({ ...ready, status: { ...status, errorCode: 'provider_unavailable' } }).kind,
    ).toBe('error');
  });
});
