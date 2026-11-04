import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import { localWriteGuard } from '../../../accounts/server/connections/access';
const tables = {
  archive: {
    header: 'transfer_archives',
    nodes: 'transfer_archive_graph_nodes',
    edges: 'transfer_archive_graph_edges',
    id: 'archive_id',
  },
  import: {
    header: 'transfer_imports',
    nodes: 'transfer_import_graph_nodes',
    edges: 'transfer_import_graph_edges',
    id: 'import_id',
  },
} as const;
/** The same bounded Kahn traversal validates input-local dependency graphs in both captured formats. */
export class CapturedGraphValidator {
  constructor(
    private readonly db: D1Database,
    private readonly kind: keyof typeof tables,
  ) {}
  async advance(id: string, accountId: string): Promise<boolean> {
    const table = tables[this.kind];
    for (let batch = 0; batch < 5; batch++) {
      const zeros = (
        await this.db
          .prepare(
            `SELECT scope,node_key FROM ${table.nodes} WHERE ${table.id}=? AND processed=0 AND remaining=0 ORDER BY scope,node_key LIMIT 100`,
          )
          .bind(id)
          .all<{ scope: string; node_key: string }>()
      ).results;
      if (!zeros.length) {
        const pending = await this.db
          .prepare(`SELECT 1 FROM ${table.nodes} WHERE ${table.id}=? AND processed=0 LIMIT 1`)
          .bind(id)
          .first();
        if (pending)
          throw new AppError(
            'validation_failed',
            'the captured dependency references contain a cycle. correct the selected input before continuing.',
            422,
          );
        break;
      }
      const selected: typeof zeros = [];
      for (const node of zeros) {
        if (
          selected.length &&
          new TextEncoder().encode(JSON.stringify([...selected, node])).byteLength > 48000
        )
          break;
        selected.push(node);
      }
      const json = JSON.stringify(selected);
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            `INSERT INTO transfer_write_guards(valid)SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM ${table.header} WHERE id=? AND state='staging'AND paused=0 AND validation_revision=revision)OR(SELECT COUNT(*)FROM ${table.nodes} node WHERE node.${table.id}=? AND node.processed=0 AND(node.scope,node.node_key)IN(SELECT json_extract(value,'$.scope'),json_extract(value,'$.node_key')FROM json_each(?)))<>?`,
          )
          .bind(id, id, json, selected.length),
        this.db
          .prepare(
            `UPDATE ${table.nodes} SET remaining=remaining-(SELECT COUNT(*)FROM ${table.edges} edge JOIN json_each(?)selected ON edge.scope=json_extract(selected.value,'$.scope')AND edge.target_key=json_extract(selected.value,'$.node_key')WHERE edge.${table.id}=${table.nodes}.${table.id} AND edge.scope=${table.nodes}.scope AND edge.source_key=${table.nodes}.node_key)WHERE ${table.id}=? AND processed=0 AND(scope,node_key)IN(SELECT edge.scope,edge.source_key FROM ${table.edges} edge JOIN json_each(?)selected ON edge.scope=json_extract(selected.value,'$.scope')AND edge.target_key=json_extract(selected.value,'$.node_key')WHERE edge.${table.id}=?)`,
          )
          .bind(json, id, json, id),
        this.db
          .prepare(`UPDATE ${table.header} SET graph_remaining=graph_remaining-? WHERE id=?`)
          .bind(selected.length, id),
        this.db
          .prepare(
            `UPDATE ${table.nodes} SET processed=1 WHERE ${table.id}=? AND(scope,node_key)IN(SELECT json_extract(value,'$.scope'),json_extract(value,'$.node_key')FROM json_each(?))`,
          )
          .bind(id, json),
        this.db
          .prepare(
            `DELETE FROM ${table.edges} WHERE ${table.id}=? AND(scope,target_key)IN(SELECT json_extract(value,'$.scope'),json_extract(value,'$.node_key')FROM json_each(?))`,
          )
          .bind(id, json),
      ]);
    }
    return (
      (await this.db
        .prepare(`SELECT 1 FROM ${table.nodes} WHERE ${table.id}=? AND processed=0 LIMIT 1`)
        .bind(id)
        .first()) === null
    );
  }
}
