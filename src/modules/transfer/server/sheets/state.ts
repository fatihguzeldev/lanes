import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import type { ErrorCode } from '../../../../shared/contracts/http';
import { SheetsExportRequestSchema, type CsvExportPage } from '../../contracts/export';

export const beginSchema = SheetsExportRequestSchema.extend({
  accountId: ResourceIdSchema.max(1024),
  ownerSubject: ResourceIdSchema.max(1024),
}).strict();

export interface Run {
  id: string;
  account_id: string;
  owner_subject: string;
  request_json: string;
  request_hash: string;
  title: string;
  state: string;
  revision: number;
  nonce: string | null;
  cursor: string | null;
  capture_hash: string;
  generated_at: string | null;
  freshness_json: string | null;
  counts_json: string;
  row_count: number;
  column_count: number;
  chunk_count: number;
  captured_bytes: number;
  promoted_chunks: number;
  confirmed_rows: number;
  file_id: string | null;
  file_url: string | null;
  confirmed_at: number | null;
  finished_at: number | null;
  error_code: ErrorCode | null;
  created_at: number;
  updated_at: number;
  cancel_requested: number;
  active_step: string | null;
  active_claim: string | null;
  active_until: number | null;
  unresolved: number;
}

export interface Chunk {
  position: number;
  start_row: number;
  data_rows: number;
  row_count: number;
  rows_json: string;
  input_hash: string;
  byte_count: number;
}

export const emptyCounts = (): CsvExportPage['counts'] => ({
  tasks: 0,
  parentContext: 0,
  omittedDependencies: 0,
  missingParents: 0,
  missingLabels: 0,
  unsupportedHierarchy: 0,
});

export async function readSheetsExport(
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Run> {
  const row = await db
    .prepare('SELECT * FROM transfer_sheets_exports WHERE id=? AND account_id=?')
    .bind(id, accountId)
    .first<Run>();
  if (!row)
    throw new AppError(
      'not_found',
      'this sheets export is not available in the selected account',
      404,
    );
  return row;
}
