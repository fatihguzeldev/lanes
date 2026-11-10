import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { Coverage } from '../../../../shared/contracts/http';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { CalendarDateSchema } from '../../contracts/planning';
import {
  TaskDependantSchema,
  TaskDependantsQuerySchema,
  TaskExportQuerySchema,
  TaskQuerySchema,
  type TaskDependant,
  type TaskDependantsPage,
  type TaskDependantsQueryInput,
  type TaskExportPage,
  type TaskExportQueryInput,
  type TaskPage,
  type TaskQuery,
  type TaskQueryInput,
} from '../../contracts/query';
import { TaskCapabilitiesSchema, TaskSchema, type Task, type TaskSort } from '../../contracts/task';
import { normalizeTaskSearchText, sortTasks } from '../../model/task';
import type { TaskQueriesOptions, TaskQueryContext } from './context';
import { LabelQueries } from './labels';
import { decodeCursor, encodeCursor, fingerprint, parse, readIdsSchema } from './pagination';
import { readProjectionFirst, readProjectionRows } from './read';

const scopeRevisionSql =
  '(SELECT json_group_array(json_array(id,projection_revision,query_revision)) FROM (SELECT id,projection_revision,query_revision FROM scoped_lists ORDER BY id))';
const pageRevisionSql =
  '(SELECT json_group_array(json_array(id,query_revision)) FROM (SELECT id,query_revision FROM scoped_lists ORDER BY id))';

interface CoverageRow {
  inventory: number | null;
  inventory_cursor: string | null;
  n: number;
  partial: number;
  synced: number | null;
  order_ready_list_ids?: string;
  selection_revision?: string;
}
interface SummaryRow {
  id: string;
  open: number;
  total: number;
  complete: number;
}

interface SqlScope {
  sql: string;
  bindings: (string | number)[];
}

interface Candidate {
  id: string;
  revision: number;
  parent_id: string | null;
  context_id: string | null;
  root_id: string;
  root_revision: number;
  estimated: number;
  parent_estimated: number;
}

interface TaskRow {
  order_ready: number;
  id: string;
  account_id: string;
  list_id: string;
  parent_id: string | null;
  provider_id: string;
  provider_list_id: string;
  provider_etag: string | null;
  provider_position: string | null;
  provider_updated_at: string | null;
  title: string;
  notes: string;
  completed: number;
  completed_at: string | null;
  scheduled_day: string | null;
  scheduled_time: string | null;
  time_zone: string | null;
  repeat_rule_json: string | null;
  series_id: string | null;
  occurrence_id: string | null;
  priority: string;
  starred: number;
  capabilities_json: string;
  unsupported_hierarchy: number;
  provider_missing_at: number | null;
  revision: number;
  label_ids_json: string;
  blocker_ids_json: string;
}

const pageByteBudget = 192 * 1024;

function mapTask(row: TaskRow): Task {
  try {
    const restricted = row.unsupported_hierarchy === 1;
    const capabilities = TaskCapabilitiesSchema.parse({
      canEdit: !restricted,
      canEditNotes: !restricted,
      canMove: !restricted,
      canDelete: !restricted,
      canHaveChildren: !restricted,
      canNest: !restricted,
      assignmentSource: null,
      sourceUrl: null,
      restriction: restricted ? 'the provider hierarchy cannot be safely edited in lanes' : null,
      ...JSON.parse(row.capabilities_json),
    });
    return TaskSchema.parse({
      id: row.id,
      accountId: row.account_id,
      listId: row.list_id,
      parentId: row.parent_id,
      title: row.title,
      notes: row.notes,
      completed: row.completed === 1,
      completedAt: row.completed_at,
      scheduledDay: row.scheduled_day,
      scheduledTime: row.scheduled_time,
      timeZone: row.time_zone,
      repeatRule: row.repeat_rule_json === null ? null : JSON.parse(row.repeat_rule_json),
      seriesId: row.series_id,
      occurrenceId: row.occurrence_id,
      labelIds: JSON.parse(row.label_ids_json),
      blockedBy: JSON.parse(row.blocker_ids_json),
      priority: row.priority,
      starred: row.starred === 1,
      revision: row.revision,
      provider: {
        id: row.provider_id,
        listId: row.provider_list_id,
        etag: row.provider_etag,
        position: row.provider_position,
        updatedAt: row.provider_updated_at,
        missing: row.provider_missing_at !== null,
      },
      capabilities,
      unsupportedHierarchy: restricted,
    });
  } catch {
    throw new AppError('storage_unavailable', 'stored task data could not be read safely', 503);
  }
}

const blockerJoin = 'b.account_id=d.account_id AND b.id=d.blocker_id';

const openBlocker = `EXISTS (SELECT 1 FROM tasks_dependencies d JOIN tasks_tasks b ON ${blockerJoin} WHERE d.account_id=t.account_id AND d.task_id=t.id AND b.deleted_at IS NULL AND b.provider_missing_at IS NULL AND b.completed=0)`;

const missingBlocker = `EXISTS (SELECT 1 FROM tasks_dependencies d LEFT JOIN tasks_tasks b ON ${blockerJoin} WHERE d.account_id=t.account_id AND d.task_id=t.id AND (b.id IS NULL OR (b.deleted_at IS NULL AND b.provider_missing_at IS NOT NULL)))`;

function filterSql(
  query: TaskQuery,
  today: string,
): { sql: string; bindings: (string | number)[] } {
  const where = ['t.deleted_at IS NULL'];
  const bindings: (string | number)[] = [];
  if (query.parentId !== undefined) {
    where.push(query.parentId === null ? 't.parent_id IS NULL' : 't.parent_id=?');
    if (query.parentId !== null) bindings.push(query.parentId);
  }
  const filter = query.filter;
  if ((filter.completion ?? 'open') !== 'all') {
    where.push('t.completed=?');
    bindings.push(filter.completion === 'completed' ? 1 : 0);
  }
  const search = normalizeTaskSearchText(query.query).trim();
  if (search) {
    where.push(`(instr(t.search_text,?)>0 OR instr(l.title_key,?)>0 OR instr(COALESCE(p.title_key,''),?)>0 OR EXISTS (
      SELECT 1 FROM tasks_task_labels tl JOIN tasks_labels label ON label.account_id=tl.account_id AND label.id=tl.label_id
      WHERE tl.account_id=t.account_id AND tl.task_id=t.id AND instr(label.name_key,?)>0))`);
    bindings.push(search, search, search, search);
  }
  if (filter.labelIds?.length) {
    where.push(
      filter.labelMatch === 'all'
        ? 'NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (SELECT 1 FROM tasks_task_labels tl WHERE tl.account_id=t.account_id AND tl.task_id=t.id AND tl.label_id=selected.value))'
        : 'EXISTS (SELECT 1 FROM tasks_task_labels tl WHERE tl.account_id=t.account_id AND tl.task_id=t.id AND tl.label_id IN (SELECT value FROM json_each(?)))',
    );
    bindings.push(JSON.stringify(filter.labelIds));
  }
  if (filter.priorities?.length) {
    where.push('t.priority IN (SELECT value FROM json_each(?))');
    bindings.push(JSON.stringify(filter.priorities));
  }
  if (filter.starred !== undefined) {
    where.push('t.starred=?');
    bindings.push(filter.starred ? 1 : 0);
  }
  if (filter.dependencyStates?.length)
    where.push(
      `(${filter.dependencyStates.map((state) => (state === 'blocked' ? openBlocker : state === 'unknown' ? `(NOT ${openBlocker} AND ${missingBlocker})` : `(NOT ${openBlocker} AND NOT ${missingBlocker})`)).join(' OR ')})`,
    );
  if (filter.scheduled?.kind === 'none') where.push('t.scheduled_day IS NULL');
  else if (filter.scheduled?.kind === 'today') {
    where.push('t.scheduled_day=?');
    bindings.push(today);
  } else if (filter.scheduled?.kind === 'overdue') {
    where.push('t.completed=0 AND t.scheduled_day<?');
    bindings.push(today);
  } else if (filter.scheduled?.kind === 'range') {
    where.push('t.scheduled_day>=? AND t.scheduled_day<=?');
    bindings.push(filter.scheduled.from, filter.scheduled.to);
  }
  return { sql: where.join(' AND '), bindings };
}

function orderKeys(sort: TaskSort): string[] {
  const root = (field: string) =>
    `(CASE WHEN p.id IS NOT NULL THEN p.${field} ELSE t.${field} END)`;
  const position = (expression: string) => [
    `CASE WHEN ${expression} IS NULL THEN 1 ELSE 0 END`,
    `COALESCE(${expression},'')`,
  ];
  const selected = (expression: (field: string) => string): string[] => {
    if (sort === 'title') return [expression('title_key')];
    if (sort === 'scheduled')
      return [
        `COALESCE(${expression('scheduled_day')},'9999-12-31')`,
        `COALESCE(${expression('scheduled_time')},'')`,
      ];
    if (sort === 'updated')
      return [`-COALESCE(julianday(${expression('provider_updated_at')}),-1e100)`];
    if (sort === 'priority')
      return [
        `CASE ${expression('priority')} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`,
      ];
    return [];
  };
  return [
    't.list_id',
    ...selected(root),
    ...position(root('provider_position')),
    root('id'),
    'CASE WHEN p.id IS NULL THEN 0 ELSE 1 END',
    ...selected((field) => `t.${field}`),
    ...position('t.provider_position'),
    't.id',
  ];
}

function estimate(alias: 't' | 'p'): string {
  const textFields = [
    'id',
    'account_id',
    'list_id',
    'parent_id',
    'provider_id',
    'provider_etag',
    'provider_position',
    'provider_updated_at',
    'title',
    'notes',
    'scheduled_day',
    'scheduled_time',
    'time_zone',
    'repeat_rule_json',
    'series_id',
    'occurrence_id',
    'capabilities_json',
  ];
  const bytes = textFields
    .map((field) => `length(CAST(COALESCE(${alias}.${field},'') AS BLOB))`)
    .join('+');
  return `(2048+6*(${bytes}+COALESCE((SELECT SUM(length(CAST(label_id AS BLOB))+4) FROM tasks_task_labels meta WHERE meta.account_id=${alias}.account_id AND meta.task_id=${alias}.id),0)+COALESCE((SELECT SUM(length(CAST(blocker_id AS BLOB))+4) FROM tasks_dependencies meta WHERE meta.account_id=${alias}.account_id AND meta.task_id=${alias}.id),0)))`;
}

const taskFields = `t.id,t.account_id,t.list_id,t.parent_id,t.provider_id,t.provider_etag,t.provider_position,t.provider_updated_at,
 CASE WHEN l.tasks_complete_at IS NOT NULL AND l.completed_complete_at IS NOT NULL AND l.sync_cursor IS NULL AND l.provider_missing_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM tasks_sync_list_work order_work WHERE order_work.account_id=l.account_id AND order_work.list_id=l.id AND order_work.mode='full') THEN 1 ELSE 0 END AS order_ready,
 t.title,t.notes,t.completed,t.completed_at,t.scheduled_day,t.scheduled_time,t.time_zone,t.repeat_rule_json,t.series_id,t.occurrence_id,
 t.priority,t.starred,t.capabilities_json,t.unsupported_hierarchy,t.provider_missing_at,t.revision,l.provider_id AS provider_list_id,
 COALESCE((SELECT json_group_array(label_id) FROM tasks_task_labels tl WHERE tl.account_id=t.account_id AND tl.task_id=t.id),'[]') AS label_ids_json,
 COALESCE((SELECT json_group_array(d.blocker_id) FROM tasks_dependencies d LEFT JOIN tasks_tasks b ON ${blockerJoin}
   WHERE d.account_id=t.account_id AND d.task_id=t.id AND (b.id IS NULL OR b.deleted_at IS NULL)),'[]') AS blocker_ids_json`;

export class TaskQueries {
  readonly labels: LabelQueries;
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskQueriesOptions = {},
  ) {
    this.labels = new LabelQueries(db);
  }

  private async assertSelectedLists(accountId: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const row = await readProjectionFirst<{ n: number }>(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(ids)),
    );
    if (row?.n !== new Set(ids).size)
      throw new AppError('not_found', 'a selected list is not available in this account', 404);
  }

  private async scope(accountId: string, query: TaskQuery): Promise<SqlScope> {
    const where = ['l.account_id=?', 'l.deleted_at IS NULL'];
    const bindings: (string | number)[] = [accountId];
    for (const selected of [
      query.listIds,
      query.filter.listIds?.length ? query.filter.listIds : undefined,
    ]) {
      if (selected === undefined) continue;
      await this.assertSelectedLists(accountId, selected);
      where.push('l.id IN (SELECT value FROM json_each(?))');
      bindings.push(JSON.stringify(selected));
    }
    if (query.boardId !== undefined) {
      if (!this.options.boardListSelection)
        throw new AppError(
          'validation_failed',
          'board queries need an explicit board selection',
          422,
        );
      const selection = await this.options.boardListSelection(accountId, query.boardId);
      where.push(`l.id IN (${selection.sql})`);
      bindings.push(...selection.bindings);
    }
    return { sql: `SELECT l.* FROM tasks_lists l WHERE ${where.join(' AND ')}`, bindings };
  }

  private async readSnapshot(statements: D1PreparedStatement[]): Promise<unknown[][]> {
    try {
      const result = await this.db.batch(statements);
      if (result.some((read) => !read.success)) throw new Error();
      return result.map((read) => read.results);
    } catch {
      throw new AppError('storage_unavailable', 'the task projection could not be read', 503, true);
    }
  }

  private taskRowsStatement(accountId: string, ids: readonly string[]): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT ${taskFields} FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
      WHERE t.account_id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(accountId, JSON.stringify(ids));
  }

  private async taskRows(accountId: string, ids: readonly string[]): Promise<TaskRow[]> {
    return ids.length ? readProjectionRows<TaskRow>(this.taskRowsStatement(accountId, ids)) : [];
  }

  private coverageStatement(
    accountId: string,
    scope: SqlScope,
    includeCompleted: boolean,
    includeOrderProof = false,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `WITH scoped_lists AS (${scope.sql})
      SELECT s.inventory_complete_at AS inventory,s.inventory_cursor,
        (SELECT COUNT(*) FROM scoped_lists) AS n,
        (SELECT COUNT(*) FROM scoped_lists WHERE tasks_complete_at IS NULL OR sync_cursor IS NOT NULL ${includeCompleted ? 'OR completed_complete_at IS NULL' : ''}) AS partial,
        (SELECT CASE WHEN COUNT(*)=COUNT(last_synced_at) THEN MIN(last_synced_at) ELSE NULL END FROM scoped_lists) AS synced
        ${
          includeOrderProof
            ? `,(SELECT json_group_array(id) FROM scoped_lists WHERE tasks_complete_at IS NOT NULL AND completed_complete_at IS NOT NULL AND sync_cursor IS NULL AND provider_missing_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM tasks_sync_list_work w WHERE w.account_id=scoped_lists.account_id AND w.list_id=scoped_lists.id AND w.mode='full')) AS order_ready_list_ids, ${scopeRevisionSql} AS selection_revision`
            : ''
        }
      FROM tasks_account_state s WHERE s.account_id=?`,
      )
      .bind(...scope.bindings, accountId);
  }

  private async coverage(
    accountId: string,
    scope: SqlScope,
    includeCompleted: boolean,
    now: number,
  ): Promise<Coverage> {
    return this.mapCoverage(
      await readProjectionFirst<CoverageRow>(
        this.coverageStatement(accountId, scope, includeCompleted),
      ),
      now,
    );
  }

  private mapCoverage(row: CoverageRow | null, now: number): Coverage {
    const inventoryAt = row?.inventory ?? null;
    const syncedAt =
      row?.n === 0
        ? inventoryAt
        : row?.synced === null || row?.synced === undefined || inventoryAt === null
          ? null
          : Math.min(row.synced, inventoryAt);
    const complete =
      inventoryAt !== null && (row?.partial ?? 1) === 0 && row?.inventory_cursor === null;
    return {
      complete,
      lastSyncedAt: syncedAt === null ? null : new Date(syncedAt).toISOString(),
      stale: !complete || syncedAt === null || now - syncedAt >= 60_000,
    };
  }

  private summariesStatement(accountId: string, ids: readonly string[]): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT p.id,COUNT(child.id) AS total,
      COALESCE(SUM(CASE WHEN child.id IS NOT NULL AND child.completed=0 THEN 1 ELSE 0 END),0) AS open,
      CASE WHEN l.tasks_complete_at IS NOT NULL AND l.completed_complete_at IS NOT NULL AND l.sync_cursor IS NULL THEN 1 ELSE 0 END AS complete
      FROM tasks_tasks p JOIN tasks_lists l ON l.account_id=p.account_id AND l.id=p.list_id
      LEFT JOIN tasks_tasks child ON child.account_id=p.account_id AND child.parent_id=p.id AND child.list_id=p.list_id AND child.deleted_at IS NULL
      WHERE p.account_id=? AND p.id IN (SELECT value FROM json_each(?)) AND p.parent_id IS NULL AND p.deleted_at IS NULL AND l.deleted_at IS NULL GROUP BY p.id`,
      )
      .bind(accountId, JSON.stringify(ids));
  }

  async listTasks(
    accountId: string,
    input: TaskQueryInput = {},
    context: TaskQueryContext,
  ): Promise<TaskPage> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const query = parse(TaskQuerySchema, input);
    const today = parse(CalendarDateSchema, context.today);
    const parentScope =
      query.parentId === undefined
        ? { kind: 'all' }
        : query.parentId === null
          ? { kind: 'roots' }
          : { kind: 'children', id: query.parentId };
    const queryHash = await fingerprint({
      accountId,
      boardId: query.boardId ?? null,
      listIds: query.listIds ?? null,
      parentScope,
      query: normalizeTaskSearchText(query.query).trim(),
      filter: query.filter,
      sort: query.sort,
      today,
    });
    const cursor = decodeCursor(query.cursor, 'tasks-v1', accountId, queryHash);
    const scope = await this.scope(accountId, query);
    if (typeof query.parentId === 'string') {
      const parent = await readProjectionFirst<{ id: string }>(
        this.db
          .prepare(
            `WITH scoped_lists AS (${scope.sql}) SELECT t.id FROM tasks_tasks t JOIN scoped_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.id=? AND t.deleted_at IS NULL`,
          )
          .bind(...scope.bindings, query.parentId),
      );
      if (!parent)
        throw new AppError('not_found', 'the parent is not available in this selection', 404);
    }
    const filter = filterSql(query, today);
    const keys = orderKeys(query.sort);
    const names = keys.map((_, index) => `k${index}`);
    const cte = `WITH scoped_lists AS (${scope.sql}),candidates AS (
      SELECT t.id,t.revision,t.parent_id,p.id AS context_id,CASE WHEN p.id IS NOT NULL THEN p.id ELSE t.id END AS root_id,CASE WHEN p.id IS NOT NULL THEN p.revision ELSE t.revision END AS root_revision,
       ${estimate('t')} AS estimated,${estimate('p')} AS parent_estimated,${keys.map((key, index) => `${key} AS k${index}`).join(',')}
      FROM tasks_tasks t JOIN scoped_lists l ON l.account_id=t.account_id AND l.id=t.list_id
      LEFT JOIN tasks_tasks p ON p.account_id=t.account_id AND p.list_id=t.list_id AND p.id=t.parent_id AND p.deleted_at IS NULL
      WHERE ${filter.sql})`;
    const bindings = [...scope.bindings, ...filter.bindings];
    if (cursor && !cursor.selectionRevision)
      throw new AppError('conflict', 'the task page changed; refresh this selection', 409);
    const anchor = cursor
      ? `,cursor_anchor AS (SELECT ${names.join(',')} FROM candidates WHERE id=? AND revision=? AND root_id=? AND root_revision=?)`
      : '';
    const anchorBindings = cursor
      ? [cursor.id, cursor.revision, cursor.rootId!, cursor.rootRevision!]
      : [];
    const selection = await this.readSnapshot([
      this.db
        .prepare(
          `${cte}${anchor} SELECT id,revision,parent_id,context_id,root_id,root_revision,estimated,parent_estimated FROM candidates
      ${cursor ? `WHERE (${names.join(',')})>(SELECT ${names.join(',')} FROM cursor_anchor)` : ''}
      ORDER BY ${names.join(',')} LIMIT ?`,
        )
        .bind(...bindings, ...anchorBindings, query.limit + 1),
      this.db
        .prepare(
          `WITH scoped_lists AS (${scope.sql}) SELECT ${scopeRevisionSql} AS selection_revision,${pageRevisionSql} AS page_revision`,
        )
        .bind(...scope.bindings),
      ...(cursor
        ? [
            this.db
              .prepare(`${cte}${anchor} SELECT 1 AS valid FROM cursor_anchor`)
              .bind(...bindings, ...anchorBindings),
          ]
        : []),
    ]);
    const candidates = selection[0]! as Candidate[];
    const { selection_revision: selectionRevision, page_revision: pageRevision } =
      selection[1]![0] as {
        selection_revision: string;
        page_revision: string;
      };
    const selectionFingerprint = await fingerprint(pageRevision);
    if (cursor && (!selection[2]?.length || cursor.selectionRevision !== selectionFingerprint))
      throw new AppError('conflict', 'the task page changed; refresh this selection', 409);
    const selected = new Map<string, number>();
    const admitted: Candidate[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      const additions: [string, number][] = [];
      if (!selected.has(candidate.id)) additions.push([candidate.id, candidate.estimated]);
      if (candidate.context_id && !selected.has(candidate.context_id))
        additions.push([candidate.context_id, candidate.parent_estimated]);
      const addedBytes = additions.reduce((sum, [, size]) => sum + size, 0);
      if (
        selected.size + additions.length > query.limit ||
        (admitted.length > 0 && bytes + addedBytes > pageByteBudget)
      )
        break;
      for (const [id, size] of additions) selected.set(id, size);
      bytes += addedBytes;
      admitted.push(candidate);
    }
    // Rows, order proof, and checklist counts must describe one database snapshot.
    const snapshot = await this.readSnapshot([
      this.taskRowsStatement(accountId, [...selected.keys()]),
      this.coverageStatement(
        accountId,
        scope,
        (query.filter.completion ?? 'open') !== 'open',
        true,
      ),
      this.summariesStatement(accountId, [...selected.keys()]),
    ]);
    const rows = snapshot[0]! as TaskRow[];
    const coverageRow = (snapshot[1]![0] as CoverageRow | undefined) ?? null;
    const summaries = snapshot[2]! as SummaryRow[];
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    if (
      selectionRevision !== coverageRow?.selection_revision ||
      selected.size !== rows.length ||
      admitted.some(
        (candidate) =>
          rowMap.get(candidate.id)?.revision !== candidate.revision ||
          rowMap.get(candidate.id)?.parent_id !== candidate.parent_id ||
          (candidate.context_id &&
            rowMap.get(candidate.context_id)?.revision !== candidate.root_revision),
      )
    )
      throw new AppError(
        'conflict',
        'the task page changed while it was being read; refresh this selection',
        409,
      );
    const items = sortTasks(
      [...selected.keys()].flatMap((id) => {
        const row = rowMap.get(id);
        return row ? [mapTask(row)] : [];
      }),
      query.sort,
    );
    const matchedTaskIds = admitted.map((row) => row.id);
    const matches = new Set(matchedTaskIds);
    const contextTaskIds = items.filter((task) => !matches.has(task.id)).map((task) => task.id);
    const last = admitted[admitted.length - 1];
    const nextCursor =
      last && candidates.length > admitted.length
        ? encodeCursor({
            kind: 'tasks-v1',
            accountId,
            fingerprint: queryHash,
            id: last.id,
            revision: last.revision,
            rootId: last.root_id,
            rootRevision: last.root_revision,
            selectionRevision: selectionFingerprint,
          })
        : null;
    const providerCoverage = this.mapCoverage(coverageRow, context.now ?? Date.now());
    return {
      items,
      matchedTaskIds,
      orderReadyTaskIds: rows.filter((row) => row.order_ready === 1).map((row) => row.id),
      orderReadyListIds: JSON.parse(coverageRow?.order_ready_list_ids ?? '[]') as string[],
      contextTaskIds,
      subtaskSummaries: Object.fromEntries(
        summaries.map((row) => [
          row.id,
          { open: row.open, total: row.total, complete: row.complete === 1 },
        ]),
      ),
      nextCursor,
      providerCoverage,
      coverage: {
        ...providerCoverage,
        complete: providerCoverage.complete && cursor === null && nextCursor === null,
      },
    };
  }

  async getTask(accountId: string, taskId: string): Promise<Task> {
    parse(ResourceIdSchema.max(1_024), accountId);
    parse(ResourceIdSchema.max(1_024), taskId);
    const rows = await this.taskRows(accountId, [taskId]);
    if (!rows[0]) throw new AppError('not_found', 'the task is not available in this account', 404);
    return mapTask(rows[0]);
  }

  /** Saved reverse edges are local account data; provider-missing tasks remain visible as unknown. */
  async readDependants(
    accountId: string,
    taskId: string,
    input: TaskDependantsQueryInput = {},
  ): Promise<TaskDependantsPage> {
    parse(ResourceIdSchema.max(1_024), accountId);
    parse(ResourceIdSchema.max(1_024), taskId);
    const query = parse(TaskDependantsQuerySchema, input);
    const hash = await fingerprint({ accountId, taskId });
    const cursor = decodeCursor(query.cursor, 'dependants-v1', accountId, hash);
    const source = await readProjectionFirst<{
      graph_revision: number;
      last_synced_at: number | null;
    }>(
      this.db
        .prepare(
          `SELECT s.graph_revision,l.last_synced_at
      FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
      JOIN tasks_account_state s ON s.account_id=t.account_id
      WHERE t.account_id=? AND t.id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL`,
        )
        .bind(accountId, taskId),
    );
    if (!source) throw new AppError('not_found', 'the task is not available in this account', 404);
    if (cursor && cursor.revision !== source.graph_revision)
      throw new AppError('conflict', 'the dependency graph changed; refresh this selection', 409);
    const rows = await readProjectionRows<{
      id: string;
      account_id: string;
      list_id: string;
      list_title: string;
      parent_id: string | null;
      parent_title: string | null;
      title: string;
      completed: number;
      provider_missing_at: number | null;
      revision: number;
      last_synced_at: number | null;
    }>(
      this.db
        .prepare(
          `SELECT t.id,t.account_id,t.list_id,l.title AS list_title,t.parent_id,p.title AS parent_title,t.title,t.completed,t.provider_missing_at,t.revision,l.last_synced_at
      FROM tasks_dependencies d JOIN tasks_tasks t ON t.account_id=d.account_id AND t.id=d.task_id
      JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
      LEFT JOIN tasks_tasks p ON p.account_id=t.account_id AND p.list_id=t.list_id AND p.id=t.parent_id AND p.deleted_at IS NULL
      WHERE d.account_id=? AND d.blocker_id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL ${cursor ? 'AND d.task_id>?' : ''}
      ORDER BY d.task_id LIMIT ?`,
        )
        .bind(accountId, taskId, ...(cursor ? [cursor.id] : []), query.limit + 1),
    );
    const items: TaskDependant[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, query.limit)) {
      const item = TaskDependantSchema.parse({
        id: row.id,
        accountId: row.account_id,
        listId: row.list_id,
        listTitle: row.list_title,
        parentId: row.parent_id,
        parentTitle: row.parent_title ?? null,
        title: row.title,
        completed: row.completed === 1,
        providerMissing: row.provider_missing_at !== null,
        revision: row.revision,
      });
      const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
      if (bytes + size > 48 * 1024) {
        if (!items.length)
          throw new AppError(
            'validation_failed',
            'one dependency reference exceeds the bounded page size; inspect its task directly',
            422,
          );
        break;
      }
      items.push(item);
      bytes += size;
    }
    const current = await readProjectionFirst<{ graph_revision: number }>(
      this.db
        .prepare('SELECT graph_revision FROM tasks_account_state WHERE account_id=?')
        .bind(accountId),
    );
    if (current?.graph_revision !== source.graph_revision)
      throw new AppError(
        'conflict',
        'the dependency graph changed while it was being read; refresh this selection',
        409,
      );
    const last = items.at(-1);
    const times = [
      source.last_synced_at,
      ...rows.slice(0, items.length).map((row) => row.last_synced_at),
    ];
    const synced = times.every((value) => value !== null) ? Math.min(...(times as number[])) : null;
    return {
      items,
      graphRevision: source.graph_revision,
      nextCursor:
        last && rows.length > items.length
          ? encodeCursor({
              kind: 'dependants-v1',
              accountId,
              fingerprint: hash,
              id: last.id,
              revision: source.graph_revision,
            })
          : null,
      coverage: {
        complete: true,
        lastSyncedAt: synced === null ? null : new Date(synced).toISOString(),
        stale: synced === null || Date.now() - synced >= 60_000,
      },
    };
  }

  async getTasksByIds(accountId: string, ids: readonly string[]): Promise<Task[]> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const selected = [...new Set(parse(readIdsSchema, ids))];
    if (!selected.length) return [];
    const estimateRows = await readProjectionRows<{ estimated: number }>(
      this.db
        .prepare(
          `SELECT ${estimate('t')} AS estimated FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(selected)),
    );
    if (
      estimateRows.length > 1 &&
      estimateRows.reduce((sum, row) => sum + row.estimated, 0) > pageByteBudget
    )
      throw new AppError(
        'validation_failed',
        'read fewer task identities when task notes are large',
        422,
      );
    const rows = await this.taskRows(accountId, selected);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return selected.flatMap((id) => {
      const row = byId.get(id);
      return row ? [mapTask(row)] : [];
    });
  }

  private async exportSelection(
    accountId: string,
    query: TaskQuery,
    today: string,
  ): Promise<{ cte: string; bindings: (string | number)[]; scope: SqlScope }> {
    const scope = await this.scope(accountId, query),
      filter = filterSql(query, today);
    if (typeof query.parentId === 'string') {
      const parent = await readProjectionFirst(
        this.db
          .prepare(
            `WITH scoped_lists AS (${scope.sql}) SELECT t.id FROM tasks_tasks t JOIN scoped_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.id=? AND t.deleted_at IS NULL`,
          )
          .bind(...scope.bindings, query.parentId),
      );
      if (!parent)
        throw new AppError('not_found', 'the parent is not available in this selection', 404);
    }
    return {
      scope,
      bindings: [...scope.bindings, ...filter.bindings],
      cte: `WITH scoped_lists AS (${scope.sql}),export_matches AS (
      SELECT t.id,t.account_id,t.list_id,t.parent_id FROM tasks_tasks t JOIN scoped_lists l ON l.account_id=t.account_id AND l.id=t.list_id
      LEFT JOIN tasks_tasks p ON p.account_id=t.account_id AND p.list_id=t.list_id AND p.id=t.parent_id AND p.deleted_at IS NULL
      WHERE ${filter.sql}),export_selection AS (
      SELECT id FROM export_matches UNION SELECT p.id FROM export_matches m JOIN tasks_tasks p ON p.account_id=m.account_id AND p.list_id=m.list_id AND p.id=m.parent_id WHERE p.deleted_at IS NULL)`,
    };
  }

  /** No repeated context rows across pages; manual hierarchy order is part of the export contract. */
  async exportPage(
    accountId: string,
    input: TaskExportQueryInput = {},
    context: TaskQueryContext,
  ): Promise<TaskExportPage> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const query = parse(TaskExportQuerySchema, input),
      today = parse(CalendarDateSchema, context.today);
    const { cursor: suppliedCursor, limit: _limit, ...selection } = query;
    const hash = await fingerprint({ accountId, selection, today });
    const cursor = decodeCursor(suppliedCursor, 'export-v1', accountId, hash);
    const source = await this.exportSelection(accountId, query, today),
      keys = orderKeys('manual'),
      names = keys.map((_, index) => `k${index}`);
    const cte = `${source.cte},candidates AS (SELECT t.id,t.revision,t.parent_id,p.id AS context_id,
      CASE WHEN p.id IS NOT NULL THEN p.id ELSE t.id END AS root_id,CASE WHEN p.id IS NOT NULL THEN p.revision ELSE t.revision END AS root_revision,
      CASE WHEN t.id IN(SELECT id FROM export_matches) THEN 1 ELSE 0 END AS matched,${estimate('t')} AS estimated,
      ${keys.map((key, index) => `${key} AS k${index}`).join(',')} FROM tasks_tasks t JOIN scoped_lists l ON l.account_id=t.account_id AND l.id=t.list_id
      LEFT JOIN tasks_tasks p ON p.account_id=t.account_id AND p.list_id=t.list_id AND p.id=t.parent_id AND p.deleted_at IS NULL
      WHERE t.deleted_at IS NULL AND t.id IN(SELECT id FROM export_selection))`;
    let anchor: Record<string, string | number> | null = null;
    if (cursor) {
      anchor = await readProjectionFirst<Record<string, string | number>>(
        this.db
          .prepare(
            `${cte} SELECT ${names.join(',')} FROM candidates WHERE id=? AND revision=? AND root_id=? AND root_revision=?`,
          )
          .bind(...source.bindings, cursor.id, cursor.revision, cursor.rootId, cursor.rootRevision),
      );
      if (!anchor)
        throw new AppError('conflict', 'the export anchor changed; start this export again', 409);
    }
    const candidates = await readProjectionRows<Candidate & { matched: number }>(
      this.db
        .prepare(
          `${cte} SELECT id,revision,parent_id,context_id,root_id,root_revision,matched,estimated FROM candidates
      ${anchor ? `WHERE (${names.join(',')})>(${names.map(() => '?').join(',')})` : ''} ORDER BY ${names.join(',')} LIMIT ?`,
        )
        .bind(
          ...source.bindings,
          ...(anchor ? names.map((name) => anchor![name]!) : []),
          query.limit + 1,
        ),
    );
    const admitted: typeof candidates = [];
    let bytes = 0;
    for (const candidate of candidates) {
      if (
        admitted.length >= query.limit ||
        (admitted.length && bytes + candidate.estimated > 64 * 1024)
      )
        break;
      admitted.push(candidate);
      bytes += candidate.estimated;
    }
    const rows = await this.taskRows(
        accountId,
        admitted.map((candidate) => candidate.id),
      ),
      rowMap = new Map(rows.map((row) => [row.id, row]));
    if (
      rows.length !== admitted.length ||
      admitted.some(
        (candidate) =>
          rowMap.get(candidate.id)?.revision !== candidate.revision ||
          rowMap.get(candidate.id)?.parent_id !== candidate.parent_id,
      )
    )
      throw new AppError(
        'conflict',
        'the export page changed while being read; start this export again',
        409,
      );
    const items = admitted.map((candidate) => mapTask(rowMap.get(candidate.id)!));
    if (new TextEncoder().encode(JSON.stringify(items)).byteLength > 64 * 1024)
      throw new AppError(
        'validation_failed',
        'one task exceeds the bounded export page size; reduce its metadata before exporting',
        422,
      );
    const last = admitted.at(-1),
      nextCursor =
        last && candidates.length > admitted.length
          ? encodeCursor({
              kind: 'export-v1',
              accountId,
              fingerprint: hash,
              id: last.id,
              revision: last.revision,
              rootId: last.root_id,
              rootRevision: last.root_revision,
            })
          : null;
    return {
      items,
      matchedTaskIds: admitted
        .filter((candidate) => candidate.matched)
        .map((candidate) => candidate.id),
      contextTaskIds: admitted
        .filter((candidate) => !candidate.matched)
        .map((candidate) => candidate.id),
      nextCursor,
      providerCoverage: await this.coverage(
        accountId,
        source.scope,
        (query.filter.completion ?? 'open') !== 'open' ||
          admitted.some((candidate) => !candidate.matched),
        context.now ?? Date.now(),
      ),
    };
  }

  async exportMembership(
    accountId: string,
    input: TaskExportQueryInput,
    ids: readonly string[],
    context: TaskQueryContext,
  ): Promise<string[]> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const selected = [...new Set(parse(readIdsSchema, ids))];
    const query = parse(TaskExportQuerySchema, input),
      today = parse(CalendarDateSchema, context.today);
    if (query.cursor)
      throw new AppError(
        'validation_failed',
        'reference membership uses a whole export selection, without a page cursor',
        422,
      );
    if (!selected.length) return [];
    const source = await this.exportSelection(accountId, query, today);
    const rows = await readProjectionRows<{ id: string }>(
      this.db
        .prepare(
          `${source.cte} SELECT id FROM export_selection WHERE id IN(SELECT value FROM json_each(?))`,
        )
        .bind(...source.bindings, JSON.stringify(selected)),
    );
    const matched = new Set(rows.map((row) => row.id));
    return selected.filter((id) => matched.has(id));
  }
}
