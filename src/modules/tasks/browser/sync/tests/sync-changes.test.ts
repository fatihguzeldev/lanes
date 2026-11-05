import { describe, expect, it } from 'vitest';
import { syncChanges } from '../useWorkspaceSync';

describe('sync read invalidation', () => {
  it.each(['idle', 'coalesced'] as const)('does not reload for %s polls', (phase) => {
    expect(syncChanges({ phase })).toEqual({ topology: false, tasks: false });
  });
  it.each(['default', 'inventory'] as const)('refreshes board topology after %s', (phase) => {
    expect(syncChanges({ phase })).toEqual({ topology: true, tasks: false });
  });
  it.each(['tasks', 'task_check'] as const)('refreshes task reads after %s', (phase) => {
    expect(syncChanges({ phase })).toEqual({ topology: false, tasks: true });
  });
  it('refreshes both topology and task reads after a list check', () => {
    expect(syncChanges({ phase: 'list_check' })).toEqual({ topology: true, tasks: true });
  });
  it('does not treat a failed slice as confirmed progress', () => {
    expect(syncChanges({ phase: 'tasks', errorCode: 'reconnect_required' })).toEqual({
      topology: false,
      tasks: false,
    });
  });
});
