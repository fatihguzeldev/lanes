import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { OperationQueries } from '../../../operations/server/queries/receipts';
import type { TaskSnapshotReader } from '../../../tasks/server/queries/snapshot-reader';
import type { TemplateDocumentStore } from '../../../tasks/server/templates/documents';
import type { SheetsExportService } from '../sheets/export';
import type { ArchiveExportService } from '../archives/export/service';
import { transferDigest } from '../integrity';
import type { ArchiveHeader } from '../../contracts/archive';

export interface TransferRetentionOptions {
  operationQueries?: Pick<OperationQueries, 'summary'>;
  snapshots: Pick<TaskSnapshotReader, 'removeSnapshotSlice'>;
  documents?: Pick<TemplateDocumentStore, 'releaseCapturePins'>;
  sheets?: Pick<SheetsExportService, 'cleanup'>;
  archiveExports?: Pick<ArchiveExportService, 'cleanup'>;
  now?: () => number;
}
interface ImportHeader {
  id: string;
  account_id: string;
  operation_id: string | null;
}
interface ArchiveHeaderRow {
  id: string;
  account_id: string;
  header_json: string;
}
interface ArchivePayload {
  rowid: number;
  archive_id: string;
  item_key: string;
  kind: string;
  header_json: string;
  account_id: string;
}
const day = 86400000,
  retention = 90 * day;
const importCounts = `(SELECT json_object('lists',COALESCE(SUM(kind='list'),0),'tasks',COALESCE(SUM(kind='task'),0),'issues',COALESCE(SUM(kind='issue'),0),
 'warnings',COALESCE(SUM(kind='issue' AND json_extract(input_json,'$.severity')='warning'),0),'errors',COALESCE(SUM(kind='issue' AND json_extract(input_json,'$.severity')='error'),0),
 'completed',COALESCE(SUM(kind='task' AND json_extract(input_json,'$.completed')=1),0),'subtasks',COALESCE(SUM(kind='task' AND json_extract(input_json,'$.parentKey') IS NOT NULL),0),'repeating',COALESCE(SUM(kind='task' AND json_type(input_json,'$.repeatRule')='object'),0)) FROM transfer_import_records WHERE import_id=transfer_imports.id)`;
const importMinimal = `CASE WHEN kind='task' THEN json_object('key',item_key,'completed',json(CASE WHEN json_extract(input_json,'$.completed')=1 THEN 'true' ELSE 'false' END),'completedAt',json_extract(input_json,'$.completedAt')) ELSE json_object('key',item_key) END`;
const archiveMinimalMatch = `CASE WHEN match_json IS NULL THEN NULL ELSE json_patch(json_object('key',item_key,'kind',kind,'status',COALESCE(json_extract(match_json,'$.status'),'unmatched'),'message','the detailed preview has expired.','fields',json('[]'),'blockedFields',json('{}'),'changes',json('{}'),'defaultIncomingFields',json('[]')),json_patch(CASE WHEN json_type(match_json,'$.destinationId')='text' THEN json_object('destinationId',json_extract(match_json,'$.destinationId')) ELSE '{}' END,CASE WHEN json_type(match_json,'$.destinationRevision')='integer' THEN json_object('destinationRevision',json_extract(match_json,'$.destinationRevision')) ELSE '{}' END)) END`;

/** One shared row budget covers payload updates, source-owner cleanup, and child-first deletion. */
export class TransferRetention {
  constructor(
    private readonly db: D1Database,
    private readonly options: TransferRetentionOptions,
  ) {}

  private checked(value: number, allowance: number): number {
    if (!Number.isInteger(value) || value < 0 || value > allowance)
      throw new AppError('internal_error', 'a cleanup owner exceeded its supplied row budget', 500);
    return value;
  }
  private async operationSettled(
    id: string | null,
    accountId: string,
    now: number,
  ): Promise<boolean> {
    if (!id) return true;
    if (!this.options.operationQueries) return false;
    const operation = await this.options.operationQueries.summary(id, accountId);
    if (operation) return operation.finished && operation.state !== 'uncertain';
    return this.admissionExpired(id, now);
  }
  private admissionExpired(id: string, now: number): boolean {
    const issued = Number(id.slice(0, 13));
    return Number.isSafeInteger(issued) && now - issued > day;
  }
  /** Rotation is only a bounded selector; provider outcome and terminal state remain authoritative. */
  private async candidates<T>(
    table: 'transfer_imports' | 'transfer_archives',
    condition: string,
    now: number,
    limit = 1,
  ): Promise<T[]> {
    const count = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${condition}`)
      .bind(now - day)
      .first<number>('n');
    if (!count) return [];
    const offset = (Math.floor(now / 60000) * limit) % count;
    return (
      await this.db
        .prepare(
          `SELECT * FROM ${table} WHERE ${condition} ORDER BY finished_at,id LIMIT ? OFFSET ?`,
        )
        .bind(now - day, limit, offset)
        .all<T>()
    ).results;
  }

  async cleanup(limit = 100, now = this.options.now?.() ?? Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(now))
      throw new AppError(
        'validation_failed',
        'clean at most100 transfer rows at one valid instant',
        422,
      );
    let changed = 0;
    const remaining = () => limit - changed;
    for (const owner of [this.options.sheets, this.options.archiveExports]) {
      if (owner && remaining()) {
        const allowance = Math.min(remaining(), Math.max(1, Math.floor(limit / 4)));
        changed += this.checked(await owner.cleanup(allowance, now), allowance);
      }
    }
    if (!remaining()) return changed;

    changed += (
      await this.db
        .prepare(
          `UPDATE transfer_imports SET state='cancelled',paused=1,error_code='conflict',summary_cache_json=COALESCE(summary_cache_json,${importCounts}),payload_pruned_at=?,finished_at=updated_at+86400000,updated_at=?
      WHERE id IN(SELECT id FROM transfer_imports WHERE state IN('staging','preview') AND operation_id IS NULL AND updated_at<=? ORDER BY updated_at,id LIMIT ?)`,
        )
        .bind(now, now, now - day, remaining())
        .run()
    ).meta.changes;
    if (!remaining()) return changed;
    changed += (
      await this.db
        .prepare(
          `UPDATE transfer_archives SET state='cancelled',paused=1,payload_pruned_at=?,finished_at=updated_at+86400000,updated_at=?
      WHERE id IN(SELECT a.id FROM transfer_archives a WHERE a.state IN('staging','preview') AND a.updated_at<=?
      AND NOT EXISTS(SELECT 1 FROM transfer_archive_copies c JOIN transfer_imports i ON i.id=c.import_id WHERE c.archive_id=a.id AND c.state<>'ready' AND i.state NOT IN('finished','cancelled')) ORDER BY a.updated_at,a.id LIMIT ?)`,
        )
        .bind(now, now, now - day, remaining())
        .run()
    ).meta.changes;
    if (!remaining()) return changed;

    const imports = await this.candidates<ImportHeader>(
      'transfer_imports',
      "state IN('finished','cancelled') AND payload_pruned_at IS NULL AND finished_at<=?",
      now,
    );
    for (const row of imports) {
      if (!remaining()) return changed;
      if (await this.operationSettled(row.operation_id, row.account_id, now))
        changed += (
          await this.db
            .prepare(
              `UPDATE transfer_imports SET summary_cache_json=COALESCE(summary_cache_json,${importCounts}),payload_pruned_at=? WHERE id=? AND payload_pruned_at IS NULL AND state IN('finished','cancelled')`,
            )
            .bind(now, row.id)
            .run()
        ).meta.changes;
    }
    if (!remaining()) return changed;

    const archives = await this.candidates<ArchiveHeaderRow>(
      'transfer_archives',
      "state IN('finished','cancelled') AND payload_pruned_at IS NULL AND finished_at<=?",
      now,
    );
    for (const row of archives) {
      if (!remaining()) return changed;
      const action = await this.db
        .prepare(
          "SELECT item_key,phase,operation_id FROM transfer_archive_actions WHERE archive_id=? AND state NOT IN('confirmed','cancelled') ORDER BY item_key,phase LIMIT 1",
        )
        .bind(row.id)
        .first<{ item_key: string; phase: string; operation_id: string }>();
      if (action && this.options.operationQueries) {
        const operation = await this.options.operationQueries.summary(
          action.operation_id,
          row.account_id,
        );
        if (operation?.finished || (!operation && this.admissionExpired(action.operation_id, now)))
          changed += (
            await this.db
              .prepare(
                "UPDATE transfer_archive_actions SET state=? WHERE archive_id=? AND item_key=? AND phase=? AND state NOT IN('confirmed','cancelled')",
              )
              .bind(
                operation?.state === 'succeeded' ? 'confirmed' : 'cancelled',
                row.id,
                action.item_key,
                action.phase,
              )
              .run()
          ).meta.changes;
      }
      if (!remaining()) return changed;
      const unsafe = await this.db
        .prepare(
          `SELECT 1 WHERE EXISTS(SELECT 1 FROM transfer_archive_actions WHERE archive_id=? AND state NOT IN('confirmed','cancelled')) OR EXISTS(SELECT 1 FROM transfer_archive_copies c JOIN transfer_imports i ON i.id=c.import_id WHERE c.archive_id=? AND c.state<>'ready' AND i.state NOT IN('finished','cancelled'))`,
        )
        .bind(row.id, row.id)
        .first();
      if (!unsafe)
        changed += (
          await this.db
            .prepare(
              "UPDATE transfer_archives SET payload_pruned_at=? WHERE id=? AND payload_pruned_at IS NULL AND state IN('finished','cancelled')",
            )
            .bind(now, row.id)
            .run()
        ).meta.changes;
    }
    if (!remaining()) return changed;

    changed += (
      await this.db
        .prepare(
          `UPDATE transfer_import_records SET input_json=${importMinimal},label_definitions_json=NULL WHERE rowid IN(
      SELECT r.rowid FROM transfer_import_records r JOIN transfer_imports i ON i.id=r.import_id WHERE i.payload_pruned_at IS NOT NULL
      AND(r.label_definitions_json IS NOT NULL OR r.input_json<>${importMinimal}) ORDER BY i.finished_at,r.import_id,r.kind,r.position LIMIT ?)`,
        )
        .bind(remaining())
        .run()
    ).meta.changes;
    if (!remaining()) return changed;

    if (this.options.documents) {
      const first = await this.db
        .prepare(
          `SELECT a.id,a.account_id,a.header_json FROM transfer_archives a WHERE a.payload_pruned_at IS NOT NULL AND EXISTS(SELECT 1 FROM transfer_archive_records r WHERE r.archive_id=a.id AND r.kind='template' AND r.input_json<>'{}') ORDER BY a.finished_at,a.id LIMIT 1`,
        )
        .first<ArchiveHeaderRow>();
      if (first) {
        const allowance = Math.min(10, Math.max(1, Math.floor(remaining() / 2)));
        const records = (
          await this.db
            .prepare(
              "SELECT rowid,archive_id,item_key,kind FROM transfer_archive_records WHERE archive_id=? AND kind='template' AND input_json<>'{}' ORDER BY position LIMIT ?",
            )
            .bind(first.id, allowance)
            .all<ArchivePayload>()
        ).results;
        const header = JSON.parse(first.header_json) as ArchiveHeader;
        const ids = await Promise.all(
          records.map(
            async (row) =>
              'archive-snapshot-' +
              (
                await transferDigest(
                  header.source.googleSubject +
                    ':' +
                    header.id +
                    ':' +
                    row.item_key +
                    ':' +
                    first.id,
                )
              ).slice(0, 32),
          ),
        );
        changed += this.checked(
          await this.options.documents.releaseCapturePins(first.account_id, ids),
          records.length,
        );
        if (!remaining()) return changed;
        const selected = records.slice(0, remaining());
        if (selected.length)
          changed += (
            await this.db
              .prepare(
                `UPDATE transfer_archive_records SET input_json='{}',match_json=${archiveMinimalMatch} WHERE rowid IN(SELECT value FROM json_each(?)) AND input_json<>'{}'`,
              )
              .bind(JSON.stringify(selected.map((row) => row.rowid)))
              .run()
          ).meta.changes;
      }
    }
    if (!remaining()) return changed;
    changed += (
      await this.db
        .prepare(
          `UPDATE transfer_archive_records SET input_json='{}',match_json=${archiveMinimalMatch} WHERE rowid IN(SELECT r.rowid FROM transfer_archive_records r JOIN transfer_archives a ON a.id=r.archive_id WHERE a.payload_pruned_at IS NOT NULL AND r.kind<>'template' AND r.input_json<>'{}' ORDER BY a.finished_at,r.archive_id,r.position LIMIT ?)`,
        )
        .bind(remaining())
        .run()
    ).meta.changes;
    if (!remaining()) return changed;
    changed += (
      await this.db
        .prepare(
          `UPDATE transfer_archive_actions SET input_json='{}',result_json=CASE WHEN result_json IS NULL THEN NULL ELSE json_object('id',json_extract(result_json,'$.id')) END
      WHERE rowid IN(SELECT action.rowid FROM transfer_archive_actions action JOIN transfer_archives a ON a.id=action.archive_id WHERE a.payload_pruned_at IS NOT NULL AND action.state IN('confirmed','cancelled') AND action.input_json<>'{}' ORDER BY a.finished_at,action.archive_id,action.item_key,action.phase LIMIT ?)`,
        )
        .bind(remaining())
        .run()
    ).meta.changes;
    if (!remaining()) return changed;

    const source = await this.db
      .prepare(
        `SELECT c.import_id,c.source_account_id,c.snapshot_id FROM transfer_account_captures c JOIN transfer_imports i ON i.id=c.import_id
      WHERE c.request_hash IS NOT NULL AND c.snapshot_released=0 AND ((c.state='ready' AND i.state<>'staging') OR(i.state IN('finished','cancelled') AND i.payload_pruned_at IS NOT NULL)) ORDER BY i.updated_at,c.import_id LIMIT 1`,
      )
      .first<{ import_id: string; source_account_id: string; snapshot_id: string }>();
    if (source) {
      const result = await this.options.snapshots.removeSnapshotSlice(
        source.snapshot_id,
        source.source_account_id,
        remaining(),
      );
      changed += this.checked(result.deleted, remaining());
      if (result.done && remaining())
        changed += (
          await this.db
            .prepare(
              'UPDATE transfer_account_captures SET snapshot_released=1 WHERE import_id=? AND snapshot_released=0',
            )
            .bind(source.import_id)
            .run()
        ).meta.changes;
    }
    if (!remaining()) return changed;

    for (const [table, column, headers] of [
      ['transfer_import_graph_edges', 'import_id', 'transfer_imports'],
      ['transfer_import_graph_nodes', 'import_id', 'transfer_imports'],
      ['transfer_archive_graph_edges', 'archive_id', 'transfer_archives'],
      ['transfer_archive_graph_nodes', 'archive_id', 'transfer_archives'],
      ['transfer_archive_template_labels', 'archive_id', 'transfer_archives'],
    ] as const) {
      if (!remaining()) return changed;
      changed += (
        await this.db
          .prepare(
            `DELETE FROM ${table} WHERE rowid IN(SELECT child.rowid FROM ${table} child JOIN ${headers} header ON header.id=child.${column} WHERE header.payload_pruned_at IS NOT NULL ORDER BY header.finished_at,child.rowid LIMIT ?)`,
          )
          .bind(remaining())
          .run()
      ).meta.changes;
    }
    if (!remaining()) return changed;

    const expiredImports = `SELECT id FROM transfer_imports WHERE payload_pruned_at IS NOT NULL AND finished_at<=?`;
    const expiredArchives = `SELECT id FROM transfer_archives WHERE payload_pruned_at IS NOT NULL AND finished_at<=?`;
    const children = [
      ['transfer_archive_copies', `import_id IN(${expiredImports})`],
      ['transfer_account_captures', `snapshot_released=1 AND import_id IN(${expiredImports})`],
      ['transfer_import_records', `import_id IN(${expiredImports})`],
      ['transfer_archive_actions', `archive_id IN(${expiredArchives})`],
      ['transfer_archive_records', `input_json='{}' AND archive_id IN(${expiredArchives})`],
    ] as const;
    for (const [table, condition] of children) {
      if (!remaining()) return changed;
      changed += (
        await this.db
          .prepare(
            `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE ${condition} ORDER BY rowid LIMIT ?)`,
          )
          .bind(now - retention, remaining())
          .run()
      ).meta.changes;
    }
    if (!remaining()) return changed;
    changed += (
      await this.db
        .prepare(
          `DELETE FROM transfer_imports WHERE id IN(SELECT id FROM transfer_imports i WHERE i.payload_pruned_at IS NOT NULL AND i.finished_at<=?
      AND NOT EXISTS(SELECT 1 FROM transfer_import_records r WHERE r.import_id=i.id) AND NOT EXISTS(SELECT 1 FROM transfer_import_graph_edges r WHERE r.import_id=i.id) AND NOT EXISTS(SELECT 1 FROM transfer_import_graph_nodes r WHERE r.import_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM transfer_account_captures c WHERE c.import_id=i.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_copies c WHERE c.import_id=i.id) ORDER BY i.finished_at,i.id LIMIT ?)`,
        )
        .bind(now - retention, remaining())
        .run()
    ).meta.changes;
    if (!remaining()) return changed;
    changed += (
      await this.db
        .prepare(
          `DELETE FROM transfer_archives WHERE id IN(SELECT id FROM transfer_archives a WHERE a.payload_pruned_at IS NOT NULL AND a.finished_at<=?
      AND NOT EXISTS(SELECT 1 FROM transfer_archive_records r WHERE r.archive_id=a.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_actions r WHERE r.archive_id=a.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_copies r WHERE r.archive_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM transfer_archive_graph_edges r WHERE r.archive_id=a.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_graph_nodes r WHERE r.archive_id=a.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_template_labels r WHERE r.archive_id=a.id) ORDER BY a.finished_at,a.id LIMIT ?)`,
        )
        .bind(now - retention, remaining())
        .run()
    ).meta.changes;
    return changed;
  }
}
