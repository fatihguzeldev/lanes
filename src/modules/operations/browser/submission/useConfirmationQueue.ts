import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationChoice } from './Confirmation';

interface PendingConfirmation {
  id: number;
  choice: ConfirmationChoice;
}

/** Decisions remain account-owned while concurrent action previews finish. */
export function useConfirmationQueue() {
  const [entries, setEntries] = useState<PendingConfirmation[]>([]);
  const pending = useRef<PendingConfirmation[]>([]);
  const sequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const unresolved = pending.current;
      pending.current = [];
      for (const entry of unresolved) entry.choice.onCancel?.();
    };
  }, []);
  const request = useCallback((choice: ConfirmationChoice) => {
    if (!alive.current) {
      choice.onCancel?.();
      return;
    }
    pending.current = [...pending.current, { id: ++sequence.current, choice }];
    setEntries(pending.current);
  }, []);
  const close = useCallback((id: number) => {
    if (pending.current[0]?.id !== id) return;
    pending.current = pending.current.slice(1);
    if (alive.current) setEntries(pending.current);
  }, []);
  return { current: entries[0] ?? null, request, close };
}
