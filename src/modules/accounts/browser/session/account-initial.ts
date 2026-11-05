import type { ConnectionSummary } from '../../contracts/connection';

const key = 'lanes.account-initial';

// This is a display hint for the loading shell, never session or access state.
export function readAccountInitial(selectedAccountId: string | null): string | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const hint = value as Record<string, unknown>;
    if (selectedAccountId && hint.accountId !== selectedAccountId) {
      clearAccountInitial();
      return null;
    }
    return typeof hint.accountId === 'string' &&
      typeof hint.initial === 'string' &&
      Array.from(hint.initial).length === 1
      ? hint.initial
      : null;
  } catch {
    return null;
  }
}

export function rememberAccountInitial(account: Pick<ConnectionSummary, 'id' | 'displayName'>) {
  const initial = Array.from(account.displayName.trim())[0] ?? '?';
  try {
    sessionStorage.setItem(key, JSON.stringify({ accountId: account.id, initial }));
  } catch {
    /* The confirmed identity still renders when storage is unavailable. */
  }
  return initial;
}

export function clearAccountInitial() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* A loading hint never authorizes access. */
  }
}
