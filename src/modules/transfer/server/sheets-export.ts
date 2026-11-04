import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../shared/contracts/errors';
import type { ErrorCode, Page } from '../../../shared/contracts/http';
import { assertDisconnecting, assertLocalWritable, localWriteGuard } from '../../accounts/access';
import { ResourceIdSchema } from '../../tasks/contracts';
import { OperationIdSchema } from '../../tasks/operation-contract';
import type { ClaimedStep, OperationStore } from '../../tasks/server/operations';
import {
  FreshSheetsAttemptSchema,
  SheetsExportRequestSchema,
  type CsvExportPage,
  type SheetsExportSummary,
} from '../export-contract';
import { TaskCsvExportService, type TaskCsvExportOptions } from './csv-export';
import { GoogleSheetsClient, GoogleSheetsError } from './sheets';
import {
  SheetsResolutionService,
  type AdoptSheetsVerification,
  type StartSheetsVerification,
} from './sheets-resolution';

export const MAX_SHEETS_EXPORT_TASKS = 99_989;
export const MAX_SHEETS_EXPORT_BYTES = 20 * 1024 * 1024;
const maxChunks = 9999;
const beginSchema = SheetsExportRequestSchema.extend({
  accountId: ResourceIdSchema.max(1024),
  ownerSubject: ResourceIdSchema.max(1024),
}).strict();
export type BeginSheetsExport = z.input<typeof beginSchema>;
export interface SheetsExportOptions extends TaskCsvExportOptions {
  operations: OperationStore;
  clientFor: (accountId: string) => Promise<GoogleSheetsClient>;
  refreshRejectedToken?: (accountId: string, client: GoogleSheetsClient) => Promise<void>;
  remainingProviderRequests?: () => number;
}
export type { SheetsExportSummary } from '../export-contract';
export interface SheetsExportAdvance {
  run: SheetsExportSummary;
  advanced: boolean;
}
interface Run {
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
interface Chunk {
  position: number;
  start_row: number;
  data_rows: number;
  row_count: number;
  rows_json: string;
  input_hash: string;
  byte_count: number;
}
const cellsSchema = z
  .array(
    z
      .array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
      .min(1)
      .max(256),
  )
  .min(1)
  .max(10);
const stepSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('sheets.create'),
      title: z.string().min(1).max(1024),
      rowCount: z.number().int().min(1).max(100000),
      columnCount: z.number().int().min(1).max(256),
    })
    .strict(),
  z
    .object({
      action: z.literal('sheets.rows'),
      position: z.number().int().nonnegative(),
      startRow: z.number().int().positive(),
      dataRows: z.number().int().nonnegative(),
      rows: cellsSchema,
    })
    .strict(),
]);
const createdSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    url: z.string(),
  })
  .refine((value) => value.url === `https://docs.google.com/spreadsheets/d/${value.id}/edit`);
const countNames = [
  'tasks',
  'parentContext',
  'omittedDependencies',
  'missingParents',
  'missingLabels',
  'unsupportedHierarchy',
] as const;
const emptyCounts = (): CsvExportPage['counts'] => ({
  tasks: 0,
  parentContext: 0,
  omittedDependencies: 0,
  missingParents: 0,
  missingLabels: 0,
  unsupportedHierarchy: 0,
});
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function hash(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical(value))),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const conflict = (message = 'this export no longer matches its captured input') =>
  new AppError('conflict', message, 409);
const expired = () =>
  conflict(
    'this unrecorded export identity expired. inspect existing output before starting a new export.',
  );
function checkFreshId(id: string, now: number): void {
  if (!OperationIdSchema.safeParse(id).success) throw expired();
  const issued = Number(id.slice(0, 13));
  if (issued > now + 300000 || now - issued > 86400000) throw expired();
}

/** A spreadsheet is created only after every raw row has been captured and explicitly confirmed. */
export class SheetsExportService {
  private readonly rows: TaskCsvExportService;
  private readonly resolutions: SheetsResolutionService;
  constructor(
    private readonly db: D1Database,
    private readonly options: SheetsExportOptions,
  ) {
    this.rows = new TaskCsvExportService(options);
    this.resolutions = new SheetsResolutionService(db, options);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private async run(accountId: string, id: string): Promise<Run> {
    const row = await this.db
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

  async begin(input: BeginSheetsExport): Promise<SheetsExportSummary> {
    const parsed = beginSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'check the sheets export identity, selection, and completed-task choice',
        422,
      );
    const value = parsed.data,
      json = JSON.stringify(canonical(value)),
      requestHash = await hash(value);
    if (new TextEncoder().encode(json).byteLength > 64 * 1024)
      throw new AppError('validation_failed', 'choose a smaller bounded export selection', 422);
    const previous = await this.db
      .prepare('SELECT account_id,request_hash FROM transfer_sheets_exports WHERE id=?')
      .bind(value.operationId)
      .first<{ account_id: string; request_hash: string }>();
    if (previous) {
      if (previous.account_id !== value.accountId || previous.request_hash !== requestHash)
        throw conflict();
      return this.get(value.accountId, value.operationId);
    }
    checkFreshId(value.operationId, this.now());
    await assertLocalWritable(this.db, value.accountId);
    await this.db.batch([
      localWriteGuard(this.db, value.accountId),
      this.db
        .prepare(
          `INSERT INTO transfer_sheets_exports(id,account_id,owner_subject,request_json,request_hash,title,state,capture_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'capturing',?,?,?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          value.operationId,
          value.accountId,
          value.ownerSubject,
          json,
          requestHash,
          value.title,
          requestHash,
          this.now(),
          this.now(),
        ),
    ]);
    const saved = await this.run(value.accountId, value.operationId);
    if (saved.request_hash !== requestHash) throw conflict();
    return this.get(value.accountId, value.operationId);
  }

  async get(accountId: string, id: string): Promise<SheetsExportSummary> {
    const run = await this.run(accountId, id),
      operation = await this.options.operations.summary(id, accountId);
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

  async captureNext(accountId: string, id: string): Promise<SheetsExportSummary> {
    const run = await this.run(accountId, id);
    if (run.state !== 'capturing') return this.get(accountId, id);
    await assertLocalWritable(this.db, accountId);
    const fresh = await this.db
      .prepare(
        'SELECT original_export_id,original_capture_hash,cloned_chunks FROM transfer_sheets_fresh_attempts WHERE new_export_id=? AND account_id=?',
      )
      .bind(id, accountId)
      .first<{
        original_export_id: string;
        original_capture_hash: string;
        cloned_chunks: number;
      }>();
    if (fresh) return this.cloneNext(run, fresh);
    const request = beginSchema.parse(JSON.parse(run.request_json));
    try {
      checkFreshId(id, this.now());
      let limit = run.chunk_count ? 10 : 9;
      let page = await this.rows.rawPage(
        accountId,
        { ...request.export, limit },
        run.cursor ?? undefined,
      );
      let payload = JSON.stringify({
        action: 'sheets.rows',
        position: run.chunk_count,
        startRow: run.row_count + 1,
        dataRows: page.counts.tasks,
        rows: page.rows,
      });
      while (new TextEncoder().encode(payload).byteLength > 64 * 1024 && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        page = await this.rows.rawPage(
          accountId,
          { ...request.export, limit },
          run.cursor ?? undefined,
        );
        payload = JSON.stringify({
          action: 'sheets.rows',
          position: run.chunk_count,
          startRow: run.row_count + 1,
          dataRows: page.counts.tasks,
          rows: page.rows,
        });
      }
      const bytes = new TextEncoder().encode(payload).byteLength;
      if (bytes > 64 * 1024 || page.rows.length > 10 || (!page.rows.length && page.nextCursor))
        throw new AppError(
          'validation_failed',
          'one raw export chunk exceeds its bounded row size; choose a smaller record',
          422,
        );
      const totalRows = run.row_count + page.rows.length;
      if (
        totalRows - 1 > MAX_SHEETS_EXPORT_TASKS ||
        run.chunk_count + 1 > maxChunks ||
        run.captured_bytes + bytes > MAX_SHEETS_EXPORT_BYTES
      )
        throw new AppError(
          'validation_failed',
          'this export exceeds 20 mib, 99,989 task rows, or 9,999 bounded row chunks. choose a narrower scope before creating a spreadsheet.',
          422,
        );
      const priorCounts = {
          ...emptyCounts(),
          ...(JSON.parse(run.counts_json) as CsvExportPage['counts']),
        },
        counts = emptyCounts();
      for (const key of countNames) counts[key] = priorCounts[key] + page.counts[key];
      const priorFreshness = run.freshness_json
        ? (JSON.parse(run.freshness_json) as CsvExportPage['freshness'])
        : null;
      const freshness = {
        ...page.freshness,
        complete: page.freshness.complete && (priorFreshness?.complete ?? true),
        stale: page.freshness.stale || (priorFreshness?.stale ?? false),
        lastSyncedAt: priorFreshness
          ? priorFreshness.lastSyncedAt && page.freshness.lastSyncedAt
            ? [priorFreshness.lastSyncedAt, page.freshness.lastSyncedAt].sort()[0]!
            : null
          : page.freshness.lastSyncedAt,
      };
      const nonce = crypto.randomUUID(),
        inputHash = await hash(JSON.parse(payload)),
        captureHash = await hash([run.capture_hash, inputHash]);
      const state = page.nextCursor ? 'capturing' : 'ready';
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            `UPDATE transfer_sheets_exports SET nonce=?,revision=revision+1,state=?,cursor=?,capture_hash=?,generated_at=?,freshness_json=?,counts_json=?,row_count=?,chunk_count=chunk_count+1,captured_bytes=captured_bytes+?,updated_at=? WHERE id=? AND account_id=? AND state='capturing' AND revision=? AND cancel_requested=0`,
          )
          .bind(
            nonce,
            state,
            page.nextCursor,
            captureHash,
            page.generatedAt,
            JSON.stringify(freshness),
            JSON.stringify(counts),
            totalRows,
            bytes,
            this.now(),
            id,
            accountId,
            run.revision,
          ),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM transfer_sheets_exports WHERE id=? AND nonce=?)',
          )
          .bind(id, nonce),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_export_chunks(export_id,position,start_row,data_rows,row_count,rows_json,input_hash,byte_count) VALUES (?,?,?,?,?,?,?,?)',
          )
          .bind(
            id,
            run.chunk_count,
            run.row_count + 1,
            page.counts.tasks,
            page.rows.length,
            payload,
            inputHash,
            bytes,
          ),
      ]);
    } catch (error) {
      const current = await this.run(accountId, id);
      if (current.revision !== run.revision || current.state !== 'capturing')
        return this.get(accountId, id);
      if (error instanceof AppError && !error.retryable) {
        await this.db
          .prepare(
            "UPDATE transfer_sheets_exports SET state='failed',error_code=?,finished_at=?,updated_at=? WHERE id=? AND state='capturing' AND revision=?",
          )
          .bind(error.code, this.now(), this.now(), id, run.revision)
          .run();
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        'storage_unavailable',
        'the bounded export page could not be captured',
        503,
        true,
      );
    }
    return this.get(accountId, id);
  }

  async confirm(
    accountId: string,
    id: string,
    input: { captureHash: string },
  ): Promise<SheetsExportSummary> {
    const run = await this.run(accountId, id);
    if (!/^[0-9a-f]{64}$/.test(input.captureHash) || input.captureHash !== run.capture_hash)
      throw conflict('confirm the current captured export preview before creating its spreadsheet');
    const existing = await this.options.operations.get(id, accountId);
    if (run.confirmed_at !== null) {
      if (!existing) throw expired();
      return this.get(accountId, id);
    }
    if (run.state !== 'ready' || !run.chunk_count || run.cancel_requested)
      throw conflict('finish capturing this export before confirming its new spreadsheet');
    checkFreshId(id, this.now());
    await this.options.operations.admit(
      {
        id,
        accountId,
        ownerSubject: run.owner_subject,
        kind: 'sheets.export',
        resourceKey: 'sheets-export:' + id,
        input: { captureHash: run.capture_hash, requestHash: run.request_hash },
        steps: [
          {
            key: 'sheets.create',
            kind: 'sheets.create',
            input: {
              action: 'sheets.create',
              title: run.title,
              rowCount: run.row_count,
              columnCount: run.column_count,
            },
          },
        ],
        totalSteps: run.chunk_count + 1,
      },
      this.now(),
    );
    await this.db
      .prepare(
        "UPDATE transfer_sheets_exports SET state='admitted',confirmed_at=?,updated_at=? WHERE id=? AND account_id=? AND state='ready'",
      )
      .bind(this.now(), this.now(), id, accountId)
      .run();
    return this.get(accountId, id);
  }

  private async reconcile(accountId: string, id: string): Promise<void> {
    const operation = await this.options.operations.summary(id, accountId);
    if (!operation) return;
    const state = operation.finished
      ? operation.state === 'succeeded'
        ? 'finished'
        : operation.state === 'cancelled'
          ? 'cancelled'
          : 'failed'
      : operation.state === 'uncertain'
        ? 'uncertain'
        : ['reconnect_required', 'blocked_by_limit'].includes(operation.state)
          ? 'paused'
          : 'admitted';
    await this.db
      .prepare(
        'UPDATE transfer_sheets_exports SET state=?,next_attempt_at=?,error_code=?,finished_at=CASE WHEN ? THEN COALESCE(finished_at,?) ELSE finished_at END,updated_at=? WHERE id=? AND account_id=?',
      )
      .bind(
        state,
        operation.nextAttemptAt,
        operation.error?.code ?? null,
        operation.finished ? 1 : 0,
        this.now(),
        this.now(),
        id,
        accountId,
      )
      .run();
  }

  private async promote(run: Run): Promise<void> {
    const candidates = (
      await this.db
        .prepare(
          'SELECT position,byte_count FROM transfer_sheets_export_chunks WHERE export_id=? AND position>=? ORDER BY position LIMIT 10',
        )
        .bind(run.id, run.promoted_chunks)
        .all<{ position: number; byte_count: number }>()
    ).results;
    const positions: number[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      if (positions.length && bytes + candidate.byte_count > 64 * 1024) break;
      positions.push(candidate.position);
      bytes += candidate.byte_count;
    }
    if (!positions.length) {
      await this.options.operations.seal(run.id, run.account_id);
      return;
    }
    const chunks = (
      await this.db
        .prepare(
          'SELECT position,start_row,data_rows,row_count,rows_json,input_hash,byte_count FROM transfer_sheets_export_chunks WHERE export_id=? AND position IN(SELECT value FROM json_each(?)) ORDER BY position',
        )
        .bind(run.id, JSON.stringify(positions))
        .all<Chunk>()
    ).results;
    for (const chunk of chunks)
      if ((await hash(JSON.parse(chunk.rows_json))) !== chunk.input_hash)
        throw conflict('a frozen sheets export chunk changed');
    await this.options.operations.appendSteps(
      run.id,
      run.account_id,
      chunks.map((chunk) => ({
        key: 'rows:' + chunk.position,
        kind: 'sheets.rows',
        position: chunk.position + 1,
        input: JSON.parse(chunk.rows_json) as unknown,
      })),
    );
    await this.db
      .prepare(
        'UPDATE transfer_sheets_exports SET promoted_chunks=MAX(promoted_chunks,?),updated_at=? WHERE id=?',
      )
      .bind(positions.at(-1)! + 1, this.now(), run.id)
      .run();
    if (positions.at(-1)! + 1 === run.chunk_count)
      await this.options.operations.seal(run.id, run.account_id);
  }

  private async settle(run: Run, claim: ClaimedStep, response: unknown): Promise<void> {
    const parsed = stepSchema.safeParse(claim.input);
    if (!parsed.success) {
      await this.options.operations.pauseRepair(
        run.id,
        claim.key,
        claim.claimId!,
        { code: 'outcome_uncertain' },
        this.now(),
      );
      return;
    }
    const step = parsed.data;
    let writes: D1PreparedStatement[];
    if (step.action === 'sheets.create') {
      const receipt = createdSchema.safeParse(response);
      if (!receipt.success) {
        await this.options.operations.pauseRepair(
          run.id,
          claim.key,
          claim.claimId!,
          { code: 'outcome_uncertain' },
          this.now(),
        );
        return;
      }
      writes = [
        this.db
          .prepare(
            'UPDATE transfer_sheets_exports SET file_id=?,file_url=?,active_step=NULL,active_claim=NULL,active_until=NULL,unresolved=0,updated_at=? WHERE id=?',
          )
          .bind(receipt.data.id, receipt.data.url, this.now(), run.id),
      ];
      await this.options.operations.commitStep(
        run.id,
        claim.key,
        claim.claimId!,
        { id: receipt.data.id, url: receipt.data.url },
        writes,
        this.now(),
      );
    } else {
      const receipt = z
        .object({
          updatedRows: z.number().int(),
          updatedColumns: z.number().int(),
          updatedCells: z.number().int(),
        })
        .safeParse(response);
      if (
        !receipt.success ||
        receipt.data.updatedRows !== step.rows.length ||
        receipt.data.updatedColumns !== run.column_count ||
        receipt.data.updatedCells !== step.rows.length * run.column_count
      ) {
        await this.options.operations.pauseRepair(
          run.id,
          claim.key,
          claim.claimId!,
          { code: 'outcome_uncertain' },
          this.now(),
        );
        return;
      }
      writes = [
        this.db
          .prepare(
            'UPDATE transfer_sheets_export_chunks SET confirmed_at=? WHERE export_id=? AND position=?',
          )
          .bind(this.now(), run.id, step.position),
        this.db
          .prepare(
            'UPDATE transfer_sheets_exports SET confirmed_rows=confirmed_rows+?,active_step=NULL,active_claim=NULL,active_until=NULL,unresolved=0,updated_at=? WHERE id=?',
          )
          .bind(step.dataRows, this.now(), run.id),
      ];
      await this.options.operations.commitStep(
        run.id,
        claim.key,
        claim.claimId!,
        { spreadsheetId: run.file_id, position: step.position, confirmedRows: step.dataRows },
        writes,
        this.now(),
      );
    }
  }

  async advance(accountId: string, id: string): Promise<SheetsExportAdvance> {
    let run = await this.run(accountId, id);
    if (run.state === 'capturing')
      return { run: await this.captureNext(accountId, id), advanced: true };
    const operation = await this.options.operations.get(id, accountId);
    if (!operation) return { run: await this.get(accountId, id), advanced: false };
    if (operation.finished) {
      await this.reconcile(accountId, id);
      return { run: await this.get(accountId, id), advanced: false };
    }
    if (!operation.inputSealed) {
      await this.promote(run);
      return { run: await this.get(accountId, id), advanced: true };
    }
    const claimId = crypto.randomUUID(),
      claim = await this.options.operations.claimNext(id, claimId, this.now());
    if (!claim) {
      await this.reconcile(accountId, id);
      return { run: await this.get(accountId, id), advanced: false };
    }
    let dispatched = false,
      responseReceived = claim.mode === 'repair',
      recorded = claim.mode === 'repair',
      client: GoogleSheetsClient | undefined;
    try {
      if (claim.mode === 'repair') await this.settle(run, claim, claim.response);
      else {
        const step = stepSchema.safeParse(claim.input);
        if (!step.success)
          throw new AppError('validation_failed', 'this captured sheets step is invalid', 422);
        run = await this.run(accountId, id);
        if (step.data.action === 'sheets.rows' && !run.file_id)
          throw conflict(
            'the created spreadsheet receipt is missing; inspect this operation before continuing',
          );
        client = await this.options.clientFor(accountId);
        if (this.options.remainingProviderRequests && this.options.remainingProviderRequests() < 1)
          throw new AppError(
            'provider_rate_limited',
            'this bounded provider slice has no requests remaining',
            429,
            true,
          );
        await this.options.operations.markDispatched(id, claim.key, claimId, this.now(), [
          this.db
            .prepare(
              'UPDATE transfer_sheets_exports SET active_step=?,active_claim=?,active_until=?,unresolved=1 WHERE id=?',
            )
            .bind(claim.key, claimId, this.now() + 30000, id),
        ]);
        dispatched = true;
        const response =
          step.data.action === 'sheets.create'
            ? await client.createSpreadsheet({
                title: step.data.title,
                sheets: [
                  {
                    title: 'tasks',
                    rowCount: step.data.rowCount,
                    columnCount: step.data.columnCount,
                  },
                ],
              })
            : await client.writeRawRows(run.file_id!, 'tasks', step.data.startRow, step.data.rows);
        responseReceived = true;
        await this.options.operations.recordResponse(id, claim.key, claimId, response, this.now());
        recorded = true;
        await this.db
          .prepare(
            'UPDATE transfer_sheets_exports SET active_until=NULL WHERE id=? AND active_claim=?',
          )
          .bind(id, claimId)
          .run();
        await this.settle(run, claim, response);
      }
    } catch (error) {
      if (recorded)
        await this.options.operations.deferRepair(
          id,
          claim.key,
          claimId,
          { retryAt: this.now() + 5000, code: 'storage_unavailable' },
          this.now(),
        );
      else if (responseReceived)
        await this.options.operations.rejectStep(
          id,
          claim.key,
          claimId,
          { code: 'outcome_uncertain', definitelyRejected: false },
          this.now(),
        );
      else if (!dispatched) {
        const safe =
          error instanceof AppError
            ? error
            : new AppError(
                'provider_unavailable',
                'sheets authorization is unavailable',
                503,
                true,
              );
        await this.options.operations.releaseUndispatched(
          id,
          claim.key,
          claimId,
          {
            code: safe.code,
            ...(['permission_required', 'reconnect_required'].includes(safe.code)
              ? { state: 'reconnect_required' as const }
              : !safe.retryable
                ? { state: 'failed' as const }
                : { retryAt: this.now() + 5000 }),
          },
          this.now(),
        );
      } else {
        let safe: GoogleSheetsError | AppError =
          error instanceof GoogleSheetsError || error instanceof AppError
            ? error
            : new GoogleSheetsError('outcome_uncertain', { outcome: 'uncertain' });
        if (
          safe instanceof GoogleSheetsError &&
          safe.status === 401 &&
          client &&
          this.options.refreshRejectedToken
        ) {
          try {
            await this.options.refreshRejectedToken(accountId, client);
            safe = new AppError(
              'provider_unavailable',
              'the rejected token was refreshed; retry this step in the next slice',
              503,
              true,
            );
          } catch (refreshError) {
            safe =
              refreshError instanceof AppError
                ? refreshError
                : new AppError(
                    'reconnect_required',
                    'reconnect this account before continuing its sheets export',
                    409,
                  );
          }
        }
        const rejected = safe instanceof AppError || safe.outcome === 'rejected';
        await this.options.operations.rejectStep(
          id,
          claim.key,
          claimId,
          {
            code: safe.code,
            definitelyRejected: rejected,
            ...(rejected
              ? ['permission_required', 'reconnect_required'].includes(safe.code)
                ? { operationState: 'reconnect_required' as const }
                : safe.retryable
                  ? {
                      retryAt:
                        this.now() +
                        Math.max(
                          1000,
                          safe instanceof GoogleSheetsError
                            ? (safe.retryAfterSeconds ?? 5) * 1000
                            : 1000,
                        ),
                    }
                  : { operationState: 'failed' as const }
              : {}),
          },
          this.now(),
        );
      }
      await this.db
        .prepare(
          'UPDATE transfer_sheets_exports SET active_step=NULL,active_claim=NULL,active_until=NULL,unresolved=? WHERE id=?',
        )
        .bind(
          responseReceived ||
            (dispatched &&
              !(error instanceof AppError) &&
              (!(error instanceof GoogleSheetsError) || error.outcome === 'uncertain'))
            ? 1
            : 0,
          id,
        )
        .run();
    }
    await this.reconcile(accountId, id);
    return { run: await this.get(accountId, id), advanced: true };
  }

  async cancel(accountId: string, id: string): Promise<SheetsExportSummary> {
    const run = await this.run(accountId, id),
      operation = await this.options.operations.get(id, accountId);
    if (operation) {
      await this.options.operations.cancel(id, accountId, this.now());
      await this.reconcile(accountId, id);
    } else
      await this.db
        .prepare(
          "UPDATE transfer_sheets_exports SET state='cancelled',cancel_requested=1,finished_at=?,updated_at=? WHERE id=? AND finished_at IS NULL",
        )
        .bind(this.now(), this.now(), id)
        .run();
    if (!run.cancel_requested)
      await this.db
        .prepare('UPDATE transfer_sheets_exports SET cancel_requested=1 WHERE id=?')
        .bind(id)
        .run();
    return this.get(accountId, id);
  }
  async resume(accountId: string, id: string): Promise<SheetsExportSummary> {
    await this.run(accountId, id);
    await this.options.operations.resume(id, accountId, this.now());
    await this.reconcile(accountId, id);
    return this.get(accountId, id);
  }
  async inspectUncertain(accountId: string, id: string, stepKey: string) {
    return this.resolutions.inspect(accountId, id, stepKey);
  }
  async startVerification(accountId: string, id: string, input: StartSheetsVerification) {
    return this.resolutions.start(accountId, id, input);
  }
  async advanceVerification(accountId: string, id: string, verificationId: string) {
    return this.resolutions.advance(accountId, id, verificationId);
  }
  async adoptVerified(
    accountId: string,
    id: string,
    input: AdoptSheetsVerification,
  ): Promise<SheetsExportSummary> {
    await this.resolutions.adopt(accountId, id, input);
    return (await this.advance(accountId, id)).run;
  }
  async resumeRecordedResponse(
    accountId: string,
    id: string,
    stepKey: string,
  ): Promise<SheetsExportSummary> {
    await this.run(accountId, id);
    await this.options.operations.resumeRecordedResponse(id, stepKey, accountId, this.now());
    return (await this.advance(accountId, id)).run;
  }
  async startFreshAttempt(
    accountId: string,
    id: string,
    input: {
      newOperationId: string;
      stepKey: string;
      expectedClaimId: string;
      confirmDuplicateRisk: true;
    },
  ): Promise<SheetsExportSummary> {
    const value = FreshSheetsAttemptSchema.safeParse(input);
    if (!value.success)
      throw new AppError(
        'validation_failed',
        'explicitly acknowledge possible duplicate output and provide a new operation identity',
        422,
      );
    const source = await this.run(accountId, id);
    if (value.data.newOperationId === id)
      throw conflict('a fresh attempt needs a distinct operation identity');
    const prior = await this.db
      .prepare(
        'SELECT original_export_id,original_step_key,original_claim_id FROM transfer_sheets_fresh_attempts WHERE new_export_id=? AND account_id=?',
      )
      .bind(value.data.newOperationId, accountId)
      .first<{
        original_export_id: string;
        original_step_key: string;
        original_claim_id: string;
      }>();
    if (prior) {
      if (
        prior.original_export_id !== id ||
        prior.original_step_key !== input.stepKey ||
        prior.original_claim_id !== input.expectedClaimId
      )
        throw conflict();
      return this.get(accountId, input.newOperationId);
    }
    const inspected = await this.resolutions.inspect(accountId, id, value.data.stepKey);
    if (inspected.expectedClaimId !== input.expectedClaimId) throw conflict();
    checkFreshId(value.data.newOperationId, this.now());
    await assertLocalWritable(this.db, accountId);
    const request = beginSchema.parse({
      ...(JSON.parse(source.request_json) as BeginSheetsExport),
      operationId: value.data.newOperationId,
    });
    const requestJson = JSON.stringify(canonical(request)),
      requestHash = await hash(request),
      nonce = crypto.randomUUID();
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM transfer_sheets_exports WHERE id=? AND account_id=? AND capture_hash=? AND unresolved=1)',
          )
          .bind(id, accountId, source.capture_hash),
        this.db
          .prepare(
            `INSERT INTO transfer_sheets_exports(id,account_id,owner_subject,request_json,request_hash,title,state,capture_hash,nonce,created_at,updated_at) VALUES (?,?,?,?,?,?,'capturing',?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            value.data.newOperationId,
            accountId,
            source.owner_subject,
            requestJson,
            requestHash,
            source.title,
            requestHash,
            nonce,
            this.now(),
            this.now(),
          ),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM transfer_sheets_exports WHERE id=? AND nonce=?)',
          )
          .bind(value.data.newOperationId, nonce),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_fresh_attempts(new_export_id,original_export_id,account_id,original_step_key,original_claim_id,original_capture_hash,created_at) VALUES (?,?,?,?,?,?,?)',
          )
          .bind(
            value.data.newOperationId,
            id,
            accountId,
            input.stepKey,
            input.expectedClaimId,
            source.capture_hash,
            this.now(),
          ),
      ]);
    } catch {
      const replay = await this.db
        .prepare(
          'SELECT original_export_id,original_step_key,original_claim_id FROM transfer_sheets_fresh_attempts WHERE new_export_id=? AND account_id=?',
        )
        .bind(value.data.newOperationId, accountId)
        .first<{
          original_export_id: string;
          original_step_key: string;
          original_claim_id: string;
        }>();
      if (
        !replay ||
        replay.original_export_id !== id ||
        replay.original_step_key !== input.stepKey ||
        replay.original_claim_id !== input.expectedClaimId
      )
        throw conflict();
    }
    return this.get(accountId, value.data.newOperationId);
  }
  private async cloneNext(
    run: Run,
    link: { original_export_id: string; original_capture_hash: string; cloned_chunks: number },
  ): Promise<SheetsExportSummary> {
    checkFreshId(run.id, this.now());
    const source = await this.run(run.account_id, link.original_export_id);
    if (source.capture_hash !== link.original_capture_hash)
      throw conflict('the original frozen export changed');
    const chunk = await this.db
      .prepare(
        'SELECT position,start_row,data_rows,row_count,rows_json,input_hash,byte_count FROM transfer_sheets_export_chunks WHERE export_id=? AND position=?',
      )
      .bind(source.id, link.cloned_chunks)
      .first<Chunk>();
    if (
      !chunk ||
      chunk.rows_json === 'null' ||
      (await hash(JSON.parse(chunk.rows_json))) !== chunk.input_hash
    )
      throw conflict('the original frozen export payload is no longer available');
    const nonce = crypto.randomUUID(),
      ready = chunk.position + 1 === source.chunk_count;
    try {
      await this.db.batch([
        localWriteGuard(this.db, run.account_id),
        this.db
          .prepare(
            `UPDATE transfer_sheets_exports SET nonce=?,revision=revision+1,state=?,capture_hash=?,generated_at=?,freshness_json=?,counts_json=?,row_count=row_count+?,chunk_count=chunk_count+1,captured_bytes=captured_bytes+?,updated_at=? WHERE id=? AND revision=? AND state='capturing' AND cancel_requested=0`,
          )
          .bind(
            nonce,
            ready ? 'ready' : 'capturing',
            await hash([run.capture_hash, chunk.input_hash]),
            source.generated_at,
            source.freshness_json,
            ready
              ? source.counts_json
              : JSON.stringify({ ...emptyCounts(), tasks: run.row_count + chunk.row_count - 1 }),
            chunk.row_count,
            chunk.byte_count,
            this.now(),
            run.id,
            run.revision,
          ),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM transfer_sheets_exports WHERE id=? AND nonce=?)',
          )
          .bind(run.id, nonce),
        this.db
          .prepare(
            'INSERT INTO transfer_sheets_export_chunks(export_id,position,start_row,data_rows,row_count,rows_json,input_hash,byte_count) VALUES (?,?,?,?,?,?,?,?)',
          )
          .bind(
            run.id,
            chunk.position,
            chunk.start_row,
            chunk.data_rows,
            chunk.row_count,
            chunk.rows_json,
            chunk.input_hash,
            chunk.byte_count,
          ),
        this.db
          .prepare(
            'UPDATE transfer_sheets_fresh_attempts SET cloned_chunks=? WHERE new_export_id=? AND cloned_chunks=?',
          )
          .bind(chunk.position + 1, run.id, chunk.position),
      ]);
    } catch {
      if ((await this.run(run.account_id, run.id)).revision === run.revision)
        throw conflict('the frozen export could not be copied into this fresh attempt');
    }
    return this.get(run.account_id, run.id);
  }
  async advanceNext(): Promise<SheetsExportAdvance | null> {
    const row = await this.db
      .prepare(
        "SELECT id,account_id FROM transfer_sheets_exports WHERE state IN ('capturing','admitted') AND cancel_requested=0 AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at,id LIMIT 1",
      )
      .bind(this.now())
      .first<{ id: string; account_id: string }>();
    if (!row) return null;
    await this.db
      .prepare('UPDATE transfer_sheets_exports SET updated_at=? WHERE id=?')
      .bind(this.now(), row.id)
      .run();
    return this.advance(row.account_id, row.id);
  }

  async hasUnresolved(accountId: string): Promise<boolean> {
    return (
      (await this.db
        .prepare(
          'SELECT 1 AS found FROM transfer_sheets_exports WHERE account_id=? AND unresolved=1 LIMIT 1',
        )
        .bind(accountId)
        .first()) !== null
    );
  }
  async pendingProviderWork(accountId: string): Promise<boolean> {
    const rows = (
      await this.db
        .prepare(
          'SELECT id,active_step FROM transfer_sheets_exports WHERE account_id=? AND active_step IS NOT NULL AND active_until<=? ORDER BY active_until LIMIT 1',
        )
        .bind(accountId, this.now())
        .all<{ id: string; active_step: string }>()
    ).results;
    for (const row of rows) {
      await this.advance(accountId, row.id);
      const step = await this.options.operations.getStep(row.id, row.active_step);
      if (step?.state === 'uncertain' || step?.state === 'confirmed' || step?.state === 'cancelled')
        await this.db
          .prepare(
            'UPDATE transfer_sheets_exports SET active_step=NULL,active_claim=NULL,active_until=NULL WHERE id=?',
          )
          .bind(row.id)
          .run();
    }
    const known = (
      await this.db
        .prepare(
          "SELECT id,file_id FROM transfer_sheets_exports WHERE account_id=? AND unresolved=1 AND state IN('admitted','paused') AND active_until IS NULL ORDER BY updated_at,id LIMIT 1",
        )
        .bind(accountId)
        .all<{ id: string; file_id: string | null }>()
    ).results;
    for (const row of known) {
      const chunk = row.file_id
        ? await this.db
            .prepare(
              'SELECT position FROM transfer_sheets_export_chunks WHERE export_id=? AND confirmed_at IS NULL ORDER BY position LIMIT 1',
            )
            .bind(row.id)
            .first<{ position: number }>()
        : null;
      const key = row.file_id ? (chunk ? 'rows:' + chunk.position : null) : 'sheets.create';
      const step = key ? await this.options.operations.getStep(row.id, key) : null;
      if (step?.state === 'uncertain') await this.reconcile(accountId, row.id);
      if (
        key &&
        step?.response !== null &&
        step?.response !== undefined &&
        step.state === 'dispatched'
      ) {
        if ((step.claimUntil ?? 0) > this.now()) return true;
        const operation = await this.options.operations.summary(row.id, accountId);
        if ((operation?.nextAttemptAt ?? 0) <= this.now()) await this.advance(accountId, row.id);
        const after = await this.options.operations.getStep(row.id, key);
        if (
          after?.response !== null &&
          after?.response !== undefined &&
          after.state === 'dispatched'
        ) {
          try {
            await this.options.operations.deferDisconnectRepair(
              row.id,
              accountId,
              'storage_unavailable',
              this.now(),
            );
            await this.reconcile(accountId, row.id);
          } catch (error) {
            if (error instanceof AppError && error.code === 'conflict') return true;
            throw error;
          }
        }
      }
    }
    return (
      (await this.db
        .prepare(
          "SELECT 1 AS pending FROM transfer_sheets_exports WHERE account_id=? AND ((active_step IS NOT NULL AND active_until IS NOT NULL) OR(unresolved=1 AND state IN('admitted','paused') AND active_until IS NULL)) LIMIT 1",
        )
        .bind(accountId)
        .first()) !== null
    );
  }
  async pauseAccount(accountId: string, limit = 100): Promise<{ done: boolean; pending: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'pause at most100 sheets exports', 422);
    const rows = (
      await this.db
        .prepare(
          'SELECT id FROM transfer_sheets_exports WHERE account_id=? AND cancel_requested=0 AND finished_at IS NULL ORDER BY updated_at,id LIMIT ?',
        )
        .bind(accountId, Math.min(2, limit))
        .all<{ id: string }>()
    ).results;
    for (const row of rows) await this.cancel(accountId, row.id);
    await this.db
      .prepare(
        "UPDATE transfer_sheets_verifications SET status='cancelled',updated_at=? WHERE id IN(SELECT id FROM transfer_sheets_verifications WHERE account_id=? AND status='verifying' ORDER BY id LIMIT ?)",
      )
      .bind(this.now(), accountId, limit)
      .run();
    const pending = await this.pendingProviderWork(accountId);
    return {
      done:
        (await this.db
          .prepare(
            "SELECT 1 FROM transfer_sheets_exports WHERE account_id=? AND cancel_requested=0 AND finished_at IS NULL UNION ALL SELECT 1 FROM transfer_sheets_verifications WHERE account_id=? AND status='verifying' LIMIT 1",
          )
          .bind(accountId, accountId)
          .first()) === null,
      pending,
    };
  }
  async removeAccountSlice(
    accountId: string,
    limit = 100,
  ): Promise<{ done: boolean; deleted: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'remove at most100 sheets staging rows', 422);
    await assertDisconnecting(this.db, accountId);
    if (await this.pendingProviderWork(accountId))
      throw conflict('issued sheets requests must settle before local export data is removed');
    let deleted = (
      await this.db
        .prepare(
          'DELETE FROM transfer_sheets_fresh_attempts WHERE new_export_id IN(SELECT new_export_id FROM transfer_sheets_fresh_attempts WHERE account_id=? ORDER BY new_export_id LIMIT ?)',
        )
        .bind(accountId, limit)
        .run()
    ).meta.changes;
    if (deleted < limit)
      deleted += (
        await this.db
          .prepare(
            'DELETE FROM transfer_sheets_verifications WHERE id IN(SELECT id FROM transfer_sheets_verifications WHERE account_id=? ORDER BY id LIMIT ?)',
          )
          .bind(accountId, limit - deleted)
          .run()
      ).meta.changes;
    if (deleted < limit)
      deleted += (
        await this.db
          .prepare(
            'DELETE FROM transfer_sheets_export_chunks WHERE (export_id,position) IN(SELECT c.export_id,c.position FROM transfer_sheets_export_chunks c JOIN transfer_sheets_exports e ON e.id=c.export_id WHERE e.account_id=? ORDER BY c.export_id,c.position LIMIT ?)',
          )
          .bind(accountId, limit - deleted)
          .run()
      ).meta.changes;
    const remaining = limit - deleted;
    const parents = remaining
      ? await this.db
          .prepare(
            'DELETE FROM transfer_sheets_exports WHERE id IN(SELECT e.id FROM transfer_sheets_exports e WHERE e.account_id=? AND NOT EXISTS(SELECT 1 FROM transfer_sheets_export_chunks c WHERE c.export_id=e.id) ORDER BY e.id LIMIT ?)',
          )
          .bind(accountId, remaining)
          .run()
      : null;
    return {
      done:
        (await this.db
          .prepare('SELECT 1 FROM transfer_sheets_exports WHERE account_id=? LIMIT 1')
          .bind(accountId)
          .first()) === null,
      deleted: deleted + (parents?.meta.changes ?? 0),
    };
  }
  async cleanup(limit = 100, now = this.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'clean at most100 sheets export rows', 422);
    const expiredCaptures = await this.db
      .prepare(
        `UPDATE transfer_sheets_exports SET state='failed',error_code='conflict',finished_at=CAST(substr(id,1,13) AS INTEGER)+86400000,updated_at=? WHERE id IN(SELECT id FROM transfer_sheets_exports WHERE confirmed_at IS NULL AND state IN('capturing','ready') AND CAST(substr(id,1,13) AS INTEGER)<=? ORDER BY created_at,id LIMIT ?)`,
      )
      .bind(now, now - 86400000, limit)
      .run();
    let changed = expiredCaptures.meta.changes;
    if (changed < limit) {
      const pruned = await this.db
        .prepare(
          `UPDATE transfer_sheets_export_chunks SET rows_json='null',payload_pruned_at=? WHERE (export_id,position) IN(SELECT c.export_id,c.position FROM transfer_sheets_export_chunks c JOIN transfer_sheets_exports e ON e.id=c.export_id WHERE e.finished_at<=? AND c.payload_pruned_at IS NULL ORDER BY e.finished_at,c.export_id,c.position LIMIT ?)`,
        )
        .bind(now, now - 86400000, limit - changed)
        .run();
      changed += pruned.meta.changes;
    }
    if (changed < limit) {
      const removed = await this.db
        .prepare(
          'DELETE FROM transfer_sheets_export_chunks WHERE (export_id,position) IN(SELECT c.export_id,c.position FROM transfer_sheets_export_chunks c JOIN transfer_sheets_exports e ON e.id=c.export_id WHERE e.finished_at<=? ORDER BY e.finished_at,c.export_id,c.position LIMIT ?)',
        )
        .bind(now - 90 * 86400000, limit - changed)
        .run();
      changed += removed.meta.changes;
    }
    if (changed < limit) {
      const removed = await this.db
        .prepare(
          'DELETE FROM transfer_sheets_verifications WHERE id IN(SELECT v.id FROM transfer_sheets_verifications v JOIN transfer_sheets_exports e ON e.id=v.export_id WHERE e.finished_at<=? ORDER BY e.finished_at,v.id LIMIT ?)',
        )
        .bind(now - 90 * 86400000, limit - changed)
        .run();
      changed += removed.meta.changes;
    }
    if (changed < limit) {
      const removed = await this.db
        .prepare(
          'DELETE FROM transfer_sheets_fresh_attempts WHERE new_export_id IN(SELECT f.new_export_id FROM transfer_sheets_fresh_attempts f JOIN transfer_sheets_exports e ON e.id=f.new_export_id WHERE e.finished_at<=? ORDER BY e.finished_at,f.new_export_id LIMIT ?)',
        )
        .bind(now - 90 * 86400000, limit - changed)
        .run();
      changed += removed.meta.changes;
    }
    if (changed < limit) {
      const removed = await this.db
        .prepare(
          'DELETE FROM transfer_sheets_exports WHERE id IN(SELECT e.id FROM transfer_sheets_exports e WHERE e.finished_at<=? AND NOT EXISTS(SELECT 1 FROM transfer_sheets_export_chunks c WHERE c.export_id=e.id) AND NOT EXISTS(SELECT 1 FROM transfer_sheets_verifications v WHERE v.export_id=e.id) AND NOT EXISTS(SELECT 1 FROM transfer_sheets_fresh_attempts f WHERE f.original_export_id=e.id OR f.new_export_id=e.id) ORDER BY e.finished_at,e.id LIMIT ?)',
        )
        .bind(now - 90 * 86400000, limit - changed)
        .run();
      changed += removed.meta.changes;
    }
    return changed;
  }
}
