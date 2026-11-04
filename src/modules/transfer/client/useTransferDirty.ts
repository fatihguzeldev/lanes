import { useEffect, useRef } from 'react';
import type { TransferProps } from './transfer-context';
export function useTransferDirty(dirty: boolean, callback: TransferProps['onDirtyChange']) {
  const current = useRef(callback);
  current.current = callback;
  useEffect(() => {
    current.current?.(dirty);
    return () => current.current?.(false);
  }, [dirty]);
}
