import { describe, expect, it } from 'vitest';
import { initialWorkspaceReady } from '../workspace-startup';

const ready = {
  retainedWorkspace: false,
  topologyReady: true,
  foregroundSettled: false,
  metadataSettled: true,
  metadataFailed: false,
  viewRequired: true,
  version: 2,
  view: { version: 2, settled: true, baselineComplete: true, failed: false },
};
describe('initial workspace reveal', () => {
  it('waits for every required local read', () => {
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
    expect(initialWorkspaceReady({ ...ready, retainedWorkspace: true, topologyReady: false })).toBe(
      true,
    );
  });
  it('reveals a retained workspace after its current batch settles during a partial refresh', () => {
    const retained = {
      ...ready,
      retainedWorkspace: true,
      topologyReady: false,
      view: { ...ready.view, baselineComplete: false },
    };
    expect(initialWorkspaceReady(retained)).toBe(true);
    expect(initialWorkspaceReady({ ...retained, metadataSettled: false })).toBe(false);
    expect(initialWorkspaceReady({ ...retained, view: null })).toBe(false);
    expect(initialWorkspaceReady({ ...retained, view: { ...retained.view, settled: false } })).toBe(
      false,
    );
    expect(initialWorkspaceReady({ ...retained, view: { ...retained.view, version: 1 } })).toBe(
      false,
    );
  });
  it('reveals a retained empty board after its local metadata settles', () => {
    expect(
      initialWorkspaceReady({
        ...ready,
        retainedWorkspace: true,
        topologyReady: false,
        viewRequired: false,
        view: null,
      }),
    ).toBe(true);
  });
  it('keeps a cold empty workspace behind the skeleton until topology resolves', () => {
    expect(
      initialWorkspaceReady({
        ...ready,
        topologyReady: false,
        viewRequired: false,
        view: null,
      }),
    ).toBe(false);
    expect(initialWorkspaceReady({ ...ready, topologyReady: false })).toBe(false);
  });
  it('releases errors and paused work into the existing recovery controls', () => {
    const cold = { ...ready, view: { ...ready.view, baselineComplete: false } };
    expect(initialWorkspaceReady({ ...cold, view: { ...cold.view, failed: true } })).toBe(true);
    expect(initialWorkspaceReady({ ...cold, metadataFailed: true })).toBe(true);
    expect(initialWorkspaceReady({ ...ready, viewRequired: false, view: null })).toBe(true);
  });
});
