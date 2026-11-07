import { useEffect, useRef } from 'react';

interface Options {
  enabled: boolean;
  dirty: boolean;
  pending: boolean;
  submitted: boolean;
  failed: boolean;
  onSubmit(): boolean;
  onClose(): void;
}

/** Valid input leaves immediately; the retained workspace owns admission and its result. */
export function useTaskCreateExit(options: Options) {
  const leaving = useRef(false);
  useEffect(() => {
    if (!options.enabled || !leaving.current) return;
    if (options.failed) leaving.current = false;
  }, [options.enabled, options.failed]);
  const leave = (explicit: boolean) => {
    if (!options.enabled) {
      options.onClose();
      return;
    }
    if (!options.dirty) {
      options.onClose();
      return;
    }
    if (options.pending) {
      if (options.submitted) options.onClose();
      return;
    }
    if (options.submitted) {
      options.onClose();
      return;
    }
    if ((options.failed && !explicit) || leaving.current) return;
    leaving.current = true;
    if (options.onSubmit()) options.onClose();
    else leaving.current = false;
  };
  return { close: () => leave(false), submit: () => leave(true) };
}
