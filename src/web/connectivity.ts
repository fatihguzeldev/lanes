/** Browser reachability only. Google connection state remains account-owned. */
export type ServerConnection = 'reachable' | 'unreachable' | 'incompatible';
let connection: ServerConnection = 'reachable';
const listeners = new Set<() => void>();

export function serverConnection(): ServerConnection {
  return connection;
}
export function recordServerConnection(next: ServerConnection): void {
  // A different client/server contract requires a reload, not another mutation.
  if (connection === 'incompatible' || connection === next) return;
  connection = next;
  for (const listener of listeners) listener();
}
export function subscribeServerConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
