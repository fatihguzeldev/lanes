import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { ErrorCode, Page } from '../../../../shared/contracts/http';
import { OperationIdSchema } from '../../../operations/contracts/receipt';
import type { OperationQueries } from '../../../operations/server/queries/receipts';
import type { CsvExportPage, SheetsExportSummary } from '../../contracts/export';
import { beginSchema, emptyCounts, readSheetsExport } from './state';

export class SheetsExportQueries {
  constructor(
    private readonly db: D1Database,
    private readonly operations: Pick<OperationQueries, 'summary'>,
  ) {}
  async get(accountId: string, id: string): Promise<SheetsExportSummary> {
    const run = await readSheetsExport(this.db, accountId, id),
      operation = await this.operations.summary(id, accountId);
    const previousAttempt = await this.db
      .prepare(
        'SELECT f.original_export_id,f.original_step_key,e.file_id,e.file_url FROM transfer_sheets_fresh_attempts f JOIN transfer_sheets_exports e ON e.id=f.original_export_id WHERE f.new_export_id=? AND f.account_id=?',
      )
      .bind(id, accountId)
      .first<{
        original_export_id: string;
        original_step_key: string;
        file_id: string | null;
        file_url: string | null;
      }>();
    const state =
      operation?.state ??
      ((run.state === 'admitted'
        ? 'failed'
        : run.state === 'finished'
          ? 'succeeded'
          : run.state === 'paused'
            ? 'reconnect_required'
            : run.state) as SheetsExportSummary['state']);
    const captured = beginSchema.safeParse(JSON.parse(run.request_json));
    return {
      id,
      accountId,
      title: run.title,
      selection: captured.success ? captured.data.export : null,
      state,
      captureHash: run.state === 'capturing' ? null : run.capture_hash,
      generatedAt: run.generated_at,
      totalRows: Math.max(0, run.row_count - (run.chunk_count ? 1 : 0)),
      confirmedRows: run.confirmed_rows,
      totalChunks: run.chunk_count,
      capturedBytes: run.captured_bytes,
      spreadsheet: run.file_id && run.file_url ? { id: run.file_id, url: run.file_url } : null,
      retryOf: previousAttempt
        ? {
            operationId: previousAttempt.original_export_id,
            stepKey: previousAttempt.original_step_key,
            duplicateRiskAccepted: true,
            spreadsheet:
              previousAttempt.file_id && previousAttempt.file_url
                ? { id: previousAttempt.file_id, url: previousAttempt.file_url }
                : null,
          }
        : null,
      duplicateRiskExplanation: previousAttempt
        ? 'the earlier request may have created or changed another spreadsheet. this explicit new attempt preserves that unresolved operation and copies its frozen input.'
        : null,
      freshness: run.freshness_json
        ? (JSON.parse(run.freshness_json) as CsvExportPage['freshness'])
        : null,
      counts: { ...emptyCounts(), ...(JSON.parse(run.counts_json) as CsvExportPage['counts']) },
      operation,
      error: operation?.error
        ? { code: operation.error.code as ErrorCode, message: operation.error.message }
        : run.error_code
          ? {
              code: run.error_code,
              message:
                'this export could not finish. its captured data and confirmed output are retained.',
            }
          : null,
    };
  }
  async list(
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<Page<SheetsExportSummary>> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError(
        'validation_failed',
        'read at most10 retained sheets exports at once',
        422,
      );
    let anchor: { createdAt: number; id: string } | null = null;
    if (input.cursor) {
      try {
        if (input.cursor.length > 4096) throw new Error();
        const value = z
          .object({
            accountId: z.string(),
            createdAt: z.number().int().safe(),
            id: OperationIdSchema,
          })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (value.accountId !== accountId) throw new Error();
        anchor = value;
      } catch {
        throw new AppError(
          'validation_failed',
          'this sheets export cursor belongs to another account',
          422,
        );
      }
    }
    const rows = (
      await this.db
        .prepare(
          `SELECT id,created_at FROM transfer_sheets_exports WHERE account_id=? ${anchor ? 'AND (created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .bind(accountId, ...(anchor ? [anchor.createdAt, anchor.id] : []), limit + 1)
        .all<{ id: string; created_at: number }>()
    ).results;
    const selected = rows.slice(0, limit),
      items: SheetsExportSummary[] = [];
    for (const row of selected) items.push(await this.get(accountId, row.id));
    if (new TextEncoder().encode(JSON.stringify(items)).byteLength > 64 * 1024)
      throw new AppError('validation_failed', 'read fewer sheets export summaries at a time', 422);
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        last && rows.length > selected.length
          ? btoa(JSON.stringify({ accountId, createdAt: last.created_at, id: last.id }))
          : null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
    };
  }
}
