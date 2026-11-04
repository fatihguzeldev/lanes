import { useCallback, useEffect, useState } from 'react';
import type { InitialViewReadiness } from '../../shared/browser/resources/readiness';
import { initialWorkspaceReady } from './workspace-startup';

interface Input {
  scope: string;
  version: number;
  topologyReady: boolean;
  foregroundSettled: boolean;
  metadataSettled: boolean;
  metadataFailed: boolean;
  viewRequired: boolean;
}

export function useInitialWorkspaceReveal({ scope, ...input }: Input) {
  const [initialView, setInitialView] = useState<{
    key: string;
    state: InitialViewReadiness;
  } | null>(null);
  const onInitialReady = useCallback(
    (state: InitialViewReadiness) => {
      setInitialView((previous) =>
        previous?.key === scope &&
        previous.state.version === state.version &&
        previous.state.settled === state.settled &&
        previous.state.baselineComplete === state.baselineComplete &&
        previous.state.failed === state.failed
          ? previous
          : { key: scope, state },
      );
    },
    [scope],
  );
  const [revealed, setRevealed] = useState(false);
  const initialReady = initialWorkspaceReady({
    ...input,
    view: initialView?.key === scope ? initialView.state : null,
  });

  useEffect(() => {
    if (initialReady) setRevealed(true);
  }, [initialReady]);
  return { revealed, onInitialReady };
}
