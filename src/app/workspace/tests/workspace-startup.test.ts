import { describe, expect, it } from 'vitest';
import { initialWorkspaceReady } from '../workspace-startup';

const ready = {
  topologyReady: true,
  foregroundSettled: false,
  metadataSettled: true,
  metadataFailed: false,
  viewRequired: true,
  version: 2,
  view: { version: 2, settled: true, baselineComplete: true, failed: false },
};
describe('initial workspace reveal', () => {
  it('waits for the first provider topology boundary and every required local read', () => {
    expect(initialWorkspaceReady({ ...ready, topologyReady: false })).toBe(false);
    expect(initialWorkspaceReady({ ...ready, metadataSettled: false })).toBe(false);
    expect(initialWorkspaceReady({ ...ready, view: { ...ready.view, settled: false } })).toBe(
      false,
    );
    expect(initialWorkspaceReady(ready)).toBe(true);
  });
  it('rejects a ready view from before the topology invalidation', () => {
    expect(initialWorkspaceReady({ ...ready, view: { ...ready.view, version: 1 } })).toBe(false);
  });
  it('waits for cold visible provider baselines while the foreground run is advancing', () => {
    const cold = { ...ready, view: { ...ready.view, baselineComplete: false } };
    expect(initialWorkspaceReady(cold)).toBe(false);
    expect(initialWorkspaceReady({ ...cold, foregroundSettled: true })).toBe(true);
  });
  it('reveals a cached complete first page without waiting for unrelated provider work', () => {
    expect(initialWorkspaceReady(ready)).toBe(true);
  });
  it('releases errors and paused work into the existing recovery controls', () => {
    const cold = { ...ready, view: { ...ready.view, baselineComplete: false } };
    expect(initialWorkspaceReady({ ...cold, view: { ...cold.view, failed: true } })).toBe(true);
    expect(initialWorkspaceReady({ ...cold, metadataFailed: true })).toBe(true);
    expect(initialWorkspaceReady({ ...ready, viewRequired: false, view: null })).toBe(true);
  });
});
