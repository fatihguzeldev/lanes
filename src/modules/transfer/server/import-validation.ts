import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import { localWriteGuard } from '../../accounts/server/connections/access';
import { CapturedGraphValidator } from './captured-graph';
import { canonicalJson, transferDigest } from './content-hash';
export interface ImportValidationRow {
  id: string;
  account_id: string;
  revision: number;
  validation_revision: number | null;
  validation_records: number;
  hash_position: number;
  hash_chain: string;
}
/** Chunk schemas validate fields once; complete input-local references are checked without re-parsing every task. */
export class ImportValidator {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}
  private guard(sql: string, bindings: unknown[]) {
    return this.db
      .prepare(`INSERT INTO transfer_write_guards(valid)SELECT 0 WHERE NOT(${sql})`)
      .bind(...bindings);
  }
  async initialize(row: ImportValidationRow, totalRecords: number): Promise<void> {
    const invalid = await this.db
      .prepare(
        `SELECT 1 FROM transfer_import_records task LEFT JOIN transfer_import_records list ON list.import_id=task.import_id AND list.kind='list'AND list.item_key=json_extract(task.input_json,'$.listKey')LEFT JOIN transfer_import_records parent ON parent.import_id=task.import_id AND parent.kind='task'AND parent.item_key=json_extract(task.input_json,'$.parentKey')WHERE task.import_id=? AND task.kind='task'AND(list.item_key IS NULL OR json_extract(task.input_json,'$.parentKey')IS NOT NULL AND(parent.item_key IS NULL OR json_extract(parent.input_json,'$.parentKey')IS NOT NULL OR json_extract(parent.input_json,'$.listKey')<>json_extract(task.input_json,'$.listKey'))OR EXISTS(SELECT 1 FROM json_each(task.input_json,'$.dependencies')dependency LEFT JOIN transfer_import_records blocker ON blocker.import_id=task.import_id AND blocker.kind='task'AND blocker.item_key=dependency.value WHERE blocker.item_key IS NULL OR blocker.item_key=task.item_key))LIMIT 1`,
      )
      .bind(row.id)
      .first();
    if (invalid)
      throw new AppError(
        'validation_failed',
        'the selected import has missing, cross-list, self-referential or deeper references. correct the preview before continuing.',
        422,
      );
    await this.db.batch([
      localWriteGuard(this.db, row.account_id),
      this.guard(
        "EXISTS(SELECT 1 FROM transfer_imports WHERE id=? AND state='staging'AND paused=0 AND revision=? AND validation_revision IS NULL)",
        [row.id, row.revision],
      ),
      this.db
        .prepare(
          `UPDATE transfer_import_records SET validation_position=(SELECT ordinal FROM(SELECT kind,item_key,ROW_NUMBER()OVER(ORDER BY kind,position)-1 AS ordinal FROM transfer_import_records WHERE import_id=?)ranked WHERE ranked.kind=transfer_import_records.kind AND ranked.item_key=transfer_import_records.item_key)WHERE import_id=?`,
        )
        .bind(row.id, row.id),
      this.db
        .prepare(
          `INSERT INTO transfer_import_graph_nodes(import_id,scope,node_key,remaining)SELECT ?,'tasks',item_key,json_array_length(input_json,'$.dependencies')FROM transfer_import_records WHERE import_id=? AND kind='task'`,
        )
        .bind(row.id, row.id),
      this.db
        .prepare(
          `INSERT INTO transfer_import_graph_edges(import_id,scope,source_key,target_key)SELECT ?,'tasks',task.item_key,dependency.value FROM transfer_import_records task,json_each(task.input_json,'$.dependencies')dependency WHERE task.import_id=? AND task.kind='task'`,
        )
        .bind(row.id, row.id),
      this.db
        .prepare(
          'UPDATE transfer_imports SET validation_revision=revision,validation_records=?,graph_remaining=(SELECT COUNT(*)FROM transfer_import_graph_nodes WHERE import_id=transfer_imports.id)WHERE id=?',
        )
        .bind(totalRecords, row.id),
    ]);
  }
  async advance(row: ImportValidationRow): Promise<{ done: boolean; hash: string }> {
    const done = await new CapturedGraphValidator(this.db, 'import').advance(
      row.id,
      row.account_id,
    );
    const hashes = (
      await this.db
        .prepare(
          'SELECT kind,item_key,validation_position AS position,input_hash FROM transfer_import_records WHERE import_id=? AND validation_position>? ORDER BY validation_position LIMIT 100',
        )
        .bind(row.id, row.hash_position)
        .all<{ kind: string; item_key: string; position: number; input_hash: string }>()
    ).results;
    let hash = row.hash_chain,
      position = row.hash_position;
    for (const record of hashes) {
      hash = await transferDigest(hash + '\n' + canonicalJson(record));
      position = record.position;
    }
    await this.db.batch([
      this.guard(
        "EXISTS(SELECT 1 FROM transfer_imports WHERE id=? AND state='staging'AND paused=0 AND hash_position=? AND hash_chain=? AND validation_revision=revision)",
        [row.id, row.hash_position, row.hash_chain],
      ),
      this.db
        .prepare('UPDATE transfer_imports SET hash_position=?,hash_chain=?,updated_at=? WHERE id=?')
        .bind(position, hash, this.now(), row.id),
    ]);
    return { done: done && position === row.validation_records - 1, hash };
  }
}
