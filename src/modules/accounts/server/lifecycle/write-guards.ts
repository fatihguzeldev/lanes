import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';

export async function assertAccountNotRemoving(db: D1Database, accountId: string): Promise<void> {
  const row = await db
    .prepare('SELECT removal_requested_at FROM accounts_connections WHERE id=?')
    .bind(accountId)
    .first<{ removal_requested_at: number | null }>();
  if (row?.removal_requested_at !== null && row?.removal_requested_at !== undefined)
    throw new AppError(
      'conflict',
      'this account’s local data is being removed. wait until removal finishes before linking it again.',
      409,
    );
}

export function accountRemovalGuard(db: D1Database, accountId: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM accounts_connections WHERE id=? AND state='disconnected' AND grant_ciphertext IS NULL AND removal_requested_at IS NOT NULL)",
    )
    .bind(accountId);
}
