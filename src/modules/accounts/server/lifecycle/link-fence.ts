import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';

export async function subjectHash(subject: string): Promise<string> {
  if (!subject || subject.length > 512)
    throw new AppError(
      'validation_failed',
      'provide a verified google subject for the account link fence',
      422,
    );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('lanes-account-removal:' + subject),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function accountRelinkFence(
  subject: string,
  startedAt: number,
): Promise<{ sql: string; values: (string | number)[] }> {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0)
    throw new AppError('validation_failed', 'preserve the original authorization start time', 422);
  return {
    sql: 'NOT EXISTS(SELECT 1 FROM accounts_removed_subjects WHERE subject_hash=? AND fresh_after>=?)',
    values: [await subjectHash(subject), startedAt],
  };
}

export async function assertAccountLinkFresh(
  db: D1Database,
  subject: string,
  startedAt: number,
): Promise<{ sql: string; values: (string | number)[] }> {
  const fence = await accountRelinkFence(subject, startedAt);
  if (
    !(await db
      .prepare(`SELECT 1 AS fresh WHERE ${fence.sql}`)
      .bind(...fence.values)
      .first())
  )
    throw new AppError(
      'conflict',
      'this authorization began before local account removal finished. start a new account link.',
      409,
    );
  return fence;
}

export async function maintainAccountLifecycle(
  db: D1Database,
  now = Date.now(),
  limit = 100,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AppError('validation_failed', 'clean at most 100 expired account link fences', 422);
  return (
    await db
      .prepare(
        'DELETE FROM accounts_removed_subjects WHERE subject_hash IN(SELECT subject_hash FROM accounts_removed_subjects WHERE fresh_after<? ORDER BY fresh_after LIMIT ?)',
      )
      .bind(now - 86_400_000, limit)
      .run()
  ).meta.changes;
}
