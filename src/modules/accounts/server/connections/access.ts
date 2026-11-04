import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';

export async function assertLocalWritable(db: D1Database, accountId: string): Promise<void> {
  const account = await db
    .prepare('SELECT state FROM accounts_connections WHERE id=?')
    .bind(accountId)
    .first<{ state: string }>();
  if (!account)
    throw new AppError('not_found', 'this connected account is no longer available.', 404);
  if (account.state === 'disconnected')
    throw new AppError(
      'reconnect_required',
      'relink this disconnected account before changing its workspace.',
      409,
    );
  if (account.state === 'disconnecting')
    throw new AppError(
      'conflict',
      'this account is disconnecting. already issued work is settling.',
      409,
    );
}

export async function assertProviderWritable(db: D1Database, accountId: string): Promise<void> {
  await assertLocalWritable(db, accountId);
  const account = await db
    .prepare('SELECT state FROM accounts_connections WHERE id=?')
    .bind(accountId)
    .first<{ state: string }>();
  if (account?.state === 'reconnect_required')
    throw new AppError(
      'reconnect_required',
      'reconnect this google account to resume provider changes.',
      409,
    );
  if (account?.state === 'temporarily_unavailable')
    throw new AppError(
      'provider_unavailable',
      'google is temporarily unavailable. your workspace is retained.',
      503,
      true,
    );
  if (account?.state !== 'connected')
    throw new AppError('conflict', 'this account is still connecting.', 409);
}

/** An account-owned SQL fence, executed in the dispatcher's atomic D1 batch. */
export function providerWriteGuard(db: D1Database, accountId: string) {
  return db
    .prepare(
      `INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS
    (SELECT 1 FROM accounts_connections WHERE id=? AND state='connected' AND disconnect_requested_at IS NULL)`,
    )
    .bind(accountId);
}

/** Retained local organization may change during expiry, never after disconnect. */
export function localWriteGuard(db: D1Database, accountId: string) {
  return db
    .prepare(
      `INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS
    (SELECT 1 FROM accounts_connections WHERE id=? AND state NOT IN ('disconnecting','disconnected') AND disconnect_requested_at IS NULL)`,
    )
    .bind(accountId);
}

export async function assertDisconnecting(db: D1Database, accountId: string): Promise<void> {
  const account = await db
    .prepare('SELECT state FROM accounts_connections WHERE id=?')
    .bind(accountId)
    .first<{ state: string }>();
  if (!account)
    throw new AppError('not_found', 'this connected account is no longer available.', 404);
  if (!['disconnecting', 'disconnected'].includes(account.state))
    throw new AppError('conflict', 'request disconnect before settling queued work.', 409);
}

export function disconnectWorkGuard(db: D1Database, accountId: string) {
  return db
    .prepare(
      `INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS
    (SELECT 1 FROM accounts_connections WHERE id=? AND state IN ('disconnecting','disconnected'))`,
    )
    .bind(accountId);
}
