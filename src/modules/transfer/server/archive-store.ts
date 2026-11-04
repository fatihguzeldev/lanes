import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../contracts/errors';
import { assertLocalWritable, localWriteGuard } from '../../accounts/access';
import { OperationIdSchema } from '../../tasks/operation-contract';
import {
  ArchiveCaptureChunkSchema,
  ArchiveHeaderSchema,
  ArchiveImportModeSchema,
  PortableAccountSchema,
  type ArchiveHeader,
  type ArchiveImportMode,
  type ArchiveRecord,
} from '../archive-contract';
import { MAX_IMPORT_FILE_BYTES, TransferParseError } from '../parse-contract';
import { ArchiveValidator } from './archive-validation';
import { canonicalJson, transferDigest } from './content-hash';
const identity = z.string().min(1).max(1024);
const beginSchema = z
  .object({
    id: OperationIdSchema,
    accountId: identity,
    ownerSubject: identity,
    mode: ArchiveImportModeSchema,
    header: ArchiveHeaderSchema,
    recordCount: z.number().int().min(0).max(100000),
  })
  .strict();
export interface ArchiveRow {
  id: string;
  account_id: string;
  owner_subject: string;
  mode: ArchiveImportMode;
  header_json: string;
  expected_records: number;
  bytes: number;
  state: 'staging' | 'preview' | 'restoring' | 'finished' | 'cancelled';
  revision: number;
  preview_hash: string | null;
  created_at: number;
  updated_at: number;
  preferences_incoming: number;
  preferences_revision: number | null;
  paused: number;
  payload_pruned_at: number | null;
  validation_revision: number | null;
  hash_position: number;
  hash_chain: string;
  captured_records: number;
  match_count: number;
  matched_count: number;
  new_count: number;
  conflict_count: number;
  unmatched_count: number;
  selected_count: number;
  restored_count: number;
  skipped_count: number;
  graph_remaining: number;
}
export interface ArchiveRecordRow {
  item_key: string;
  position: number;
  kind: ArchiveRecord['kind'];
  input_json: string;
  input_hash: string;
  match_json: string | null;
  incoming: number;
  restore_state: string;
  result_json: string | null;
  fields_json: string;
  accept_omitted: number;
}
export interface ArchiveSummary {
  validation?: { checkedRecords: number; totalRecords: number; remainingGraphNodes: number } | null;
  paused?: boolean;
  id: string;
  accountId: string;
  mode: ArchiveImportMode;
  header: ArchiveHeader;
  recordCount: number;
  expectedRecords: number;
  bytes: number;
  state: ArchiveRow['state'];
  previewHash: string | null;
  revision: number;
}
export interface ArchiveStoreOptions {
  identity(accountId: string): Promise<z.infer<typeof PortableAccountSchema>>;
  now?: () => number;
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the versioned archive fields and explicit destination mapping.',
      422,
    );
  return result.data;
}
function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
const conflict = (
  message = 'the captured archive changed; refresh its preview before restoring.',
) => new AppError('conflict', message, 409);
/** Archive-owned staging stores only whitelisted declarative data, never credentials. */
export class WorkspaceArchiveStore {
  readonly now: () => number;
  private readonly validator: ArchiveValidator;
  constructor(
    readonly db: D1Database,
    readonly options: ArchiveStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.validator = new ArchiveValidator(db, this.now);
  }
  guard(condition: string, bindings: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO transfer_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
      .bind(...bindings);
  }
  async row(id: string, accountId: string): Promise<ArchiveRow> {
    const row = await this.db
      .prepare('SELECT * FROM transfer_archives WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first<ArchiveRow>();
    if (!row)
      throw new AppError(
        'not_found',
        'this archive capture is not available in the selected account.',
        404,
      );
    return row;
  }
  async get(id: string, accountId: string): Promise<ArchiveSummary> {
    const row = await this.row(id, accountId);
    const n = row.captured_records,
      remaining = row.graph_remaining;
    return {
      validation:
        row.validation_revision === null
          ? null
          : {
              checkedRecords: row.hash_position + 1,
              totalRecords: row.expected_records,
              remainingGraphNodes: remaining ?? 0,
            },
      paused: !!row.paused,
      id,
      accountId,
      mode: row.mode,
      header: JSON.parse(row.header_json) as ArchiveHeader,
      recordCount: n ?? 0,
      expectedRecords: row.expected_records,
      bytes: row.bytes,
      state: row.state,
      previewHash: row.preview_hash,
      revision: row.revision,
    };
  }
  async list(
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<{
    items: ArchiveSummary[];
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
          'this archive collection cursor belongs to another account.',
          422,
        );
      }
    }
    const rows = (
      await this.db
        .prepare(
          `SELECT id,created_at FROM transfer_archives WHERE account_id=? ${after ? 'AND(created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .bind(accountId, ...(after ? [after.createdAt, after.id] : []), limit + 1)
        .all<{ id: string; created_at: number }>()
    ).results;
    const items: ArchiveSummary[] = [];
    for (const row of rows) {
      if (items.length >= limit) break;
      const summary = await this.get(row.id, accountId);
      if (items.length && bytes([...items, summary]) > 64000) break;
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
  async begin(input: z.input<typeof beginSchema>): Promise<ArchiveSummary> {
    if (bytes(input) > 65536)
      throw new AppError('validation_failed', 'one archive header may contain at most64 kib.', 413);
    const selected = parse(beginSchema, input);
    const accountIdentity = await this.options.identity(selected.accountId);
    const portable = parse(PortableAccountSchema, {
      googleSubject: accountIdentity.googleSubject,
      email: accountIdentity.email,
      planningZone: accountIdentity.planningZone,
      weekStart: accountIdentity.weekStart,
    });
    if (
      selected.mode === 'restore_metadata' &&
      portable.googleSubject !== selected.header.source.googleSubject
    )
      throw new AppError(
        'validation_failed',
        'metadata restore requires an explicit destination with the same verified google subject. choose snapshot copy for a different account.',
        422,
      );
    const prior = await this.db
      .prepare('SELECT * FROM transfer_archives WHERE id=?')
      .bind(selected.id)
      .first<ArchiveRow>();
    const header = canonicalJson(selected.header);
    if (prior) {
      if (
        prior.account_id !== selected.accountId ||
        prior.owner_subject !== selected.ownerSubject ||
        prior.mode !== selected.mode ||
        prior.header_json !== header ||
        prior.expected_records !== selected.recordCount
      )
        throw conflict();
      return this.get(selected.id, selected.accountId);
    }
    const issued = Number(selected.id.slice(0, 13));
    if (this.now() - issued > 86400000 || issued > this.now() + 300000)
      throw conflict('this unrecorded archive operation identity has expired.');
    await assertLocalWritable(this.db, selected.accountId);
    await this.db.batch([
      localWriteGuard(this.db, selected.accountId),
      this.db
        .prepare(
          'INSERT INTO transfer_archives(id,account_id,owner_subject,mode,header_json,expected_records,bytes,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .bind(
          selected.id,
          selected.accountId,
          selected.ownerSubject,
          selected.mode,
          header,
          selected.recordCount,
          new TextEncoder().encode(header).byteLength + 40,
          this.now(),
          this.now(),
        ),
    ]);
    const saved = await this.row(selected.id, selected.accountId);
    if (
      saved.owner_subject !== selected.ownerSubject ||
      saved.header_json !== header ||
      saved.mode !== selected.mode ||
      saved.expected_records !== selected.recordCount
    )
      throw conflict();
    return this.get(selected.id, selected.accountId);
  }
  async append(id: string, accountId: string, input: unknown): Promise<ArchiveSummary> {
    if (bytes(input) > 65536)
      throw new AppError('validation_failed', 'one archive chunk may contain at most64 kib.', 413);
    const chunk = parse(ArchiveCaptureChunkSchema, input);
    if (bytes(chunk) > 65536)
      throw new AppError(
        'validation_failed',
        'one normalized archive chunk may contain at most64 kib.',
        413,
      );
    const header = await this.row(id, accountId);
    if (
      chunk.some((row) => row.position >= header.expected_records) ||
      new Set(chunk.map((row) => row.position)).size !== chunk.length ||
      new Set(chunk.map((row) => row.value.key)).size !== chunk.length
    )
      throw new AppError(
        'validation_failed',
        'use each archive-local key and declared position once.',
        422,
      );
    const rows = await Promise.all(
      chunk.map(async (row) => ({
        key: row.value.key,
        kind: row.value.kind,
        position: row.position,
        json: canonicalJson(row.value),
        hash: await transferDigest(canonicalJson(row)),
      })),
    );
    const prior = (
      await this.db
        .prepare(
          'SELECT item_key,position,input_hash FROM transfer_archive_records WHERE archive_id=? AND item_key IN(SELECT value FROM json_each(?))',
        )
        .bind(id, JSON.stringify(rows.map((row) => row.key)))
        .all<ArchiveRecordRow>()
    ).results;
    for (const row of rows) {
      const old = prior.find((old) => old.item_key === row.key);
      if (old && (old.input_hash !== row.hash || old.position !== row.position))
        throw conflict('an archive-local identity already has different captured content.');
    }
    const fresh = rows.filter((row) => !prior.some((old) => old.item_key === row.key));
    if (!fresh.length) return this.get(id, accountId);
    if (header.state !== 'staging' || header.validation_revision !== null)
      throw conflict('this archive preview is immutable. start a new restore to use changed data.');
    const added = fresh.reduce(
      (sum, row) => sum + new TextEncoder().encode(row.json).byteLength + 1,
      0,
    );
    if (header.bytes + added > MAX_IMPORT_FILE_BYTES)
      throw new AppError(
        'validation_failed',
        'a workspace archive may contain at most20 mib. choose a narrower selection instead of truncating its records.',
        413,
      );
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.guard(
          "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND account_id=? AND state='staging' AND validation_revision IS NULL AND revision=? AND bytes+?<=?)",
          [id, accountId, header.revision, added, MAX_IMPORT_FILE_BYTES],
        ),
        ...this.validator.labelWrites(
          id,
          chunk
            .filter((row) => fresh.some((value) => value.key === row.value.key))
            .map((row) => row.value),
        ),
        ...fresh.map((row) =>
          this.db
            .prepare(
              'INSERT INTO transfer_archive_records(archive_id,item_key,position,kind,input_json,input_hash,restore_priority)VALUES(?,?,?,?,?,?,?)',
            )
            .bind(
              id,
              row.key,
              row.position,
              row.kind,
              row.json,
              row.hash,
              {
                label: 0,
                board: 1,
                list: 2,
                task: 3,
                template: 4,
                template_list: 5,
                template_task: 6,
                schedule: 8,
                history: 9,
              }[row.kind],
            ),
        ),
        this.db
          .prepare(
            'UPDATE transfer_archives SET revision=revision+1,bytes=bytes+?,captured_records=captured_records+?,updated_at=? WHERE id=?',
          )
          .bind(added, fresh.length, this.now(), id),
      ]);
    } catch {
      const replay = (
        await this.db
          .prepare(
            'SELECT item_key,position,input_hash FROM transfer_archive_records WHERE archive_id=? AND item_key IN(SELECT value FROM json_each(?))',
          )
          .bind(id, JSON.stringify(rows.map((row) => row.key)))
          .all<ArchiveRecordRow>()
      ).results;
      if (
        !rows.every((row) =>
          replay.some(
            (old) =>
              old.item_key === row.key &&
              old.input_hash === row.hash &&
              old.position === row.position,
          ),
        )
      )
        throw conflict();
    }
    return this.get(id, accountId);
  }
  async page(
    id: string,
    accountId: string,
    input: { limit?: number; after?: number } = {},
  ): Promise<{
    items: {
      position: number;
      value: ArchiveRecord | null;
      payloadRetained: boolean;
      match: unknown;
      incoming: boolean;
      fields: string[];
      acceptOmittedReferences: boolean;
      restoreState: string;
    }[];
    nextCursor: number | null;
  }> {
    await this.row(id, accountId);
    const limit = parse(z.number().int().min(1).max(10), input.limit ?? 10),
      after = parse(z.number().int().min(-1).max(99999), input.after ?? -1);
    const rows = (
      await this.db
        .prepare(
          'SELECT * FROM transfer_archive_records WHERE archive_id=? AND position>? ORDER BY position LIMIT ?',
        )
        .bind(id, after, limit + 1)
        .all<ArchiveRecordRow>()
    ).results;
    const selected: ArchiveRecordRow[] = [];
    for (const row of rows) {
      if (selected.length >= limit || (selected.length && bytes([...selected, row]) > 64000)) break;
      selected.push(row);
    }
    return {
      items: selected.map((row) => ({
        position: row.position,
        value: row.input_json === '{}' ? null : (JSON.parse(row.input_json) as ArchiveRecord),
        payloadRetained: row.input_json !== '{}',
        match: row.match_json ? (JSON.parse(row.match_json) as unknown) : null,
        incoming: !!row.incoming,
        fields: JSON.parse(row.fields_json) as string[],
        acceptOmittedReferences: !!row.accept_omitted,
        restoreState: row.restore_state,
      })),
      nextCursor: rows.length > selected.length ? (selected.at(-1)?.position ?? null) : null,
    };
  }
  async seal(id: string, accountId: string): Promise<ArchiveSummary> {
    let row = await this.row(id, accountId);
    if (row.state !== 'staging' || row.paused) return this.get(id, accountId);
    const summary = await this.get(id, accountId);
    if (summary.recordCount !== row.expected_records)
      throw conflict(
        'capture every selected archive record before validating its complete references.',
      );
    try {
      if (row.validation_revision === null) {
        await this.validator.initialize(row);
        row = await this.row(id, accountId);
      }
      const progress = await this.validator.advance(row);
      if (!progress.done) return this.get(id, accountId);
      const hash = await transferDigest(
        canonicalJson({ header: JSON.parse(row.header_json), recordChain: progress.hash }),
      );
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.guard(
          "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='staging'AND validation_revision=revision AND hash_position=?)",
          [id, row.expected_records - 1],
        ),
        this.db
          .prepare(
            "UPDATE transfer_archives SET state='preview',preview_hash=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(hash, this.now(), id),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const current = await this.row(id, accountId);
      if (current.state === 'staging' && current.hash_position === row.hash_position)
        throw conflict(
          'the archive validation checkpoint changed or could not be stored. retry its bounded validation.',
        );
    }
    return this.get(id, accountId);
  }
}
