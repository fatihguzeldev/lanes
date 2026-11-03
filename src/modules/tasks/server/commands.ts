import type { D1Database } from '@cloudflare/workers-types';

/** Initialization is retryable and creates no provider content. */
export async function initializeTaskWorkspace(db: D1Database, accountId: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO tasks_account_state(account_id) VALUES (?)')
    .bind(accountId)
    .run();
}
