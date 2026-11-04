import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Coverage, Page } from '../../../../shared/contracts/http';
import {
  ArchiveHeaderSchema,
  ArchiveRecordSchema,
  type ArchiveHeader,
} from '../../contracts/archive';
import type { ArchiveDownloadPage, ArchiveExportSummary } from '../../contracts/archive-export';
import { hash, size } from './export-integrity';
import { conflict, type Run, type SavedRecord } from './export-state';

/** Reads frozen captures; no provider reads or capture writes occur here. */
export class ArchiveExportQueries {
  constructor(
    private readonly db: D1Database,
    private readonly options: { now?: () => number } = {},
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async readRun(accountId: string, id: string): Promise<Run> {
    const row = await this.db
      .prepare('SELECT * FROM transfer_archive_exports WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first<Run>();
    if (!row)
      throw new AppError(
        'not_found',
        'this archive export is not available in the selected account',
        404,
      );
    return row;
  }

  async get(accountId: string, id: string): Promise<ArchiveExportSummary> {
    const run = await this.readRun(accountId, id);
    return {
      id,
      accountId,
      header: ArchiveHeaderSchema.parse(JSON.parse(run.header_json)),
      state: run.state,
      phase: run.phase,
      recordCount: run.record_count,
      bytes: run.bytes,
      taskCount: run.task_count,
      listCount: run.list_count,
      unmatchedSchedules: run.unmatched_schedules,
      captureHash: run.state === 'ready' ? run.capture_hash : null,
      downloadAvailable:
        run.state === 'ready' &&
        run.payload_pruned_at === null &&
        run.finished_at !== null &&
        this.now() < run.finished_at + 86400000,
      payloadExpiresAt:
        run.finished_at === null ? null : new Date(run.finished_at + 86400000).toISOString(),
      freshness: run.freshness_json ? (JSON.parse(run.freshness_json) as Coverage) : null,
      error: run.error_code
        ? {
            code: run.error_code,
            message:
              run.error_code === 'validation_failed'
                ? 'this archive exceeds a supported size, shape, or reference bound. select a narrower scope.'
                : 'the source could not be captured completely. start a new export when it is available.',
          }
        : null,
    };
  }

  async downloadPage(
    accountId: string,
    id: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<ArchiveDownloadPage> {
    const run = await this.readRun(accountId, id);
    if (run.state !== 'ready')
      throw conflict('finish capturing this complete archive before downloading it');
    if (
      run.payload_pruned_at !== null ||
      run.finished_at === null ||
      this.now() >= run.finished_at + 86400000
    )
      throw conflict(
        'this archive payload expired after24 hours; generate a new export to download it',
      );
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError('validation_failed', 'download at most10 archive records per page', 422);
    let after = -1;
    if (input.cursor) {
      try {
        const cursor = z
          .object({
            id: z.string(),
            accountId: z.string(),
            hash: z.string(),
            position: z.number().int().min(-1),
          })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (cursor.id !== id || cursor.accountId !== accountId || cursor.hash !== run.capture_hash)
          throw new Error();
        after = cursor.position;
      } catch {
        throw new AppError(
          'validation_failed',
          'this archive download cursor belongs to another capture',
          422,
        );
      }
    }
    const candidates = (
      await this.db
        .prepare(
          'SELECT position,byte_count FROM transfer_archive_export_records WHERE export_id=? AND position>? ORDER BY position LIMIT ?',
        )
        .bind(id, after, limit + 1)
        .all<{ position: number; byte_count: number }>()
    ).results;
    let chunk = input.cursor ? '' : '{"header":' + run.header_json + ',"records":[',
      bytes = size(chunk);
    const positions: number[] = [];
    for (const row of candidates.slice(0, limit)) {
      if (bytes + row.byte_count + 3 > 65536) break;
      positions.push(row.position);
      bytes += row.byte_count + 1;
    }
    const records = positions.length
      ? (
          await this.db
            .prepare(
              'SELECT item_key,position,kind,source_id,input_json,input_hash,byte_count FROM transfer_archive_export_records WHERE export_id=? AND position IN(SELECT value FROM json_each(?)) ORDER BY position',
            )
            .bind(id, JSON.stringify(positions))
            .all<SavedRecord>()
        ).results
      : [];
    for (const record of records) {
      const parsed = ArchiveRecordSchema.safeParse(JSON.parse(record.input_json));
      if (!parsed.success || (await hash(parsed.data)) !== record.input_hash)
        throw new AppError(
          'storage_unavailable',
          'a frozen archive record could not be read safely',
          503,
        );
      chunk += (after >= 0 ? ',' : '') + record.input_json;
      after = record.position;
    }
    const more = candidates.some((row) => row.position > after);
    if (!more) chunk += ']}';
    if (more && !records.length)
      throw new AppError(
        'validation_failed',
        'one captured archive record exceeds its download bound',
        422,
      );
    return {
      chunk,
      nextCursor: more
        ? btoa(JSON.stringify({ id, accountId, hash: run.capture_hash, position: after }))
        : null,
      generatedAt: (JSON.parse(run.header_json) as ArchiveHeader).generatedAt,
      totalBytes: run.bytes,
      recordCount: run.record_count,
    };
  }

  async list(
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ArchiveExportSummary>> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError('validation_failed', 'read at most10 archive exports at once', 422);
    let anchor: { id: string; createdAt: number } | null = null;
    if (input.cursor) {
      try {
        const value = z
          .object({ accountId: z.string(), id: z.string(), createdAt: z.number().int() })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (value.accountId !== accountId) throw new Error();
        anchor = value;
      } catch {
        throw new AppError(
          'validation_failed',
          'this archive list cursor belongs to another account',
          422,
        );
      }
    }
    const rows = (
        await this.db
          .prepare(
            `SELECT id,created_at FROM transfer_archive_exports WHERE account_id=? ${anchor ? 'AND(created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .bind(accountId, ...(anchor ? [anchor.createdAt, anchor.id] : []), limit + 1)
          .all<{ id: string; created_at: number }>()
      ).results,
      selected = rows.slice(0, limit),
      last = selected.at(-1);
    const items = await Promise.all(selected.map((row) => this.get(accountId, row.id)));
    if (size(JSON.stringify(items)) > 65536)
      throw new AppError('validation_failed', 'read fewer archive summaries at once', 422);
    return {
      items,
      nextCursor:
        last && rows.length > selected.length
          ? btoa(JSON.stringify({ accountId, id: last.id, createdAt: last.created_at }))
          : null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
    };
  }
}
