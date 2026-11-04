import type { SyncStatus } from '../sync-contract';

interface SyncInput {
  connected: boolean;
  reachable: boolean;
  busy: boolean;
  error: string;
  status: Pick<SyncStatus, 'initialized' | 'pending' | 'errorCode'> | null;
}

export function syncPresentation(input: SyncInput): {
  kind: 'unknown' | 'syncing' | 'synced' | 'paused' | 'error';
  label: string;
} {
  if (!input.reachable) return { kind: 'error', label: 'server unavailable' };
  if (!input.connected) return { kind: 'paused', label: 'google connection paused' };
  if (input.busy) return { kind: 'syncing', label: 'syncing' };
  if (input.error || input.status?.errorCode) return { kind: 'error', label: 'couldn’t refresh' };
  if (input.status?.pending) return { kind: 'paused', label: 'sync paused' };
  if (input.status?.initialized) return { kind: 'synced', label: 'synced' };
  return { kind: 'unknown', label: 'not synced yet' };
}
