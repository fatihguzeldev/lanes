import { describe, expect, it } from 'vitest';
import { syncProgressNeedsRefresh } from './useWorkspaceSync';

describe('visible sync progress', () => {
  it('does not reload for waiting or coalesced polls even after a long delay', () => {
    expect(syncProgressNeedsRefresh({ phase: 'idle' }, null, true, 100_000)).toBe(false);
    expect(syncProgressNeedsRefresh({ phase: 'coalesced' }, 0, false, 100_000)).toBe(false);
  });

  it('shows the first committed slice without waiting for the whole account', () => {
    expect(syncProgressNeedsRefresh({ phase: 'default' }, null, true, 0)).toBe(true);
    expect(syncProgressNeedsRefresh({ phase: 'inventory' }, null, true, 0)).toBe(true);
  });

  it('shows the first task page as inventory starts becoming usable', () => {
    expect(syncProgressNeedsRefresh({ phase: 'tasks' }, 0, true, 500)).toBe(true);
    expect(syncProgressNeedsRefresh({ phase: 'tasks' }, 500, false, 800)).toBe(false);
  });

  it('limits repeated alternating inventory and task progress to one update per ten seconds', () => {
    expect(syncProgressNeedsRefresh({ phase: 'inventory' }, 500, false, 1_000)).toBe(false);
    expect(syncProgressNeedsRefresh({ phase: 'tasks' }, 500, false, 1_300)).toBe(false);
    expect(syncProgressNeedsRefresh({ phase: 'tasks' }, 500, false, 10_499)).toBe(false);
    expect(syncProgressNeedsRefresh({ phase: 'tasks' }, 500, false, 10_500)).toBe(true);
    expect(syncProgressNeedsRefresh({ phase: 'task_check' }, 500, false, 10_500)).toBe(true);
  });

  it('does not treat an error response as a completed slice', () => {
    expect(
      syncProgressNeedsRefresh({ phase: 'tasks', errorCode: 'reconnect_required' }, null, true, 0),
    ).toBe(false);
  });
});
