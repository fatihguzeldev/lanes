import type { InitialViewReadiness } from '../../shared/browser/resources/readiness';

export function initialWorkspaceReady(input: {
  retainedWorkspace: boolean;
  topologyReady: boolean;
  foregroundSettled: boolean;
  metadataSettled: boolean;
  metadataFailed: boolean;
  viewRequired: boolean;
  version: number;
  view: InitialViewReadiness | null;
}): boolean {
  if (!input.metadataSettled) return false;
  if (!input.viewRequired)
    return input.retainedWorkspace || input.topologyReady || input.metadataFailed;
  const view = input.view;
  if (view?.version !== input.version || !view.settled) return false;
  if (input.retainedWorkspace || view.failed || input.metadataFailed) return true;
  return input.topologyReady && (view.baselineComplete || input.foregroundSettled);
}
