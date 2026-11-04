import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Coverage } from '../../../../shared/contracts/http';
import { ResourceIdSchema, type TaskList } from '../../contracts';

interface ListRow {
  id: string;
  account_id: string;
  title: string;
  provider_id: string;
  provider_etag: string | null;
  is_default: number;
  revision: number;
}
const fields = 'id,account_id,title,provider_id,provider_etag,is_default,revision';
function list(row: ListRow): TaskList {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    providerId: row.provider_id,
    providerEtag: row.provider_etag,
    isDefault: row.is_default === 1,
    revision: row.revision,
  };
}

/** Read seam for composition owners; provider and projection storage stay here. */
export async function readActiveList(
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<TaskList | null> {
  try {
    const row = await db
      .prepare(
        `SELECT ${fields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(accountId, listId)
      .first<ListRow>();
    return row ? list(row) : null;
  } catch {
    throw new AppError('storage_unavailable', 'the list could not be read', 503, true);
  }
}

/** One bounded read avoids a query per list without exceeding D1 bind limits. */
export async function readActiveLists(
  db: D1Database,
  accountId: string,
  listIds: readonly string[],
): Promise<TaskList[]> {
  const parsed = z.array(ResourceIdSchema).max(100).safeParse(listIds);
  if (!parsed.success)
    throw new AppError('validation_failed', 'read at most 100 list identities at a time', 422);
  if (!listIds.length) return [];
  try {
    const rows = await db
      .prepare(
        `SELECT ${fields} FROM tasks_lists
      WHERE account_id=? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(accountId, JSON.stringify(listIds))
      .all<ListRow>();
    return rows.results.map(list);
  } catch {
    throw new AppError('storage_unavailable', 'the lists could not be read', 503, true);
  }
}

/** Provider-list coverage remains separate from local board metadata freshness. */
export async function readListInventoryCoverage(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<Coverage> {
  try {
    const row = await db
      .prepare(
        'SELECT inventory_complete_at,inventory_cursor FROM tasks_account_state WHERE account_id=?',
      )
      .bind(accountId)
      .first<{ inventory_complete_at: number | null; inventory_cursor: string | null }>();
    const at = row?.inventory_complete_at ?? null;
    return {
      complete: at !== null,
      lastSyncedAt: at === null ? null : new Date(at).toISOString(),
      stale: at === null || now - at >= 60_000 || row?.inventory_cursor !== null,
    };
  } catch {
    throw new AppError(
      'storage_unavailable',
      'list inventory coverage could not be read',
      503,
      true,
    );
  }
}
