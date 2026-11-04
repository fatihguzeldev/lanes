import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { ConnectionState } from '../../contracts/connection';

export interface ConnectionRow {
  id: string;
  google_subject: string;
  email: string;
  display_name: string;
  picture_url: string | null;
  state: ConnectionState;
  grant_ciphertext: string | null;
  scopes_json: string;
  access_expires_at: number | null;
  grant_expires_at: number | null;
  token_revision: number;
  revision: number;
  planning_zone: string;
  week_start: 1 | 7;
  disconnect_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function readConnection(db: D1Database, id: string): Promise<ConnectionRow> {
  const row = await db
    .prepare('SELECT * FROM accounts_connections WHERE id=?')
    .bind(id)
    .first<ConnectionRow>();
  if (!row) throw new AppError('not_found', 'this connected account was not found.', 404);
  return row;
}
