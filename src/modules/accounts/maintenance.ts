import type { D1Database } from '@cloudflare/workers-types';

/** Indexed, bounded cleanup. A callback gets a post-expiry grace window to settle. */
export async function maintainAccounts(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db
      .prepare(
        'DELETE FROM accounts_sessions WHERE token_hash IN (SELECT token_hash FROM accounts_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 100)',
      )
      .bind(now),
    db
      .prepare(
        'DELETE FROM accounts_oauth_states WHERE state_hash IN (SELECT state_hash FROM accounts_oauth_states WHERE expires_at<? ORDER BY expires_at LIMIT 100)',
      )
      .bind(now - 60_000),
    db
      .prepare(
        'DELETE FROM accounts_rate_limits WHERE bucket IN (SELECT bucket FROM accounts_rate_limits WHERE window_start<? LIMIT 100)',
      )
      .bind(now - 86_400_000),
  ]);
}
