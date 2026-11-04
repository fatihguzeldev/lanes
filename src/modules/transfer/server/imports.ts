import { canonicalJson, transferDigest } from './content-hash';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../shared/contracts/errors';
import { assertLocalWritable, localWriteGuard } from '../../accounts/server/connections/access';
import type { TaskCommandService } from '../../tasks/server/commands/service';
import type { OperationStore } from '../../operations/server/journal/store';
import type {
  BeginCapturedCopy,
  CopyEntry,
  CopyListDefinition,
} from '../../tasks/server/commands/copy-contract';
import { type NormalizedImportTask } from '../parse-contract';
import { ImportValidator } from './import-validation';
import {
  BeginImportSchema,
  ConfirmImportSchema,
  DEFAULT_IMPORTED_LABEL_COLOR,
  ImportChunkSchema,
  type BeginImport,
  type ImportChunk,
  type ImportManifest,
  type ImportSummary,
} from '../server-contract';
interface Header {
  id: string;
  account_id: string;
  owner_subject: string;
  manifest_json: string;
  manifest_hash: string;
  state: ImportSummary['state'];
  preview_hash: string | null;
  operation_id: string | null;
  capture_list_position: number;
  capture_task_position: number;
  revision: number;
  created_at: number;
  updated_at: number;
  paused: number;
  error_code: string | null;
  summary_cache_json: string | null;
  payload_pruned_at: number | null;
  validation_revision: number | null;
  validation_records: number;
  hash_position: number;
  hash_chain: string;
  graph_remaining: number;
}
interface RecordRow {
  kind: 'list' | 'task' | 'issue';
  item_key: string;
  position: number;
  copy_position: number | null;
  input_json: string;
  input_hash: string;
  label_definitions_json: string | null;
}
export interface ImportServiceOptions {
  commands?: TaskCommandService;
  operations?: OperationStore;
  now?: () => number;
  prepareSourceCaptureGuards?: (manifest: ImportManifest) => Promise<D1PreparedStatement[]>;
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the normalized import fields.',
      422,
      false,
      Object.fromEntries(
        result.error.issues
          .slice(0, 20)
          .map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return result.data;
}
function bounded(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
    throw new AppError('validation_failed', 'capture at most 64 kib in one normalized chunk.', 413);
}
const conflict = (
  message = 'this captured import changed. refresh its preview before continuing.',
) => new AppError('conflict', message, 409);
/** Staging is immutable; all provider writes remain in the task owner's copy journal. */
export class TransferImportService {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: ImportServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }
  private guard(condition: string, bindings: unknown[]) {
    return this.db
      .prepare(`INSERT INTO transfer_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
      .bind(...bindings);
  }
  private async header(id: string, accountId: string): Promise<Header> {
    const row = await this.db
      .prepare('SELECT * FROM transfer_imports WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first<Header>();
    if (!row)
      throw new AppError('not_found', 'this import is not available in the selected account.', 404);
    return row;
  }
  async begin(input: BeginImport): Promise<ImportSummary> {
    bounded(input);
    const manifest = parse(BeginImportSchema, input);
    bounded(manifest);
    const json = canonicalJson(manifest),
      hash = await transferDigest(json);
    const prior = await this.db
      .prepare('SELECT * FROM transfer_imports WHERE id=?')
      .bind(manifest.id)
      .first<Header>();
    if (prior) {
      if (
        prior.account_id !== manifest.accountId ||
        prior.owner_subject !== manifest.ownerSubject ||
        prior.manifest_hash !== hash
      )
        throw conflict(
          'this import identity already belongs to another source, destination or plan.',
        );
      return this.get(manifest.id, manifest.accountId);
    }
    const issued = Number(manifest.id.slice(0, 13));
    if (issued > this.now() + 300000 || this.now() - issued > 86400000)
      throw conflict('this unrecorded import identity has expired.');
    await assertLocalWritable(this.db, manifest.accountId);
    await this.db.batch([
      localWriteGuard(this.db, manifest.accountId),
      this.db
        .prepare(
          "INSERT INTO transfer_imports(id,account_id,owner_subject,manifest_json,manifest_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'staging',?,?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(
          manifest.id,
          manifest.accountId,
          manifest.ownerSubject,
          json,
          hash,
          this.now(),
          this.now(),
        ),
    ]);
    const saved = await this.header(manifest.id, manifest.accountId);
    if (saved.manifest_hash !== hash || saved.owner_subject !== manifest.ownerSubject)
      throw conflict();
    return this.get(manifest.id, manifest.accountId);
  }
  async append(id: string, accountId: string, input: ImportChunk): Promise<ImportSummary> {
    bounded(input);
    const chunk = parse(ImportChunkSchema, input);
    bounded(chunk);
    const header = await this.header(id, accountId),
      manifest = JSON.parse(header.manifest_json) as ImportManifest;
    await assertLocalWritable(this.db, accountId);
    const records = await Promise.all(
      (['lists', 'tasks', 'issues'] as const).flatMap((kind) =>
        chunk[kind].map(
          async (row) =>
            ({
              kind: kind === 'lists' ? 'list' : kind === 'tasks' ? 'task' : 'issue',
              key: kind === 'issues' ? 'issue:' + row.position : (row.value as { key: string }).key,
              position: row.position,
              json: canonicalJson(row.value),
              hash: await transferDigest(canonicalJson({ ...row })),
              labelDefinitions:
                'labelDefinitions' in row ? JSON.stringify(row.labelDefinitions ?? null) : null,
            }) as const,
        ),
      ),
    );
    const counts = {
      list: manifest.totalLists,
      task: manifest.totalTasks,
      issue: manifest.issueCount ?? 10000,
    };
    if (records.some((row) => row.position >= counts[row.kind]))
      throw new AppError(
        'validation_failed',
        'one record position is outside the declared complete selection.',
        422,
      );
    if (
      new Set(records.map((row) => row.kind + ':' + row.position)).size !== records.length ||
      new Set(records.map((row) => row.kind + ':' + row.key)).size !== records.length
    )
      throw new AppError('validation_failed', 'use every input-local key and position once.', 422);
    const existing = (
      await this.db
        .prepare(
          "SELECT kind,item_key,input_hash FROM transfer_import_records WHERE import_id=? AND (kind||':'||item_key) IN(SELECT value FROM json_each(?))",
        )
        .bind(id, JSON.stringify(records.map((row) => row.kind + ':' + row.key)))
        .all<RecordRow>()
    ).results;
    for (const row of records) {
      const old = existing.find((old) => old.kind === row.kind && old.item_key === row.key);
      if (old && old.input_hash !== row.hash)
        throw conflict('a source key already has different captured fields.');
    }
    const additions = records.filter(
      (row) => !existing.some((old) => old.kind === row.kind && old.item_key === row.key),
    );
    if (!additions.length) return this.get(id, accountId);
    if (header.state !== 'staging' || header.validation_revision !== null)
      throw conflict(
        'this preview has already been frozen. start a new import to use changed input.',
      );
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.guard(
          "EXISTS(SELECT 1 FROM transfer_imports WHERE id=? AND account_id=? AND state='staging' AND validation_revision IS NULL)",
          [id, accountId],
        ),
        ...additions.map((row) =>
          this.db
            .prepare(
              'INSERT INTO transfer_import_records(import_id,kind,item_key,position,input_json,input_hash,label_definitions_json) VALUES(?,?,?,?,?,?,?)',
            )
            .bind(id, row.kind, row.key, row.position, row.json, row.hash, row.labelDefinitions),
        ),
        this.db
          .prepare(
            `UPDATE transfer_imports SET revision=revision+1,summary_cache_json=json_set(COALESCE(summary_cache_json,'{}'),'$.lists',COALESCE(json_extract(summary_cache_json,'$.lists'),0)+?,'$.tasks',COALESCE(json_extract(summary_cache_json,'$.tasks'),0)+?,'$.issues',COALESCE(json_extract(summary_cache_json,'$.issues'),0)+?,'$.warnings',COALESCE(json_extract(summary_cache_json,'$.warnings'),0)+?,'$.errors',COALESCE(json_extract(summary_cache_json,'$.errors'),0)+?,'$.completed',COALESCE(json_extract(summary_cache_json,'$.completed'),0)+?,'$.subtasks',COALESCE(json_extract(summary_cache_json,'$.subtasks'),0)+?,'$.repeating',COALESCE(json_extract(summary_cache_json,'$.repeating'),0)+?),updated_at=? WHERE id=?`,
          )
          .bind(
            ...(['list', 'task', 'issue'] as const).map(
              (kind) => additions.filter((row) => row.kind === kind).length,
            ),
            additions.filter(
              (row) => row.kind === 'issue' && JSON.parse(row.json).severity === 'warning',
            ).length,
            additions.filter(
              (row) => row.kind === 'issue' && JSON.parse(row.json).severity === 'error',
            ).length,
            additions.filter((row) => row.kind === 'task' && JSON.parse(row.json).completed).length,
            additions.filter(
              (row) => row.kind === 'task' && JSON.parse(row.json).parentKey !== null,
            ).length,
            additions.filter(
              (row) => row.kind === 'task' && JSON.parse(row.json).repeatRule !== null,
            ).length,
            this.now(),
            id,
          ),
      ]);
    } catch {
      const replay = (
        await this.db
          .prepare(
            "SELECT kind,item_key,input_hash FROM transfer_import_records WHERE import_id=? AND (kind||':'||item_key) IN(SELECT value FROM json_each(?))",
          )
          .bind(id, JSON.stringify(records.map((row) => row.kind + ':' + row.key)))
          .all<RecordRow>()
      ).results;
      if (
        !records.every((row) =>
          replay.some(
            (old) =>
              old.kind === row.kind && old.item_key === row.key && old.input_hash === row.hash,
          ),
        )
      )
        throw conflict();
    }
    return this.get(id, accountId);
  }
  async list(
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<{
    items: ImportSummary[];
    nextCursor: string | null;
    coverage: { complete: true; lastSyncedAt: null; stale: false };
  }> {
    const limit = parse(z.number().int().min(1).max(10), input.limit ?? 10);
    let after: { accountId: string; createdAt: number; id: string } | null = null;
    if (input.cursor) {
      try {
        after = z
          .object({ accountId: z.string(), createdAt: z.number().int(), id: z.string() })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (after.accountId !== accountId) throw Error();
      } catch {
        throw new AppError(
          'validation_failed',
          'this import collection cursor belongs to another account.',
          422,
        );
      }
    }
    const rows = (
      await this.db
        .prepare(
          `SELECT id,created_at FROM transfer_imports WHERE account_id=? ${after ? 'AND(created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .bind(accountId, ...(after ? [after.createdAt, after.id] : []), limit + 1)
        .all<{ id: string; created_at: number }>()
    ).results;
    const items: ImportSummary[] = [];
    for (const row of rows) {
      if (items.length >= limit) break;
      const summary = await this.get(row.id, accountId);
      if (
        items.length &&
        new TextEncoder().encode(JSON.stringify([...items, summary])).byteLength > 64000
      )
        break;
      items.push(summary);
    }
    const last = rows[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > items.length && last
          ? btoa(JSON.stringify({ accountId, createdAt: last.created_at, id: last.id }))
          : null,
      coverage: { complete: true, lastSyncedAt: null, stale: false },
    };
  }
  async get(id: string, accountId: string): Promise<ImportSummary> {
    const header = await this.header(id, accountId),
      manifest = JSON.parse(header.manifest_json) as ImportManifest;
    const counts = header.summary_cache_json
      ? (JSON.parse(header.summary_cache_json) as Record<string, number>)
      : await this.db
          .prepare(
            `SELECT COALESCE(SUM(kind='list'),0) AS lists,COALESCE(SUM(kind='task'),0) AS tasks,COALESCE(SUM(kind='issue'),0) AS issues,COALESCE(SUM(kind='issue' AND json_extract(input_json,'$.severity')='warning'),0) AS warnings,COALESCE(SUM(kind='issue' AND json_extract(input_json,'$.severity')='error'),0) AS errors,COALESCE(SUM(kind='task' AND json_extract(input_json,'$.completed')=1),0) AS completed,COALESCE(SUM(kind='task' AND json_extract(input_json,'$.parentKey') IS NOT NULL),0) AS subtasks,COALESCE(SUM(kind='task' AND json_extract(input_json,'$.repeatRule') IS NOT NULL),0) AS repeating FROM transfer_import_records WHERE import_id=?`,
          )
          .bind(id)
          .first<Record<string, number>>();
    return {
      validation:
        header.validation_revision === null
          ? null
          : {
              checkedRecords: header.hash_position + 1,
              totalRecords: header.validation_records,
              remainingGraphNodes: header.graph_remaining,
            },
      paused: !!header.paused,
      pauseReason: header.error_code,
      id,
      accountId,
      state: header.state,
      revision: header.revision,
      source: manifest.source,
      destination: manifest.destination,
      totalLists: manifest.totalLists,
      totalTasks: manifest.totalTasks,
      capturedLists: counts?.lists ?? 0,
      capturedTasks: counts?.tasks ?? 0,
      capturedIssues: counts?.issues ?? 0,
      warningCount: counts?.warnings ?? 0,
      errorCount: counts?.errors ?? 0,
      completedCount: counts?.completed ?? 0,
      subtaskCount: counts?.subtasks ?? 0,
      repeatingCount: counts?.repeating ?? 0,
      requiredListSlots: manifest.destination.kind === 'new' ? manifest.totalLists : 0,
      skippedBlankRows: manifest.skippedBlankRows,
      skippedCompletedTasks: manifest.skippedCompletedTasks,
      parentContextCount: manifest.parentContextCount,
      previewHash: header.preview_hash,
      operationId: header.operation_id,
      createdAt: new Date(header.created_at).toISOString(),
      freshnessNote:
        manifest.source.kind === 'account'
          ? 'captured retained source projection; revisions are checked while capturing.'
          : 'captured selected values; later source edits do not change this run.',
    };
  }
  async readPreviewRecords(
    id: string,
    accountId: string,
    input: { kind: 'list' | 'task' | 'issue'; limit?: number; cursor?: number },
  ): Promise<{
    items: { position: number; value: unknown; payloadRetained: boolean }[];
    nextCursor: number | null;
  }> {
    await this.header(id, accountId);
    const kind = parse(z.enum(['list', 'task', 'issue']), input.kind),
      limit = parse(z.number().int().min(1).max(10), input.limit ?? 10),
      cursor = parse(z.number().int().min(-1).max(10000), input.cursor ?? -1);
    const rows = (
      await this.db
        .prepare(
          'SELECT position,input_json,label_definitions_json FROM transfer_import_records WHERE import_id=? AND kind=? AND position>? ORDER BY position LIMIT ?',
        )
        .bind(id, kind, cursor, limit + 1)
        .all<RecordRow>()
    ).results;
    const selected: typeof rows = [];
    for (const row of rows) {
      if (
        selected.length >= limit ||
        (selected.length &&
          new TextEncoder().encode(JSON.stringify([...selected, row])).byteLength > 64000)
      )
        break;
      selected.push(row);
    }
    return {
      items: selected.map((row) => ({
        position: row.position,
        value:
          row.input_json === '{}' ||
          ((JSON.parse(row.input_json) as Record<string, unknown>).title === undefined &&
            kind === 'task')
            ? null
            : (JSON.parse(row.input_json) as unknown),
        payloadRetained:
          row.input_json !== '{}' &&
          (kind !== 'task' ||
            (JSON.parse(row.input_json) as Record<string, unknown>).title !== undefined),
        ...(row.label_definitions_json && row.label_definitions_json !== 'null'
          ? { labelDefinitions: JSON.parse(row.label_definitions_json) as unknown }
          : {}),
      })),
      nextCursor: rows.length > selected.length ? (selected.at(-1)?.position ?? null) : null,
    };
  }
  async sealPreview(
    id: string,
    accountId: string,
    trustedGuardWrites: D1PreparedStatement[] = [],
  ): Promise<ImportSummary> {
    const header = await this.header(id, accountId);
    if (header.state !== 'staging') return this.get(id, accountId);
    const manifest = JSON.parse(header.manifest_json) as ImportManifest,
      summary = await this.get(id, accountId);
    if (
      summary.capturedLists !== manifest.totalLists ||
      summary.capturedTasks !== manifest.totalTasks ||
      (manifest.issueCount !== null && summary.capturedIssues !== manifest.issueCount)
    )
      throw conflict('capture every selected row and preview issue before freezing this plan.');
    if (header.paused) return summary;
    const validator = new ImportValidator(this.db, this.now);
    if (header.validation_revision === null) {
      try {
        await validator.initialize(
          header,
          summary.capturedLists + summary.capturedTasks + summary.capturedIssues,
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw conflict('this validation checkpoint changed. retry the frozen input.');
      }
    }
    const current = await this.header(id, accountId);
    const progress = await validator.advance(current);
    if (!progress.done) return this.get(id, accountId);
    const hash = await transferDigest(
      canonicalJson({ manifestHash: header.manifest_hash, recordChain: progress.hash }),
    );
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.guard(
          "EXISTS(SELECT 1 FROM transfer_imports WHERE id=? AND account_id=? AND state='staging' AND revision=? AND validation_revision=revision)",
          [id, accountId, header.revision],
        ),
        ...((await this.options.prepareSourceCaptureGuards?.(manifest)) ?? []),
        ...trustedGuardWrites,
        this.db
          .prepare(
            `UPDATE transfer_import_records SET copy_position=(SELECT ranked.ordinal FROM (SELECT task.item_key,ROW_NUMBER() OVER(ORDER BY json_extract(task.input_json,'$.parentKey') IS NOT NULL,list.position,json_extract(task.input_json,'$.order'),task.position)-1 AS ordinal FROM transfer_import_records task JOIN transfer_import_records list ON list.import_id=task.import_id AND list.kind='list' AND list.item_key=json_extract(task.input_json,'$.listKey') WHERE task.import_id=? AND task.kind='task') ranked WHERE ranked.item_key=transfer_import_records.item_key) WHERE import_id=? AND kind='task'`,
          )
          .bind(id, id),
        this.db
          .prepare(
            "UPDATE transfer_imports SET state='preview',preview_hash=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(hash, this.now(), id),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const current = await this.header(id, accountId);
      if (current.preview_hash !== hash) throw conflict();
    }
    return this.get(id, accountId);
  }
  private commands() {
    if (!this.options.commands || !this.options.operations)
      throw new AppError(
        'installation_unavailable',
        'the transfer command boundary is not configured.',
        503,
      );
    return { commands: this.options.commands, operations: this.options.operations };
  }
  private copyHeader(header: Header, manifest: ImportManifest): BeginCapturedCopy {
    const existing = manifest.destination.kind === 'existing';
    return {
      operationId: header.operation_id ?? header.id,
      ownerSubject: header.owner_subject,
      accountId: header.account_id,
      source: manifest.source.kind === 'account' ? 'transfer' : 'import',
      origin: 'owner',
      totalTasks: manifest.totalTasks,
      totalLists: existing ? 1 : manifest.totalLists,
      newListCount: existing ? 0 : manifest.totalLists,
      requestKey: 'import:' + header.preview_hash,
    };
  }
  async confirm(
    id: string,
    accountId: string,
    input: z.input<typeof ConfirmImportSchema>,
  ): Promise<ImportSummary> {
    const acceptance = parse(ConfirmImportSchema, input),
      header = await this.header(id, accountId);
    if (
      header.preview_hash !== acceptance.previewHash ||
      !['preview', 'capturing', 'running', 'finished'].includes(header.state)
    )
      throw conflict('confirm the current frozen preview before creating tasks.');
    const summary = await this.get(id, accountId);
    if (
      summary.errorCount ||
      (summary.warningCount && !acceptance.acceptWarnings) ||
      (summary.repeatingCount && !acceptance.confirmIndependentRepeat)
    )
      throw new AppError(
        'validation_failed',
        'resolve preview errors and accept omitted fields and independent repeat rules before creating tasks.',
        422,
        false,
        {
          warningCount: String(summary.warningCount),
          errorCount: String(summary.errorCount),
          repeatingCount: String(summary.repeatingCount),
        },
      );
    if (header.state !== 'preview') return this.get(id, accountId);
    const { commands } = this.commands(),
      manifest = JSON.parse(header.manifest_json) as ImportManifest;
    const proposed =
      this.now() - Number(header.id.slice(0, 13)) > 23 * 3600000
        ? this.now() + ':' + crypto.randomUUID().replaceAll('-', '')
        : header.id;
    await this.db
      .prepare(
        "UPDATE transfer_imports SET operation_id=? WHERE id=? AND account_id=? AND state='preview'AND operation_id IS NULL",
      )
      .bind(proposed, id, accountId)
      .run();
    const admittedHeader = await this.header(id, accountId);
    try {
      await commands.beginCapturedCopy({
        ...this.copyHeader(admittedHeader, manifest),
        guardWrites: [
          this.guard(
            "EXISTS(SELECT 1 FROM transfer_imports WHERE id=? AND account_id=? AND state='preview' AND preview_hash=?)",
            [id, accountId, header.preview_hash],
          ),
          this.db
            .prepare(
              "UPDATE transfer_imports SET state='capturing',updated_at=?,revision=revision+1 WHERE id=?",
            )
            .bind(this.now(), id),
        ],
      });
    } catch (error) {
      if (error instanceof AppError)
        await this.db
          .prepare('UPDATE transfer_imports SET paused=?,error_code=?,next_at=? WHERE id=?')
          .bind(Number(!error.retryable), error.code, this.now() + 5000, id)
          .run();
      throw error;
    }
    return this.get(id, accountId);
  }
  async resume(id: string, accountId: string): Promise<ImportSummary> {
    await assertLocalWritable(this.db, accountId);
    await this.header(id, accountId);
    await this.db
      .prepare('UPDATE transfer_imports SET paused=0,error_code=NULL,next_at=0 WHERE id=?')
      .bind(id)
      .run();
    return this.get(id, accountId);
  }
  async advanceNext(): Promise<ImportSummary | null> {
    const row = await this.db
      .prepare(
        "SELECT id,account_id FROM transfer_imports WHERE state IN('capturing','running') AND paused=0 AND next_at<=? ORDER BY work_order,created_at,id LIMIT 1",
      )
      .bind(this.now())
      .first<{ id: string; account_id: string }>();
    return row ? this.advance(row.id, row.account_id) : null;
  }
  async advance(id: string, accountId: string): Promise<ImportSummary> {
    const row = await this.header(id, accountId);
    if (row.paused) return this.get(id, accountId);
    await this.db
      .prepare(
        'UPDATE transfer_imports SET work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM transfer_imports),updated_at=? WHERE id=?',
      )
      .bind(this.now(), id)
      .run();
    try {
      return await this.advanceInternal(id, accountId);
    } catch (error) {
      if (error instanceof AppError)
        await this.db
          .prepare('UPDATE transfer_imports SET paused=?,error_code=?,next_at=? WHERE id=?')
          .bind(Number(!error.retryable), error.code, this.now() + 5000, id)
          .run();
      throw error;
    }
  }
  private async advanceInternal(id: string, accountId: string): Promise<ImportSummary> {
    const header = await this.header(id, accountId);
    if (['finished', 'cancelled', 'preview', 'staging'].includes(header.state))
      return this.get(id, accountId);
    const { commands, operations } = this.commands(),
      manifest = JSON.parse(header.manifest_json) as ImportManifest;
    const operationId = header.operation_id ?? id;
    let operation = await operations.get(operationId, accountId);
    if (!operation) operation = await commands.beginCapturedCopy(this.copyHeader(header, manifest));
    if (operation.finished) {
      await this.db
        .prepare(
          "UPDATE transfer_imports SET state='finished',finished_at=?,updated_at=? WHERE id=?",
        )
        .bind(this.now(), this.now(), id)
        .run();
      return this.get(id, accountId);
    }
    if (header.state === 'running') {
      await commands.advance(accountId, operationId);
      const current = await operations.get(operationId, accountId);
      if (current?.finished)
        await this.db
          .prepare(
            "UPDATE transfer_imports SET state='finished',finished_at=?,updated_at=? WHERE id=?",
          )
          .bind(this.now(), this.now(), id)
          .run();
      return this.get(id, accountId);
    }
    const copyListCount = manifest.destination.kind === 'existing' ? 1 : manifest.totalLists;
    if (header.capture_list_position < copyListCount) {
      const rows =
        manifest.destination.kind === 'existing'
          ? []
          : (
              await this.db
                .prepare(
                  "SELECT position,input_json FROM transfer_import_records WHERE import_id=? AND kind='list' AND position>=? ORDER BY position LIMIT 10",
                )
                .bind(id, header.capture_list_position)
                .all<RecordRow>()
            ).results;
      const definitions: CopyListDefinition[] =
        manifest.destination.kind === 'existing'
          ? [
              {
                key: 'list',
                position: 0,
                existingListId: manifest.destination.listId,
                revision: manifest.destination.revision,
              },
            ]
          : rows.map((row) => {
              const value = JSON.parse(row.input_json) as { key: string; title: string };
              return {
                key: value.key,
                position: row.position,
                title: value.title,
                boardId: (manifest.destination as { boardId: string }).boardId,
                ...(manifest.destination.kind === 'new' &&
                manifest.destination.boardRevision !== undefined
                  ? { boardRevision: manifest.destination.boardRevision }
                  : {}),
              };
            });
      await commands.appendCapturedCopyLists(operationId, accountId, definitions);
      await this.db
        .prepare(
          'UPDATE transfer_imports SET capture_list_position=?,updated_at=? WHERE id=? AND capture_list_position=?',
        )
        .bind(
          header.capture_list_position + definitions.length,
          this.now(),
          id,
          header.capture_list_position,
        )
        .run();
      return this.get(id, accountId);
    }
    if (header.capture_task_position < manifest.totalTasks) {
      const rows = (
        await this.db
          .prepare(
            "SELECT copy_position,input_json,label_definitions_json FROM transfer_import_records WHERE import_id=? AND kind='task' AND copy_position>=? ORDER BY copy_position LIMIT 10",
          )
          .bind(id, header.capture_task_position)
          .all<RecordRow>()
      ).results;
      const entries: CopyEntry[] = [];
      for (const row of rows) {
        const task = JSON.parse(row.input_json) as NormalizedImportTask;
        const entry: CopyEntry = {
          key: task.key,
          listKey: manifest.destination.kind === 'existing' ? 'list' : task.listKey,
          position: row.copy_position!,
          parentKey: task.parentKey,
          title: task.title,
          notes: task.notes,
          completed: task.completed,
          completedAt: task.completedAt,
          scheduledDay: task.scheduledDay,
          scheduledTime: task.scheduledTime,
          timeZone: task.timeZone,
          repeatRule: task.repeatRule,
          labelDefinitions:
            row.label_definitions_json && row.label_definitions_json !== 'null'
              ? (JSON.parse(row.label_definitions_json) as { name: string; color: string }[])
              : task.labels.map(
                  (name) =>
                    manifest.labelDefinitions.find(
                      (label) => label.name.toLowerCase() === name.toLowerCase(),
                    ) ?? { name, color: DEFAULT_IMPORTED_LABEL_COLOR },
                ),
          priority: task.priority,
          starred: task.starred,
          dependencyKeys: task.dependencies,
        };
        if (
          entries.length &&
          new TextEncoder().encode(JSON.stringify([...entries, entry])).byteLength > 60000
        )
          break;
        bounded([entry]);
        entries.push(entry);
      }
      if (!entries.length) throw conflict('the captured task position is missing.');
      await commands.appendCapturedCopy(operationId, accountId, entries);
      await this.db
        .prepare(
          'UPDATE transfer_imports SET capture_task_position=?,updated_at=? WHERE id=? AND capture_task_position=?',
        )
        .bind(
          header.capture_task_position + entries.length,
          this.now(),
          id,
          header.capture_task_position,
        )
        .run();
      return this.get(id, accountId);
    }
    const sealed = await commands.sealCapturedCopy(operationId, accountId);
    if (!sealed.captureSealed) return this.get(id, accountId);
    await this.db
      .prepare(
        "UPDATE transfer_imports SET state='running',updated_at=? WHERE id=? AND state='capturing'",
      )
      .bind(this.now(), id)
      .run();
    return this.get(id, accountId);
  }
  async cancel(id: string, accountId: string): Promise<ImportSummary> {
    const header = await this.header(id, accountId);
    if (header.state === 'finished' || header.state === 'cancelled') return this.get(id, accountId);
    if (header.operation_id && this.options.operations)
      await this.options.operations.cancel(header.operation_id, accountId, this.now());
    await this.db
      .prepare(
        "UPDATE transfer_imports SET state='cancelled',finished_at=?,updated_at=? WHERE id=?",
      )
      .bind(this.now(), this.now(), id)
      .run();
    return this.get(id, accountId);
  }
  async output(id: string, accountId: string, input: { limit?: number; cursor?: string } = {}) {
    const header = await this.header(id, accountId);
    if (!header.operation_id) return { items: [], nextCursor: null };
    const progress = await this.commands().commands.readCopyProgress(
      header.operation_id,
      accountId,
      input,
    );
    const sources = (
      await this.db
        .prepare(
          "SELECT item_key,json_extract(input_json,'$.completed')AS completed,json_extract(input_json,'$.completedAt')AS completed_at FROM transfer_import_records WHERE import_id=? AND kind='task'AND item_key IN(SELECT value FROM json_each(?))",
        )
        .bind(id, JSON.stringify(progress.items.map((item) => item.key)))
        .all<{ item_key: string; completed: number; completed_at: string | null }>()
    ).results;
    return {
      ...progress,
      items: progress.items.map((item) => {
        const source = sources.find((source) => source.item_key === item.key);
        return {
          ...item,
          ...(source
            ? {
                sourceCompletion: {
                  completed: source.completed === 1,
                  completedAt: source.completed_at,
                  providerTimeMayDiffer: source.completed === 1,
                },
              }
            : {}),
        };
      }),
    };
  }
}
