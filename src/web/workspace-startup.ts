import type { InitialViewReadiness } from '../client/readiness';

export function initialWorkspaceReady(input: {
  topologyReady: boolean;
  foregroundSettled: boolean;
  metadataSettled: boolean;
  metadataFailed: boolean;
  viewRequired: boolean;
  version: number;
  view: InitialViewReadiness | null;
}): boolean {
  if (!input.topologyReady || !input.metadataSettled) return false;
  if (!input.viewRequired) return true;
  const view = input.view;
  return Boolean(
    view?.version === input.version &&
    view.settled &&
    (view.baselineComplete || view.failed || input.metadataFailed || input.foregroundSettled),
  );
}
