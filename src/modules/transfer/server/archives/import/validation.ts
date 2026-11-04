import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../../shared/contracts/errors';
import { localWriteGuard } from '../../../../accounts/server/connections/access';
import type { ArchiveHeader, ArchiveRecord } from '../../../contracts/archive';
import { canonicalJson, transferDigest } from '../../integrity';
import { CapturedGraphValidator } from '../../imports/graph';
export interface ArchiveValidationRow {
  id: string;
  account_id: string;
  revision: number;
  validation_revision: number | null;
  hash_position: number;
  hash_chain: string;
  expected_records: number;
  header_json: string;
}
const invalid = () =>
  new AppError(
    'validation_failed',
    'the archive has missing, conflicting, cyclic or deeper references. correct the selected archive before restoring.',
    422,
  );
/** Reference validation has no note-body reads. A seal advances bounded graph/hash work. */
export class ArchiveValidator {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}
  private guard(sql: string, bindings: unknown[]) {
    return this.db
      .prepare(`INSERT INTO transfer_write_guards(valid) SELECT 0 WHERE NOT (${sql})`)
      .bind(...bindings);
  }
  labelWrites(id: string, records: readonly ArchiveRecord[]): D1PreparedStatement[] {
    const definitions = new Map<string, { templateKey: string; nameKey: string; color: string }>();
    for (const record of records)
      if (record.kind === 'template_task')
        for (const label of record.value.labels) {
          const nameKey = label.name.normalize('NFC').toLowerCase(),
            key = JSON.stringify([record.templateKey, nameKey]),
            previous = definitions.get(key);
          if (previous && previous.color !== label.color) throw invalid();
          definitions.set(key, { templateKey: record.templateKey, nameKey, color: label.color });
        }
    if (!definitions.size) return [];
    const json = JSON.stringify([...definitions.values()]);
    return [
      this.guard(
        `NOT EXISTS(SELECT 1 FROM json_each(?) selected JOIN transfer_archive_template_labels old ON old.archive_id=? AND old.template_key=json_extract(selected.value,'$.templateKey') AND old.name_key=json_extract(selected.value,'$.nameKey') WHERE old.color<>json_extract(selected.value,'$.color'))`,
        [json, id],
      ),
      this.db
        .prepare(
          `INSERT INTO transfer_archive_template_labels(archive_id,template_key,name_key,color)SELECT ?,json_extract(value,'$.templateKey'),json_extract(value,'$.nameKey'),json_extract(value,'$.color') FROM json_each(?)WHERE 1 ON CONFLICT(archive_id,template_key,name_key)DO NOTHING`,
        )
        .bind(id, json),
    ];
  }
  private async references(row: ArchiveValidationRow) {
    const id = row.id,
      header = JSON.parse(row.header_json) as ArchiveHeader;
    const statements = [
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records item LEFT JOIN transfer_archive_records board ON board.archive_id=item.archive_id AND board.item_key=json_extract(item.input_json,'$.boardKey') WHERE item.archive_id=? AND item.kind='list' AND (board.item_key IS NULL OR board.kind<>'board') LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records task LEFT JOIN transfer_archive_records list ON list.archive_id=task.archive_id AND list.item_key=json_extract(task.input_json,'$.listKey') LEFT JOIN transfer_archive_records parent ON parent.archive_id=task.archive_id AND parent.item_key=json_extract(task.input_json,'$.parentKey') WHERE task.archive_id=? AND task.kind='task' AND (list.item_key IS NULL OR list.kind<>'list' OR json_extract(task.input_json,'$.provider.listId')<>json_extract(list.input_json,'$.providerId') OR (json_extract(task.input_json,'$.parentKey') IS NOT NULL AND (parent.item_key IS NULL OR parent.kind<>'task' OR json_extract(parent.input_json,'$.parentKey') IS NOT NULL OR json_extract(parent.input_json,'$.listKey')<>json_extract(task.input_json,'$.listKey') OR json_extract(task.input_json,'$.repeatRule') IS NOT NULL))) LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records task,json_each(task.input_json,'$.dependencies') dependency LEFT JOIN transfer_archive_records target ON target.archive_id=task.archive_id AND target.item_key=json_extract(dependency.value,'$.key') WHERE task.archive_id=? AND task.kind='task' AND (json_extract(dependency.value,'$.key')=task.item_key OR target.item_key IS NOT NULL AND(target.kind<>'task' OR json_extract(target.input_json,'$.provider.id')<>json_extract(dependency.value,'$.provider.id') OR json_extract(target.input_json,'$.provider.listId')<>json_extract(dependency.value,'$.provider.listId')))LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records record WHERE archive_id=? AND kind='list' GROUP BY json_extract(input_json,'$.providerId') HAVING COUNT(*)>1 UNION ALL SELECT 1 FROM transfer_archive_records record WHERE archive_id=? AND kind='task' GROUP BY json_extract(input_json,'$.provider.listId'),json_extract(input_json,'$.provider.id') HAVING COUNT(*)>1 LIMIT 1`,
        )
        .bind(id, id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records schedule LEFT JOIN transfer_archive_records template ON template.archive_id=schedule.archive_id AND template.item_key=json_extract(schedule.input_json,'$.templateKey') LEFT JOIN transfer_archive_records board ON board.archive_id=schedule.archive_id AND board.item_key=json_extract(schedule.input_json,'$.boardKey') WHERE schedule.archive_id=? AND schedule.kind='schedule' AND ((COALESCE(json_extract(schedule.input_json,'$.unmatchedReferences.template'),0)=0 AND(template.item_key IS NULL OR template.kind<>'template' OR json_extract(template.input_json,'$.templateKind')<>json_extract(schedule.input_json,'$.templateKind'))) OR(COALESCE(json_extract(schedule.input_json,'$.unmatchedReferences.board'),0)=0 AND(board.item_key IS NULL OR board.kind<>'board')))LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records child LEFT JOIN transfer_archive_records parent ON parent.archive_id=child.archive_id AND parent.item_key=json_extract(child.input_json,'$.templateKey') WHERE child.archive_id=? AND child.kind IN('template_list','template_task')AND(parent.item_key IS NULL OR parent.kind<>'template')LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records template WHERE template.archive_id=? AND template.kind='template' AND ((SELECT COUNT(*)FROM transfer_archive_records child WHERE child.archive_id=template.archive_id AND child.kind='template_list'AND json_extract(child.input_json,'$.templateKey')=template.item_key)<>json_extract(template.input_json,'$.header.listCount') OR(SELECT COUNT(*)FROM transfer_archive_records child WHERE child.archive_id=template.archive_id AND child.kind='template_task'AND json_extract(child.input_json,'$.templateKey')=template.item_key)<>json_extract(template.input_json,'$.header.taskCount'))LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records child JOIN transfer_archive_records template ON template.archive_id=child.archive_id AND template.item_key=json_extract(child.input_json,'$.templateKey') WHERE child.archive_id=? AND child.kind IN('template_list','template_task') AND(json_extract(child.input_json,'$.value.position')>=CASE child.kind WHEN 'template_list'THEN json_extract(template.input_json,'$.header.listCount')ELSE json_extract(template.input_json,'$.header.taskCount')END OR child.kind='template_task'AND json_extract(template.input_json,'$.header.dateMode')='none'AND(json_extract(child.input_json,'$.value.dayOffset')IS NOT NULL OR json_extract(child.input_json,'$.value.scheduledTime')IS NOT NULL OR json_extract(child.input_json,'$.value.timeZone')IS NOT NULL))UNION ALL SELECT 1 FROM transfer_archive_records WHERE archive_id=? AND kind IN('template_list','template_task')GROUP BY kind,json_extract(input_json,'$.templateKey'),json_extract(input_json,'$.value.key')HAVING COUNT(*)>1 UNION ALL SELECT 1 FROM transfer_archive_records WHERE archive_id=? AND kind IN('template_list','template_task')GROUP BY kind,json_extract(input_json,'$.templateKey'),json_extract(input_json,'$.value.position')HAVING COUNT(*)>1 LIMIT 1`,
        )
        .bind(id, id, id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records task LEFT JOIN transfer_archive_records list ON list.archive_id=task.archive_id AND list.kind='template_list'AND json_extract(list.input_json,'$.templateKey')=json_extract(task.input_json,'$.templateKey')AND json_extract(list.input_json,'$.value.key')=json_extract(task.input_json,'$.value.listKey')LEFT JOIN transfer_archive_records parent ON parent.archive_id=task.archive_id AND parent.kind='template_task'AND json_extract(parent.input_json,'$.templateKey')=json_extract(task.input_json,'$.templateKey')AND json_extract(parent.input_json,'$.value.key')=json_extract(task.input_json,'$.value.parentKey') WHERE task.archive_id=? AND task.kind='template_task'AND(list.item_key IS NULL OR json_extract(task.input_json,'$.value.parentKey')IS NOT NULL AND(parent.item_key IS NULL OR json_extract(parent.input_json,'$.value.parentKey')IS NOT NULL OR json_extract(parent.input_json,'$.value.listKey')<>json_extract(task.input_json,'$.value.listKey')))LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records task,json_each(task.input_json,'$.value.dependencyKeys')dependency LEFT JOIN transfer_archive_records target ON target.archive_id=task.archive_id AND target.kind='template_task'AND json_extract(target.input_json,'$.templateKey')=json_extract(task.input_json,'$.templateKey')AND json_extract(target.input_json,'$.value.key')=dependency.value WHERE task.archive_id=? AND task.kind='template_task'AND(target.item_key IS NULL OR dependency.value=json_extract(task.input_json,'$.value.key'))LIMIT 1`,
        )
        .bind(id),
      this.db
        .prepare(
          `SELECT 1 FROM transfer_archive_records WHERE archive_id=? AND kind='history'GROUP BY json_extract(input_json,'$.event.id')HAVING COUNT(*)>1 LIMIT 1`,
        )
        .bind(id),
    ];
    const results = await this.db.batch(statements);
    if (results.some((result) => result.results.length)) throw invalid();
    const counts = await this.db
      .prepare(
        `SELECT COALESCE(SUM(kind='board'AND json_extract(input_json,'$.isMain')=1),0) AS main,COALESCE(SUM(kind='list'),0)AS lists,COALESCE(SUM(kind='task'),0)AS tasks,COALESCE(SUM(kind='task'AND json_type(input_json,'$.snapshot')='object'),0)AS snapshots FROM transfer_archive_records WHERE archive_id=?`,
      )
      .bind(id)
      .first<{ main: number; lists: number; tasks: number; snapshots: number }>();
    if (
      !counts ||
      (header.scope.kind === 'account' && counts.main !== 1) ||
      (header.includesTaskSnapshots &&
        (counts.tasks > 2000 || counts.lists > 100 || counts.snapshots !== counts.tasks)) ||
      (!header.includesTaskSnapshots && counts.snapshots)
    )
      throw invalid();
    if (
      header.scope.kind === 'board' &&
      !(await this.db
        .prepare(
          "SELECT 1 FROM transfer_archive_records WHERE archive_id=? AND kind='board'AND item_key=?",
        )
        .bind(id, header.scope.boardKey)
        .first())
    )
      throw invalid();
  }
  async initialize(row: ArchiveValidationRow): Promise<void> {
    await this.references(row);
    try {
      await this.db.batch([
        localWriteGuard(this.db, row.account_id),
        this.guard(
          "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='staging'AND revision=? AND validation_revision IS NULL)",
          [row.id, row.revision],
        ),
        this.db
          .prepare(
            `INSERT INTO transfer_archive_graph_nodes(archive_id,scope,node_key,remaining)SELECT ?, 'tasks',task.item_key,(SELECT COUNT(*)FROM json_each(task.input_json,'$.dependencies')dependency JOIN transfer_archive_records target ON target.archive_id=task.archive_id AND target.kind='task'AND target.item_key=json_extract(dependency.value,'$.key'))FROM transfer_archive_records task WHERE task.archive_id=? AND task.kind='task' UNION ALL SELECT ?,'template:'||json_extract(input_json,'$.templateKey'),json_extract(input_json,'$.value.key'),json_array_length(input_json,'$.value.dependencyKeys')FROM transfer_archive_records WHERE archive_id=? AND kind='template_task'`,
          )
          .bind(row.id, row.id, row.id, row.id),
        this.db
          .prepare(
            `INSERT INTO transfer_archive_graph_edges(archive_id,scope,source_key,target_key)SELECT ?,'tasks',task.item_key,json_extract(dependency.value,'$.key')FROM transfer_archive_records task,json_each(task.input_json,'$.dependencies')dependency JOIN transfer_archive_records target ON target.archive_id=task.archive_id AND target.kind='task'AND target.item_key=json_extract(dependency.value,'$.key')WHERE task.archive_id=? AND task.kind='task'UNION ALL SELECT ?,'template:'||json_extract(task.input_json,'$.templateKey'),json_extract(task.input_json,'$.value.key'),dependency.value FROM transfer_archive_records task,json_each(task.input_json,'$.value.dependencyKeys')dependency WHERE task.archive_id=? AND task.kind='template_task'`,
          )
          .bind(row.id, row.id, row.id, row.id),
        this.db
          .prepare(
            'UPDATE transfer_archives SET validation_revision=revision,graph_remaining=(SELECT COUNT(*)FROM transfer_archive_graph_nodes WHERE archive_id=transfer_archives.id) WHERE id=?',
          )
          .bind(row.id),
      ]);
    } catch (error) {
      const current = await this.db
        .prepare('SELECT validation_revision FROM transfer_archives WHERE id=?')
        .bind(row.id)
        .first<{ validation_revision: number | null }>();
      if (current?.validation_revision !== row.revision) throw error;
    }
  }
  async advance(
    row: ArchiveValidationRow,
  ): Promise<{ done: boolean; hash: string; position: number }> {
    const graphDone = await new CapturedGraphValidator(this.db, 'archive').advance(
      row.id,
      row.account_id,
    );
    const hashes = (
      await this.db
        .prepare(
          'SELECT position,item_key,input_hash FROM transfer_archive_records WHERE archive_id=? AND position>? ORDER BY position LIMIT 100',
        )
        .bind(row.id, row.hash_position)
        .all<{ position: number; item_key: string; input_hash: string }>()
    ).results;
    let hash = row.hash_chain,
      position = row.hash_position;
    for (const record of hashes) {
      hash = await transferDigest(hash + '\n' + canonicalJson(record));
      position = record.position;
    }
    await this.db.batch([
      this.guard(
        "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND state='staging'AND hash_position=? AND hash_chain=? AND validation_revision=revision)",
        [row.id, row.hash_position, row.hash_chain],
      ),
      this.db
        .prepare(
          'UPDATE transfer_archives SET hash_position=?,hash_chain=?,updated_at=? WHERE id=?',
        )
        .bind(position, hash, this.now(), row.id),
    ]);
    return { done: graphDone && position === row.expected_records - 1, hash, position };
  }
}
