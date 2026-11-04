import type { ProviderAccess } from '../credentials/provider-access';

export interface LifecycleOwner {
  name: string;
  pause(accountId: string): Promise<{ done: boolean; pending: boolean }>;
  remove(accountId: string, limit: number): Promise<{ done: boolean; deleted: number }>;
  hasUnresolved(accountId: string): Promise<boolean>;
}

export interface AccountLifecycleOptions {
  access: Pick<ProviderAccess, 'requestDisconnect' | 'finalizeDisconnect'>;
  owners: readonly LifecycleOwner[];
  now?: () => number;
  id?: () => string;
}
