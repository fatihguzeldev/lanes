import type { ConnectionSummary } from '../../accounts/contracts';
export interface TransferProps {
  initialTab?: 'import' | 'export';
  account: ConnectionSummary;
  accounts: readonly ConnectionSummary[];
  clockOffset: number;
  version?: number;
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenOperation?: (operationId: string) => void;
  onOpenTask?: (reference: { accountId: string; taskId: string }) => void;
}
export const transferBase = (accountId: string) =>
  `/api/accounts/${encodeURIComponent(accountId)}/transfer`;
export const accountBase = (accountId: string) => `/api/accounts/${encodeURIComponent(accountId)}`;
export const escaped = encodeURIComponent;
export const pageQuery = (cursor?: string, limit = 10) =>
  `?limit=${limit}${cursor ? `&cursor=${escaped(cursor)}` : ''}`;
export const writable = (account: ConnectionSummary) =>
  !['disconnecting', 'disconnected'].includes(account.state);
export const providerReady = (account: ConnectionSummary) =>
  account.state === 'connected' && account.permissions.tasks;
export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'this action could not finish. your input stays here.';
