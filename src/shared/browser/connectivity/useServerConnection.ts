import { useSyncExternalStore } from 'react';
import { serverConnection, subscribeServerConnection } from './connectivity';

export function useServerConnection() {
  return useSyncExternalStore(
    subscribeServerConnection,
    serverConnection,
    () => 'reachable' as const,
  );
}
