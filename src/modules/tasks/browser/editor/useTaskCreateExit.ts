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

/** A create entry can leave after admission; its retained workspace owns the save. */
export function useTaskCreateExit(options: Options) {
  const leaving = useRef(false);
  useEffect(() => {
    if (!options.enabled || !leaving.current) return;
    if (options.failed) leaving.current = false;
    else if (options.submitted) {
      leaving.current = false;
      options.onClose();
    }
  }, [options.enabled, options.submitted, options.failed, options.onClose]);
  return () => {
    if (!options.enabled) {
      options.onClose();
      return;
    }
    if (options.pending) {
      if (options.submitted) options.onClose();
      return;
    }
    if (options.failed || options.submitted || leaving.current) return;
    if (!options.dirty) {
      options.onClose();
      return;
    }
    leaving.current = true;
    if (!options.onSubmit()) leaving.current = false;
  };
}
