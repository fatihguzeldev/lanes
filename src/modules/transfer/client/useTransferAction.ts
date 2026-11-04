import { useEffect, useRef, useState } from 'react';
import { serverConnection } from '../../../shared/browser/connectivity/connectivity';
import { message } from './transfer-context';
export function useTransferAction(scope: string) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    active = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    active.current = false;
    setBusy(false);
    setError('');
    return () => lifetime.current.abort();
  }, [scope]);
  async function run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (active.current) return undefined;
    if (scope !== 'connection' && serverConnection() !== 'reachable') {
      setError(
        serverConnection() === 'incompatible'
          ? 'reload lanes before making another change.'
          : 'check the server connection before continuing. this editor keeps your unsent work.',
      );
      return undefined;
    }
    active.current = true;
    setBusy(true);
    setError('');
    const signal = lifetime.current.signal;
    try {
      return await action(signal);
    } catch (caught) {
      if (!signal.aborted) setError(message(caught));
      return undefined;
    } finally {
      if (!signal.aborted) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  return { busy, error, run, setError, signal: () => lifetime.current.signal };
}
