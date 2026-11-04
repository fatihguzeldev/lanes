import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { localWriteGuard } from '../../../accounts/server/connections/access';
import { CalendarDateSchema, TimeZoneSchema } from '../../contracts/planning';
import {
  SnapshotPageOptionsSchema,
  SnapshotSummarySchema,
  TemplateApplicationOptionsSchema,
  TemplateColorSchema,
  TemplateListSchema,
  TemplatePageOptionsSchema,
  TemplateTaskSchema,
  type SnapshotPageOptions,
  type SnapshotSummary,
  type TemplateApplicationOptions,
  type TemplateLabelColorConflict,
  type TemplateList,
  type TemplatePageOptions,
  type TemplatePreview,
  type TemplateTask,
} from '../../contracts/template';
import type { CaptureSnapshotOptions, SnapshotSourceList } from './context';
import { cursor, readCursor } from './pagination';
import { guard } from './persistence';
import { id, parse, revision } from './validation';

interface SnapshotRow {
  id: string;
  account_id: string;
  schema_version: number;
  date_mode: string;
  save_day: string;
  zone: string;
  list_count: number;
  task_count: number;
  context_parent_count: number;
  completed_included_count: number;
  omitted_dependency_count: number;
  source_dated_count: number;
  source_timed_count: number;
  source_repeat_count: number;
  created_at: number;
}

interface SourceRow {
  id: string;
  title: string;
  revision: number;
  projection_revision: number;
  tasks_complete_at: number | null;
  completed_complete_at: number | null;
  sync_cursor: string | null;
}

const localCoverage = { complete: true, lastSyncedAt: null, stale: false } as const;

function summary(row: SnapshotRow): SnapshotSummary {
  return SnapshotSummarySchema.parse({
    id: row.id,
    accountId: row.account_id,
    schemaVersion: row.schema_version,
    dateMode: row.date_mode,
    saveDay: row.save_day,
    zone: row.zone,
    listCount: row.list_count,
    taskCount: row.task_count,
    contextParentCount: row.context_parent_count,
    completedIncludedCount: row.completed_included_count,
    omittedDependencyCount: row.omitted_dependency_count,
    sourceDatedCount: row.source_dated_count,
    sourceTimedCount: row.source_timed_count,
    sourceRepeatCount: row.source_repeat_count,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function sourceCte(): string {
  return `WITH source_lists AS (SELECT json_extract(value,'$.sourceListId') AS id,json_extract(value,'$.position') AS list_position,json_extract(value,'$.color') AS color FROM json_each(?)),
    included AS (SELECT task.*,selected.list_position,selected.color FROM tasks_tasks task JOIN source_lists selected ON selected.id=task.list_id
      WHERE task.account_id=? AND task.deleted_at IS NULL AND (?=1 OR task.completed=0 OR EXISTS (SELECT 1 FROM tasks_tasks child WHERE child.account_id=task.account_id AND child.parent_id=task.id AND child.deleted_at IS NULL AND child.completed=0))),
    mapped AS (SELECT included.*,printf('list-%02d',list_position) AS list_key,printf('task-%04d',ROW_NUMBER() OVER (ORDER BY list_position,COALESCE(parent.provider_position,included.provider_position),COALESCE(parent.id,included.id),included.parent_id IS NOT NULL,included.provider_position,included.id)-1) AS item_key,
      ROW_NUMBER() OVER (ORDER BY list_position,COALESCE(parent.provider_position,included.provider_position),COALESCE(parent.id,included.id),included.parent_id IS NOT NULL,included.provider_position,included.id)-1 AS item_position
      FROM included LEFT JOIN tasks_tasks parent ON parent.account_id=included.account_id AND parent.id=included.parent_id)`;
}

/** Owns immutable, provider-free list content shared by personal and board templates. */
export class ListSnapshotStore {
  constructor(private readonly db: D1Database) {}
  async prepareCapture(
    accountId: string,
    input: SnapshotSourceList[],
    options: CaptureSnapshotOptions,
  ): Promise<{
    snapshot: SnapshotSummary;
    writes: D1PreparedStatement[];
    verifySource(): Promise<void>;
  }> {
    parse(id, accountId);
    parse(CalendarDateSchema, options.saveDay);
    parse(TimeZoneSchema, options.zone);
    parse(z.iso.datetime({ offset: true }), options.recordedAt);
    const selected = parse(
      z
        .array(
          z
            .object({
              sourceListId: id,
              revision,
              color: TemplateColorSchema,
              position: z.number().int().min(0).max(99),
            })
            .strict(),
        )
        .max(100),
      input,
    );
    if (
      new Set(selected.map((value) => value.sourceListId)).size !== selected.length ||
      selected.some((value, index) => value.position !== index)
    )
      throw new AppError(
        'validation_failed',
        'capture each source list once in explicit order',
        422,
      );
    const snapshotId = parse(id, options.snapshotId ?? crypto.randomUUID()),
      encoded = JSON.stringify(selected);
    const lists = (
      await this.db
        .prepare(
          "SELECT id,title,revision,projection_revision,tasks_complete_at,completed_complete_at,sync_cursor FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL AND id IN (SELECT json_extract(value,'$.sourceListId') FROM json_each(?))",
        )
        .bind(accountId, encoded)
        .all<SourceRow>()
    ).results;
    if (lists.length !== selected.length)
      throw new AppError(
        'not_found',
        'a selected source list is not retained in this account',
        404,
      );
    if (
      lists.some(
        (row) =>
          row.tasks_complete_at === null ||
          row.completed_complete_at === null ||
          row.sync_cursor !== null ||
          selected.find((value) => value.sourceListId === row.id)?.revision !== row.revision,
      )
    )
      throw new AppError(
        'conflict',
        'refresh complete source list coverage before saving a template',
        409,
      );
    const counts = await this.db
      .prepare(
        `${sourceCte()} SELECT COUNT(*) AS task_count,COALESCE(SUM(completed=1 AND ?=0),0) AS context_parent_count,COALESCE(SUM(completed=1 AND ?=1),0) AS completed_included_count,
      COALESCE(SUM(scheduled_day IS NOT NULL),0) AS source_dated_count,COALESCE(SUM(scheduled_time IS NOT NULL),0) AS source_timed_count,COALESCE(SUM(repeat_rule_json IS NOT NULL),0) AS source_repeat_count,
      (SELECT COUNT(*) FROM tasks_dependencies edge JOIN mapped item ON item.account_id=edge.account_id AND item.id=edge.task_id WHERE NOT EXISTS (SELECT 1 FROM mapped blocker WHERE blocker.id=edge.blocker_id)) AS omitted_dependency_count,
      COALESCE(SUM(unsupported_hierarchy=1 OR provider_missing_at IS NOT NULL OR length(trim(title))=0 OR length(title)>1024 OR length(notes)>8192 OR (parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mapped parent WHERE parent.id=mapped.parent_id AND parent.list_id=mapped.list_id AND parent.parent_id IS NULL))),0) AS invalid_count FROM mapped`,
      )
      .bind(
        encoded,
        accountId,
        Number(options.includeCompleted),
        Number(options.includeCompleted),
        Number(options.includeCompleted),
      )
      .first<{
        task_count: number;
        context_parent_count: number;
        completed_included_count: number;
        source_dated_count: number;
        source_timed_count: number;
        source_repeat_count: number;
        omitted_dependency_count: number;
        invalid_count: number;
      }>();
    if (!counts || counts.task_count > 2000)
      throw new AppError(
        'validation_failed',
        'one template captures at most 2,000 tasks including subtasks; choose a smaller source',
        422,
      );
    if (counts.invalid_count)
      throw new AppError(
        'validation_failed',
        'a selected task has an unresolved provider address, unsupported hierarchy or invalid title/notes',
        422,
      );
    const checkpoint = JSON.stringify(
      lists.map((row) => ({
        id: row.id,
        revision: row.revision,
        projectionRevision: row.projection_revision,
      })),
    );
    const graphRevision = await this.db
      .prepare('SELECT graph_revision FROM tasks_account_state WHERE account_id=?')
      .bind(accountId)
      .first<number>('graph_revision');
    const value = SnapshotSummarySchema.parse({
      id: snapshotId,
      accountId,
      schemaVersion: 1,
      dateMode: options.dateMode,
      saveDay: options.saveDay,
      zone: options.zone,
      listCount: selected.length,
      taskCount: counts.task_count,
      contextParentCount: counts.context_parent_count,
      completedIncludedCount: counts.completed_included_count,
      omittedDependencyCount: counts.omitted_dependency_count,
      sourceDatedCount: counts.source_dated_count,
      sourceTimedCount: counts.source_timed_count,
      sourceRepeatCount: counts.source_repeat_count,
      createdAt: options.recordedAt,
    });
    const sourcePredicate = `NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN tasks_lists list ON list.account_id=? AND list.id=json_extract(expected.value,'$.id') WHERE list.id IS NULL OR list.deleted_at IS NOT NULL OR list.revision<>json_extract(expected.value,'$.revision') OR list.projection_revision<>json_extract(expected.value,'$.projectionRevision') OR list.tasks_complete_at IS NULL OR list.completed_complete_at IS NULL OR list.sync_cursor IS NOT NULL) AND EXISTS (SELECT 1 FROM tasks_account_state WHERE account_id=? AND graph_revision=?)`;
    const sourceBindings = [checkpoint, accountId, accountId, graphRevision];
    const writes = [
      localWriteGuard(this.db, accountId),
      ...(options.guardWrites ?? []),
      guard(this.db, sourcePredicate, sourceBindings),
      this.db
        .prepare(
          'INSERT INTO tasks_template_snapshots(id,account_id,schema_version,date_mode,save_day,zone,list_count,task_count,context_parent_count,completed_included_count,omitted_dependency_count,source_dated_count,source_timed_count,source_repeat_count,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          snapshotId,
          accountId,
          options.dateMode,
          options.saveDay,
          options.zone,
          selected.length,
          counts.task_count,
          counts.context_parent_count,
          counts.completed_included_count,
          counts.omitted_dependency_count,
          counts.source_dated_count,
          counts.source_timed_count,
          counts.source_repeat_count,
          Date.parse(options.recordedAt),
        ),
      this.db
        .prepare(
          `INSERT INTO tasks_template_lists(snapshot_id,item_key,position,title,color) SELECT ?,printf('list-%02d',json_extract(selected.value,'$.position')),json_extract(selected.value,'$.position'),list.title,json_extract(selected.value,'$.color') FROM json_each(?) selected JOIN tasks_lists list ON list.account_id=? AND list.id=json_extract(selected.value,'$.sourceListId')`,
        )
        .bind(snapshotId, encoded, accountId),
      this.db
        .prepare(
          `${sourceCte()} INSERT INTO tasks_template_nodes(snapshot_id,item_key,position,list_key,parent_key,content_json)
        SELECT ?,item_key,item_position,list_key,(SELECT item_key FROM mapped parent WHERE parent.id=item.parent_id),json_object(
          'key',item_key,'listKey',list_key,'parentKey',(SELECT item_key FROM mapped parent WHERE parent.id=item.parent_id),'position',item_position,'title',title,'notes',notes,
          'dayOffset',CASE WHEN ?='relative' AND scheduled_day IS NOT NULL THEN CAST(julianday(scheduled_day)-julianday(?) AS INTEGER) ELSE NULL END,
          'scheduledTime',CASE WHEN ?='relative' THEN scheduled_time ELSE NULL END,'timeZone',CASE WHEN ?='relative' THEN time_zone ELSE NULL END,
          'repeatPreset',CASE WHEN repeat_rule_json IS NULL THEN NULL ELSE json_object('frequency',json_extract(repeat_rule_json,'$.frequency'),'interval',json_extract(repeat_rule_json,'$.interval'),'zone',json_extract(repeat_rule_json,'$.zone'),'weekStart',json_extract(repeat_rule_json,'$.weekStart'),'weekdays',json_extract(repeat_rule_json,'$.weekdays'),'end',CASE json_extract(repeat_rule_json,'$.end.type') WHEN 'date' THEN json_object('type','date','offsetDays',CAST(julianday(json_extract(repeat_rule_json,'$.end.day'))-julianday(?) AS INTEGER)) ELSE json_extract(repeat_rule_json,'$.end') END) END,
          'labels',json(COALESCE((SELECT json_group_array(json_object('name',label.name,'color',label.color)) FROM tasks_task_labels association JOIN tasks_labels label ON label.account_id=association.account_id AND label.id=association.label_id WHERE association.account_id=item.account_id AND association.task_id=item.id),'[]')),
          'priority',priority,'starred',json(CASE WHEN starred=1 THEN 'true' ELSE 'false' END),
          'dependencyKeys',json(COALESCE((SELECT json_group_array(blocker.item_key) FROM tasks_dependencies edge JOIN mapped blocker ON blocker.account_id=edge.account_id AND blocker.id=edge.blocker_id WHERE edge.account_id=item.account_id AND edge.task_id=item.id),'[]')))
        FROM mapped item`,
        )
        .bind(
          encoded,
          accountId,
          Number(options.includeCompleted),
          snapshotId,
          options.dateMode,
          options.saveDay,
          options.dateMode,
          options.dateMode,
          options.saveDay,
        ),
      this.db
        .prepare(
          `${sourceCte()} INSERT INTO tasks_template_label_definitions(snapshot_id,name_key,name,color) SELECT DISTINCT ?,label.name_key,label.name,label.color FROM mapped item JOIN tasks_task_labels association ON association.account_id=item.account_id AND association.task_id=item.id JOIN tasks_labels label ON label.account_id=association.account_id AND label.id=association.label_id`,
        )
        .bind(encoded, accountId, Number(options.includeCompleted), snapshotId),
    ];
    return {
      snapshot: value,
      writes,
      verifySource: async () => {
        if (
          await this.db
            .prepare(`SELECT 1 WHERE NOT (${sourcePredicate})`)
            .bind(...sourceBindings)
            .first()
        )
          throw new AppError(
            'conflict',
            'the source changed during snapshot capture; refresh its preview',
            409,
          );
      },
    };
  }
  async get(accountId: string, snapshotId: string): Promise<SnapshotSummary> {
    parse(id, accountId);
    parse(id, snapshotId);
    const row = await this.db
      .prepare('SELECT * FROM tasks_template_snapshots WHERE account_id=? AND id=? AND sealed=1')
      .bind(accountId, snapshotId)
      .first<SnapshotRow>();
    if (!row)
      throw new AppError('not_found', 'this captured template content is no longer available', 404);
    return summary(row);
  }
  async previewApplication(
    accountId: string,
    snapshotId: string,
    input: TemplateApplicationOptions,
  ): Promise<TemplatePreview> {
    const options = parse(TemplateApplicationOptionsSchema, input),
      snapshot = await this.get(accountId, snapshotId);
    const prefix = options.listPrefix ? options.listPrefix + ' ' : '';
    const invalid = await this.db
      .prepare(
        'SELECT 1 FROM tasks_template_lists WHERE snapshot_id=? AND (length(?||title)>1024 OR length(trim(?||title))=0) LIMIT 1',
      )
      .bind(snapshotId, prefix, prefix)
      .first();
    if (invalid)
      throw new AppError(
        'validation_failed',
        'the list prefix produces an empty or over-limit list title',
        422,
      );
    const rows = await this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(content_json,'$.dayOffset') IS NOT NULL),0) AS dated,COALESCE(SUM(json_extract(content_json,'$.scheduledTime') IS NOT NULL AND json_extract(content_json,'$.dayOffset') IS NOT NULL),0) AS timed,
      COALESCE(SUM(json_extract(content_json,'$.repeatPreset') IS NOT NULL AND json_extract(content_json,'$.dayOffset') IS NOT NULL AND (json_extract(content_json,'$.repeatPreset.end.type')<>'date' OR json_extract(content_json,'$.repeatPreset.end.offsetDays')>=json_extract(content_json,'$.dayOffset'))),0) AS repeated,
      COALESCE(SUM(json_extract(content_json,'$.dayOffset')<0),0) AS negative,
      (SELECT COUNT(*) FROM tasks_template_label_definitions WHERE snapshot_id=?) AS labels,
      (SELECT COUNT(*) FROM tasks_template_label_definitions definition JOIN tasks_labels destination ON destination.account_id=? AND destination.name_key=definition.name_key WHERE definition.snapshot_id=? AND definition.color<>destination.color) AS color_conflicts FROM tasks_template_nodes WHERE snapshot_id=?`,
      )
      .bind(snapshotId, accountId, snapshotId, snapshotId)
      .first<{
        dated: number;
        timed: number;
        repeated: number;
        negative: number;
        labels: number;
        color_conflicts: number;
      }>();
    return {
      labelDefinitionCount: rows?.labels ?? 0,
      labelColorConflictCount: rows?.color_conflicts ?? 0,
      listCount: snapshot.listCount,
      taskCount: snapshot.taskCount,
      requiredListSlots: snapshot.listCount,
      omittedDependencyCount: snapshot.omittedDependencyCount,
      omittedDates: snapshot.sourceDatedCount - (options.useRelativeDates ? (rows?.dated ?? 0) : 0),
      omittedTimes: snapshot.sourceTimedCount - (options.useRelativeDates ? (rows?.timed ?? 0) : 0),
      omittedRepeatRules:
        snapshot.sourceRepeatCount - (options.useRelativeDates ? (rows?.repeated ?? 0) : 0),
      negativeDateCount: options.useRelativeDates ? (rows?.negative ?? 0) : 0,
    };
  }
  async listLabelColorConflicts(
    accountId: string,
    snapshotId: string,
    input: TemplatePageOptions = {},
  ): Promise<Page<TemplateLabelColorConflict>> {
    await this.get(accountId, snapshotId);
    const options = parse(TemplatePageOptionsSchema, input),
      scope = { accountId, snapshotId, kind: 'label-color-conflicts' };
    const after = options.cursor ? readCursor(options.cursor, scope).id : '';
    const rows = (
      await this.db
        .prepare(
          'SELECT definition.name_key,definition.name,definition.color AS requested_color,destination.color AS kept_color FROM tasks_template_label_definitions definition JOIN tasks_labels destination ON destination.account_id=? AND destination.name_key=definition.name_key WHERE definition.snapshot_id=? AND definition.name_key>? AND definition.color<>destination.color ORDER BY definition.name_key LIMIT ?',
        )
        .bind(accountId, snapshotId, after, options.limit + 1)
        .all<{
          name_key: string;
          name: string;
          requested_color: string;
          kept_color: string;
        }>()
    ).results;
    const selected = rows.slice(0, options.limit),
      last = selected.at(-1);
    return {
      items: selected.map((row) => ({
        name: row.name,
        requestedColor: row.requested_color,
        keptColor: row.kept_color,
      })),
      nextCursor:
        rows.length > options.limit && last
          ? cursor({ ...scope, position: 0, id: last.name_key })
          : null,
      coverage: localCoverage,
    };
  }
  async getMany(accountId: string, snapshotIds: string[]): Promise<SnapshotSummary[]> {
    parse(id, accountId);
    parse(z.array(id).max(100), snapshotIds);
    const rows = (
      await this.db
        .prepare(
          'SELECT * FROM tasks_template_snapshots WHERE account_id=? AND sealed=1 AND id IN (SELECT value FROM json_each(?))',
        )
        .bind(accountId, JSON.stringify(snapshotIds))
        .all<SnapshotRow>()
    ).results;
    return rows.map(summary);
  }
  /** Account lifecycle only: the coordinator fences work and removes board-owned
   * versions before this slice. Every deleted parent has no remaining children. */
  async removeAccountSlice(
    accountId: string,
    limit = 100,
  ): Promise<{
    done: boolean;
    deleted: number;
  }> {
    parse(id, accountId);
    parse(z.number().int().min(1).max(100), limit);
    let remaining = limit,
      deleted = 0;
    const selections = [
      ...[
        'tasks_template_graph_edges',
        'tasks_template_graph_nodes',
        'tasks_template_validation',
      ].map((table) => ({
        table,
        where: 'snapshot_id IN (SELECT id FROM tasks_template_snapshots WHERE account_id=?)',
      })),
      {
        table: 'tasks_template_documents',
        where: 'snapshot_id IN (SELECT id FROM tasks_template_snapshots WHERE account_id=?)',
      },
      { table: 'tasks_template_snapshot_pins', where: 'account_id=?' },
      {
        table: 'tasks_list_template_versions',
        where: 'template_id IN (SELECT id FROM tasks_list_templates WHERE account_id=?)',
      },
      {
        table: 'tasks_list_templates',
        where:
          'account_id=? AND NOT EXISTS (SELECT 1 FROM tasks_list_template_versions version WHERE version.template_id=tasks_list_templates.id)',
      },
      {
        table: 'tasks_template_nodes',
        where: 'snapshot_id IN (SELECT id FROM tasks_template_snapshots WHERE account_id=?)',
      },
      {
        table: 'tasks_template_label_definitions',
        where: 'snapshot_id IN (SELECT id FROM tasks_template_snapshots WHERE account_id=?)',
      },
      {
        table: 'tasks_template_lists',
        where:
          'snapshot_id IN (SELECT id FROM tasks_template_snapshots WHERE account_id=?) AND NOT EXISTS (SELECT 1 FROM tasks_template_nodes node WHERE node.snapshot_id=tasks_template_lists.snapshot_id AND node.list_key=tasks_template_lists.item_key)',
      },
      {
        table: 'tasks_template_snapshots',
        where:
          'account_id=? AND NOT EXISTS (SELECT 1 FROM tasks_template_nodes node WHERE node.snapshot_id=tasks_template_snapshots.id) AND NOT EXISTS (SELECT 1 FROM tasks_template_lists list WHERE list.snapshot_id=tasks_template_snapshots.id) AND NOT EXISTS (SELECT 1 FROM tasks_template_snapshot_pins pin WHERE pin.snapshot_id=tasks_template_snapshots.id) AND NOT EXISTS (SELECT 1 FROM tasks_template_label_definitions definition WHERE definition.snapshot_id=tasks_template_snapshots.id)',
      },
    ];
    for (const selection of selections) {
      if (!remaining) break;
      const result = await this.db
        .prepare(
          `DELETE FROM ${selection.table} WHERE rowid IN (SELECT rowid FROM ${selection.table} WHERE ${selection.where} LIMIT ?)`,
        )
        .bind(accountId, remaining)
        .run();
      deleted += result.meta.changes;
      remaining -= result.meta.changes;
    }
    const pending = await this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM tasks_template_snapshots WHERE account_id=?) OR EXISTS (SELECT 1 FROM tasks_list_templates WHERE account_id=?) OR EXISTS (SELECT 1 FROM tasks_template_snapshot_pins WHERE account_id=?)`,
      )
      .bind(accountId, accountId, accountId)
      .first();
    return { done: !pending, deleted };
  }
  /** Retired content is removed in bounded chunks after headers and run pins release it. */
  async cleanup(limit = 100): Promise<{
    nodes: number;
    snapshots: number;
  }> {
    parse(z.number().int().min(1).max(100), limit);
    const orphan = `NOT EXISTS (SELECT 1 FROM tasks_template_snapshot_pins pin WHERE pin.snapshot_id=snapshot.id) AND NOT EXISTS (SELECT 1 FROM tasks_list_template_versions version WHERE version.snapshot_id=snapshot.id)`;
    let nodes = 0,
      snapshots = 0;
    const tables = [
      { name: 'tasks_template_graph_edges', graph: true },
      { name: 'tasks_template_graph_nodes', graph: true },
      { name: 'tasks_template_validation', graph: true },
      { name: 'tasks_template_nodes' },
      { name: 'tasks_template_label_definitions' },
      { name: 'tasks_template_documents' },
      { name: 'tasks_template_lists' },
      { name: 'tasks_template_snapshots' },
    ];
    const branches = tables.map((table, position) => {
      const scope = table.name === 'tasks_template_snapshots' ? 'body.id' : 'body.snapshot_id';
      const ready = table.graph ? `(snapshot.sealed=1 OR (${orphan}))` : `(${orphan})`;
      const children =
        table.name === 'tasks_template_lists'
          ? 'AND NOT EXISTS(SELECT 1 FROM tasks_template_nodes node WHERE node.snapshot_id=snapshot.id)'
          : table.name === 'tasks_template_snapshots'
            ? `AND NOT EXISTS(SELECT 1 FROM tasks_template_nodes node WHERE node.snapshot_id=snapshot.id) AND NOT EXISTS(SELECT 1 FROM tasks_template_lists list WHERE list.snapshot_id=snapshot.id) AND NOT EXISTS(SELECT 1 FROM tasks_template_label_definitions definition WHERE definition.snapshot_id=snapshot.id) AND NOT EXISTS(SELECT 1 FROM tasks_template_documents document WHERE document.snapshot_id=snapshot.id) AND NOT EXISTS(SELECT 1 FROM tasks_template_validation validation WHERE validation.snapshot_id=snapshot.id) AND NOT EXISTS(SELECT 1 FROM tasks_template_graph_nodes node WHERE node.snapshot_id=snapshot.id) AND NOT EXISTS(SELECT 1 FROM tasks_template_graph_edges edge WHERE edge.snapshot_id=snapshot.id)`
            : '';
      return `SELECT ${position} AS position,row_id FROM(SELECT body.rowid AS row_id FROM ${table.name} body JOIN tasks_template_snapshots snapshot ON snapshot.id=${scope} WHERE ${ready} ${children} ORDER BY snapshot.created_at,body.rowid LIMIT ?)`;
    });
    const selected = (
      await this.db
        .prepare(
          `SELECT position,row_id FROM(${branches.join(' UNION ALL ')}) ORDER BY position,row_id LIMIT ?`,
        )
        .bind(...tables.map(() => limit), limit)
        .all<{ position: number; row_id: number }>()
    ).results;
    const writes: D1PreparedStatement[] = [],
      positions: number[] = [];
    for (let position = 0; position < tables.length; position++) {
      const rowIds = selected.filter((row) => row.position === position).map((row) => row.row_id);
      if (!rowIds.length) continue;
      positions.push(position);
      writes.push(
        this.db
          .prepare(
            `DELETE FROM ${tables[position]!.name} WHERE rowid IN(SELECT value FROM json_each(?))`,
          )
          .bind(JSON.stringify(rowIds)),
      );
    }
    if (writes.length) {
      const result = await this.db.batch(writes);
      for (let i = 0; i < result.length; i++) {
        const name = tables[positions[i]!]!.name;
        if (name === 'tasks_template_nodes') nodes += result[i]!.meta.changes;
        if (name === 'tasks_template_snapshots') snapshots += result[i]!.meta.changes;
      }
    }

    return { nodes, snapshots };
  }

  async listLists(
    accountId: string,
    snapshotId: string,
    input: SnapshotPageOptions = {},
  ): Promise<Page<TemplateList>> {
    await this.get(accountId, snapshotId);
    const options = parse(SnapshotPageOptionsSchema, input),
      scope = { accountId, snapshotId, kind: 'lists' };
    const after = options.cursor ? readCursor(options.cursor, scope).position : -1;
    const rows = (
      await this.db
        .prepare(
          'SELECT item_key,position,title,color FROM tasks_template_lists WHERE snapshot_id=? AND position>? ORDER BY position LIMIT ?',
        )
        .bind(snapshotId, after, options.limit + 1)
        .all<{
          item_key: string;
          position: number;
          title: string;
          color: string;
        }>()
    ).results;
    const selected = rows.slice(0, options.limit),
      last = selected.at(-1);
    return {
      items: selected.map((value) =>
        TemplateListSchema.parse({
          key: value.item_key,
          position: value.position,
          title: value.title,
          color: value.color,
        }),
      ),
      nextCursor:
        rows.length > options.limit && last ? cursor({ ...scope, position: last.position }) : null,
      coverage: localCoverage,
    };
  }
  async listTasks(
    accountId: string,
    snapshotId: string,
    input: SnapshotPageOptions = {},
  ): Promise<Page<TemplateTask>> {
    await this.get(accountId, snapshotId);
    const options = parse(SnapshotPageOptionsSchema, input),
      scope = { accountId, snapshotId, kind: 'tasks' };
    const after = options.cursor ? readCursor(options.cursor, scope).position : -1;
    const rows = (
      await this.db
        .prepare(
          'SELECT position,content_json FROM tasks_template_nodes WHERE snapshot_id=? AND position>? ORDER BY position LIMIT ?',
        )
        .bind(snapshotId, after, options.limit + 1)
        .all<{
          position: number;
          content_json: string;
        }>()
    ).results;
    const items: TemplateTask[] = [];
    let last = after;
    for (const row of rows.slice(0, options.limit)) {
      const value = TemplateTaskSchema.parse(JSON.parse(row.content_json));
      if (new TextEncoder().encode(JSON.stringify([...items, value])).byteLength > 60000) {
        if (!items.length)
          throw new AppError(
            'validation_failed',
            'one captured task exceeds the bounded copy payload; reduce that task before applying it',
            422,
          );
        break;
      }
      items.push(value);
      last = row.position;
    }
    return {
      items,
      nextCursor: rows.some((row) => row.position > last)
        ? cursor({ ...scope, position: last })
        : null,
      coverage: localCoverage,
    };
  }
  pinWrite(accountId: string, snapshotId: string, ownerKey: string): D1PreparedStatement {
    parse(id, accountId);
    parse(id, snapshotId);
    parse(id, ownerKey);
    return this.db
      .prepare(
        'INSERT INTO tasks_template_snapshot_pins(account_id,snapshot_id,owner_key) VALUES (?,?,?) ON CONFLICT(snapshot_id,owner_key) DO NOTHING',
      )
      .bind(accountId, snapshotId, ownerKey);
  }
  releasePinsByOwnerPrefixWrite(accountId: string, ownerPrefix: string): D1PreparedStatement {
    parse(id, accountId);
    parse(id, ownerPrefix);
    return this.db
      .prepare(
        'DELETE FROM tasks_template_snapshot_pins WHERE account_id=? AND substr(owner_key,1,length(?))=?',
      )
      .bind(accountId, ownerPrefix, ownerPrefix);
  }
  releasePinWrite(accountId: string, snapshotId: string, ownerKey: string): D1PreparedStatement {
    return this.db
      .prepare(
        'DELETE FROM tasks_template_snapshot_pins WHERE account_id=? AND snapshot_id=? AND owner_key=?',
      )
      .bind(accountId, snapshotId, ownerKey);
  }
}
