import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../contracts/errors';
import { assertProviderWritable, providerWriteGuard } from '../../../accounts/access';
import { ResourceIdSchema, type Label, type Task } from '../../contracts';
import { TaskQueries } from './tasks';
import { readActiveLists } from './lists';
import { accountRemovalGuard } from '../../../accounts/lifecycle';

const identity = ResourceIdSchema.max(1024);
const selectionSchema = z
  .object({
    id: identity,
    accountId: identity,
    listIds: z
      .array(identity)
      .min(1)
      .max(100)
      .refine((value) => new Set(value).size === value.length),
    includeCompleted: z.boolean(),
    maxTasks: z.number().int().min(1).max(2000).default(2000),
  })
  .strict();
interface Header {
  id: string;
  account_id: string;
  input_json: string;
  task_count: number;
  created_at: number;
  context_count: number;
}
export interface SnapshotList {
  key: string;
  id: string;
  title: string;
  revision: number;
  projectionRevision: number;
  position: number;
}
export interface SnapshotItem {
  key: string;
  listKey: string;
  parentKey: string | null;
  dependencyKeys: string[];
  omittedDependencyCount: number;
  contextOnly: boolean;
  task: Task;
  labels: Label[];
  position: number;
}
export interface TaskSourceSnapshot {
  id: string;
  accountId: string;
  taskCount: number;
  lists: SnapshotList[];
  capturedAt: string;
  contextParentCount: number;
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError('validation_failed', 'check the task snapshot selection.', 422);
  return result.data;
}
function conflict() {
  return new AppError(
    'conflict',
    'the source changed while its selected input was being captured. refresh the preview.',
    409,
  );
}
/** Task-owned identity and revision capture. Payload reads remain bounded and source CAS is explicit. */
export class TaskSnapshotReader {
  private readonly now: () => number;
  private readonly queries: TaskQueries;
  constructor(
    private readonly db: D1Database,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.queries = new TaskQueries(db);
  }
  private guard(condition: string, bindings: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
      .bind(...bindings);
  }
  private async header(id: string, accountId: string): Promise<Header> {
    parse(identity, id);
    parse(identity, accountId);
    const row = await this.db
      .prepare('SELECT * FROM tasks_snapshots WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first<Header>();
    if (!row)
      throw new AppError(
        'not_found',
        'this task snapshot is not available in the selected account.',
        404,
      );
    return row;
  }
  private unchangedSql() {
    return `NOT EXISTS(SELECT 1 FROM tasks_snapshot_lists saved LEFT JOIN tasks_lists current ON current.id=saved.list_id AND current.account_id=? WHERE saved.snapshot_id=? AND (current.id IS NULL OR current.deleted_at IS NOT NULL OR current.revision<>saved.revision OR current.projection_revision<>saved.projection_revision OR current.tasks_complete_at IS NULL OR current.completed_complete_at IS NULL OR current.sync_cursor IS NOT NULL)) AND NOT EXISTS(SELECT 1 FROM tasks_snapshot_items saved LEFT JOIN tasks_tasks current ON current.id=saved.task_id AND current.account_id=? WHERE saved.snapshot_id=? AND (current.id IS NULL OR current.deleted_at IS NOT NULL OR current.revision<>saved.revision)) AND NOT EXISTS(SELECT 1 FROM tasks_snapshot_labels saved LEFT JOIN tasks_labels current ON current.id=saved.label_id AND current.account_id=? WHERE saved.snapshot_id=? AND (current.id IS NULL OR current.revision<>saved.revision))`;
  }
  async prepareCaptureGuards(id: string, accountId: string): Promise<D1PreparedStatement[]> {
    await this.header(id, accountId);
    return [
      providerWriteGuard(this.db, accountId),
      this.guard(this.unchangedSql(), [accountId, id, accountId, id, accountId, id]),
    ];
  }
  private async unchanged(id: string, accountId: string) {
    if (
      !(await this.db
        .prepare('SELECT 1 AS valid WHERE ' + this.unchangedSql())
        .bind(accountId, id, accountId, id, accountId, id)
        .first())
    )
      throw conflict();
  }
  async get(id: string, accountId: string): Promise<TaskSourceSnapshot> {
    const row = await this.header(id, accountId);
    const lists = (
      await this.db
        .prepare('SELECT * FROM tasks_snapshot_lists WHERE snapshot_id=? ORDER BY position')
        .bind(id)
        .all<{
          list_id: string;
          title: string;
          revision: number;
          projection_revision: number;
          position: number;
        }>()
    ).results;
    return {
      id,
      accountId,
      taskCount: row.task_count,
      capturedAt: new Date(row.created_at).toISOString(),
      contextParentCount: row.context_count,
      lists: lists.map((list) => ({
        key: 'l' + (list.position + 1),
        id: list.list_id,
        title: list.title,
        revision: list.revision,
        projectionRevision: list.projection_revision,
        position: list.position,
      })),
    };
  }
  async capture(input: z.input<typeof selectionSchema>): Promise<TaskSourceSnapshot> {
    const selected = parse(selectionSchema, input);
    const encoded = JSON.stringify(selected),
      prior = await this.db
        .prepare('SELECT * FROM tasks_snapshots WHERE id=?')
        .bind(selected.id)
        .first<Header>();
    if (prior) {
      if (prior.account_id !== selected.accountId || prior.input_json !== encoded) throw conflict();
      return this.get(selected.id, selected.accountId);
    }
    await assertProviderWritable(this.db, selected.accountId);
    const selectedSql = `SELECT list.*,CAST(chosen.key AS INTEGER) AS ordinal FROM json_each(?) chosen JOIN tasks_lists list ON list.id=chosen.value AND list.account_id=? AND list.deleted_at IS NULL`;
    const lists = (
      await this.db
        .prepare(selectedSql)
        .bind(JSON.stringify(selected.listIds), selected.accountId)
        .all<{
          id: string;
          revision: number;
          projection_revision: number;
          tasks_complete_at: number | null;
          completed_complete_at: number | null;
          sync_cursor: string | null;
        }>()
    ).results;
    if (lists.length !== selected.listIds.length)
      throw new AppError(
        'not_found',
        'one selected source list is no longer available in this account.',
        404,
      );
    if (
      lists.some(
        (list) =>
          list.tasks_complete_at === null ||
          list.completed_complete_at === null ||
          list.sync_cursor !== null,
      )
    )
      throw conflict();
    const included = `(t.completed=0 OR ?=1 OR EXISTS(SELECT 1 FROM tasks_tasks child WHERE child.account_id=t.account_id AND child.list_id=t.list_id AND child.parent_id=t.id AND child.deleted_at IS NULL AND child.completed=0))`;
    const count = await this.db
      .prepare(
        `SELECT COUNT(*) AS n,COALESCE(SUM(t.completed=1),0) AS completed FROM tasks_tasks t WHERE t.account_id=? AND t.list_id IN(SELECT value FROM json_each(?)) AND t.deleted_at IS NULL AND ${included}`,
      )
      .bind(selected.accountId, JSON.stringify(selected.listIds), Number(selected.includeCompleted))
      .first<{ n: number; completed: number }>();
    if (!count || count.n > selected.maxTasks)
      throw new AppError(
        'validation_failed',
        'select at most 2,000 tasks, counting subtasks. choose fewer lists instead of truncating the source.',
        422,
      );
    const capturedLists = JSON.stringify(
      lists.map((list) => ({
        id: list.id,
        revision: list.revision,
        projectionRevision: list.projection_revision,
      })),
    );
    try {
      await this.db.batch([
        providerWriteGuard(this.db, selected.accountId),
        this.guard(
          `NOT EXISTS(SELECT 1 FROM json_each(?) saved LEFT JOIN tasks_lists list ON list.id=json_extract(saved.value,'$.id') AND list.account_id=? WHERE list.id IS NULL OR list.deleted_at IS NOT NULL OR list.revision<>json_extract(saved.value,'$.revision') OR list.projection_revision<>json_extract(saved.value,'$.projectionRevision'))`,
          [capturedLists, selected.accountId],
        ),
        this.db
          .prepare(
            'INSERT INTO tasks_snapshots(id,account_id,input_json,include_completed,task_count,context_count,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            selected.id,
            selected.accountId,
            encoded,
            Number(selected.includeCompleted),
            count.n,
            selected.includeCompleted ? 0 : count.completed,
            this.now(),
          ),
        this.db
          .prepare(
            `INSERT INTO tasks_snapshot_lists(snapshot_id,list_id,position,revision,projection_revision,title) SELECT ?,id,ordinal,revision,projection_revision,title FROM (${selectedSql})`,
          )
          .bind(selected.id, JSON.stringify(selected.listIds), selected.accountId),
        this.db
          .prepare(
            `INSERT INTO tasks_snapshot_items(snapshot_id,task_id,position,revision,context_only) SELECT ?,t.id,ROW_NUMBER() OVER(ORDER BY list.position,COALESCE(parent.provider_position,t.provider_position,''),COALESCE(parent.id,t.id),t.parent_id IS NOT NULL,COALESCE(t.provider_position,''),t.id)-1,t.revision,CASE WHEN ?=0 AND t.completed=1 THEN 1 ELSE 0 END FROM tasks_tasks t JOIN tasks_snapshot_lists list ON list.snapshot_id=? AND list.list_id=t.list_id LEFT JOIN tasks_tasks parent ON parent.account_id=t.account_id AND parent.id=t.parent_id AND parent.deleted_at IS NULL WHERE t.account_id=? AND t.deleted_at IS NULL AND ${included}`,
          )
          .bind(
            selected.id,
            Number(selected.includeCompleted),
            selected.id,
            selected.accountId,
            Number(selected.includeCompleted),
          ),
        this.db
          .prepare(
            `INSERT INTO tasks_snapshot_labels(snapshot_id,label_id,revision) SELECT DISTINCT ?,label.id,label.revision FROM tasks_labels label JOIN tasks_task_labels link ON link.account_id=label.account_id AND link.label_id=label.id JOIN tasks_snapshot_items item ON item.snapshot_id=? AND item.task_id=link.task_id WHERE label.account_id=?`,
          )
          .bind(selected.id, selected.id, selected.accountId),
        this.guard('(SELECT COUNT(*) FROM tasks_snapshot_items WHERE snapshot_id=?)=?', [
          selected.id,
          count.n,
        ]),
      ]);
    } catch {
      const replay = await this.db
        .prepare('SELECT account_id,input_json FROM tasks_snapshots WHERE id=?')
        .bind(selected.id)
        .first<Header>();
      if (!replay || replay.account_id !== selected.accountId || replay.input_json !== encoded)
        throw conflict();
    }
    return this.get(selected.id, selected.accountId);
  }
  async providerReferences(
    accountId: string,
    ids: readonly string[],
  ): Promise<
    {
      id: string;
      providerId: string;
      listProviderId: string;
      providerEtag: string | null;
      revision: number;
      missing: boolean;
    }[]
  > {
    parse(identity, accountId);
    parse(z.array(identity).max(100), ids);
    if (!ids.length) return [];
    const rows = (
      await this.db
        .prepare(
          `SELECT task.id,task.provider_id,list.provider_id AS list_provider_id,task.provider_etag,task.revision,task.provider_missing_at FROM tasks_tasks task JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.account_id=? AND task.id IN(SELECT value FROM json_each(?)) AND task.deleted_at IS NULL AND list.deleted_at IS NULL`,
        )
        .bind(accountId, JSON.stringify(ids))
        .all<{
          id: string;
          provider_id: string;
          list_provider_id: string;
          provider_etag: string | null;
          revision: number;
          provider_missing_at: number | null;
        }>()
    ).results;
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      listProviderId: row.list_provider_id,
      providerEtag: row.provider_etag,
      revision: row.revision,
      missing: row.provider_missing_at !== null,
    }));
  }
  async matchReferenceAddresses(
    accountId: string,
    input: readonly { id: string; listId: string }[],
  ): Promise<{ id: string; providerId: string; listProviderId: string; revision: number }[]> {
    parse(identity, accountId);
    const selected = parse(
      z.array(z.object({ id: identity, listId: identity }).strict()).max(100),
      input,
    );
    if (!selected.length) return [];
    const rows = (
      await this.db
        .prepare(
          `SELECT task.id,task.provider_id,list.provider_id AS list_provider_id,task.revision FROM tasks_tasks task JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id JOIN json_each(?) selected ON task.provider_id=json_extract(selected.value,'$.id') AND list.provider_id=json_extract(selected.value,'$.listId') WHERE task.account_id=? AND task.deleted_at IS NULL AND task.provider_missing_at IS NULL AND list.deleted_at IS NULL`,
        )
        .bind(JSON.stringify(selected), accountId)
        .all<{ id: string; provider_id: string; list_provider_id: string; revision: number }>()
    ).results;
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      listProviderId: row.list_provider_id,
      revision: row.revision,
    }));
  }
  async matchResources(
    accountId: string,
    input: { lists?: readonly string[]; tasks?: readonly { id: string; listId: string }[] },
  ): Promise<{ lists: Awaited<ReturnType<typeof readActiveLists>>; tasks: Task[] }> {
    parse(identity, accountId);
    const lists = parse(z.array(identity).max(100), input.lists ?? []),
      tasks = parse(
        z.array(z.object({ id: identity, listId: identity }).strict()).max(10),
        input.tasks ?? [],
      );
    const listRows = lists.length
      ? (
          await this.db
            .prepare(
              'SELECT id FROM tasks_lists WHERE account_id=? AND provider_id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL',
            )
            .bind(accountId, JSON.stringify(lists))
            .all<{ id: string }>()
        ).results
      : [];
    const rows = tasks.length
      ? (
          await this.db
            .prepare(
              `SELECT task.id FROM tasks_tasks task JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id JOIN json_each(?) selected ON task.provider_id=json_extract(selected.value,'$.id') AND list.provider_id=json_extract(selected.value,'$.listId') WHERE task.account_id=? AND task.deleted_at IS NULL AND task.provider_missing_at IS NULL AND list.deleted_at IS NULL AND list.tasks_complete_at IS NOT NULL AND list.completed_complete_at IS NOT NULL AND list.sync_cursor IS NULL`,
            )
            .bind(JSON.stringify(tasks), accountId)
            .all<{ id: string }>()
        ).results
      : [];
    return {
      lists: await readActiveLists(
        this.db,
        accountId,
        listRows.map((row) => row.id),
      ),
      tasks: await this.queries.getTasksByIds(
        accountId,
        rows.map((row) => row.id),
      ),
    };
  }
  async page(
    id: string,
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: SnapshotItem[]; nextCursor: string | null }> {
    await this.header(id, accountId);
    const limit = parse(z.number().int().min(1).max(10), input.limit ?? 10);
    let position = -1;
    if (input.cursor) {
      try {
        const cursor = z
          .object({ id: identity, accountId: identity, position: z.number().int().nonnegative() })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (cursor.id !== id || cursor.accountId !== accountId) throw Error();
        position = cursor.position;
      } catch {
        throw new AppError(
          'validation_failed',
          'this snapshot cursor belongs to another selection.',
          422,
        );
      }
    }
    await assertProviderWritable(this.db, accountId);
    await this.unchanged(id, accountId);
    const candidates = (
      await this.db
        .prepare(
          `SELECT saved.task_id,saved.position,saved.context_only,list.position AS list_position,parent.position AS parent_position,length(CAST(t.notes AS BLOB))*6+length(CAST(t.title AS BLOB))*6+8192 AS estimated FROM tasks_snapshot_items saved JOIN tasks_tasks t ON t.id=saved.task_id AND t.account_id=? JOIN tasks_snapshot_lists list ON list.snapshot_id=saved.snapshot_id AND list.list_id=t.list_id LEFT JOIN tasks_snapshot_items parent ON parent.snapshot_id=saved.snapshot_id AND parent.task_id=t.parent_id WHERE saved.snapshot_id=? AND saved.position>? ORDER BY saved.position LIMIT ?`,
        )
        .bind(accountId, id, position, limit + 1)
        .all<{
          task_id: string;
          position: number;
          context_only: number;
          list_position: number;
          parent_position: number | null;
          estimated: number;
        }>()
    ).results;
    const selected: typeof candidates = [];
    let size = 0;
    for (const row of candidates) {
      if (selected.length >= limit || (selected.length && size + row.estimated > 64000)) break;
      selected.push(row);
      size += row.estimated;
    }
    const tasks = await this.queries.getTasksByIds(
      accountId,
      selected.map((row) => row.task_id),
    );
    const labels = (
      await this.db
        .prepare(
          `SELECT DISTINCT label.id,label.account_id,label.name,label.color,label.revision FROM tasks_labels label JOIN tasks_task_labels link ON link.account_id=label.account_id AND link.label_id=label.id WHERE label.account_id=? AND link.task_id IN(SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(selected.map((row) => row.task_id)))
        .all<{ id: string; account_id: string; name: string; color: string; revision: number }>()
    ).results.map((label) => ({
      id: label.id,
      accountId: label.account_id,
      name: label.name,
      color: label.color,
      revision: label.revision,
    }));
    const references = (
      await this.db
        .prepare(
          `SELECT task_id,position FROM tasks_snapshot_items WHERE snapshot_id=? AND task_id IN(SELECT blocker_id FROM tasks_dependencies WHERE account_id=? AND task_id IN(SELECT value FROM json_each(?)))`,
        )
        .bind(id, accountId, JSON.stringify(selected.map((row) => row.task_id)))
        .all<{ task_id: string; position: number }>()
    ).results;
    const keyById = new Map(references.map((row) => [row.task_id, 't' + (row.position + 1)]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    let items: SnapshotItem[] = selected.map((row) => {
      const task = taskById.get(row.task_id);
      if (!task) throw conflict();
      return {
        key: 't' + (row.position + 1),
        listKey: 'l' + (row.list_position + 1),
        parentKey: row.parent_position === null ? null : 't' + (row.parent_position + 1),
        dependencyKeys: task.blockedBy.flatMap((id) => (keyById.has(id) ? [keyById.get(id)!] : [])),
        omittedDependencyCount: task.blockedBy.filter((id) => !keyById.has(id)).length,
        contextOnly: row.context_only === 1,
        task,
        labels: labels.filter((label) => task.labelIds.includes(label.id)),
        position: row.position,
      };
    });
    while (items.length > 1 && new TextEncoder().encode(JSON.stringify(items)).byteLength > 65536)
      items = items.slice(0, -1);
    if (new TextEncoder().encode(JSON.stringify(items)).byteLength > 65536)
      throw new AppError(
        'validation_failed',
        'one source task and its metadata exceed the 64 kib capture bound. reduce its metadata before copying.',
        422,
      );
    await this.unchanged(id, accountId);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        last && candidates.some((row) => row.position > last.position)
          ? btoa(JSON.stringify({ id, accountId, position: last.position }))
          : null,
    };
  }
  async removeSnapshotSlice(
    id: string,
    accountId: string,
    limit = 100,
  ): Promise<{ done: boolean; deleted: number }> {
    return this.removeSlice(accountId, limit, id);
  }
  async removeAccountSlice(
    accountId: string,
    limit = 100,
  ): Promise<{ done: boolean; deleted: number }> {
    await accountRemovalGuard(this.db, accountId).run();
    return this.removeSlice(accountId, limit);
  }
  private async removeSlice(
    accountId: string,
    limit: number,
    id?: string,
  ): Promise<{ done: boolean; deleted: number }> {
    parse(z.number().int().min(1).max(100), limit);
    let deleted = 0;
    const snapshots = `SELECT id FROM tasks_snapshots WHERE account_id=?${id ? ' AND id=?' : ''}`,
      bindings = id ? [accountId, id] : [accountId];
    for (const table of [
      'tasks_snapshot_items',
      'tasks_snapshot_labels',
      'tasks_snapshot_lists',
    ] as const) {
      if (deleted === limit) break;
      const result = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE snapshot_id IN(${snapshots}) LIMIT ?)`,
        )
        .bind(...bindings, limit - deleted)
        .run();
      deleted += result.meta.changes;
    }
    if (deleted < limit) {
      const result = await this.db
        .prepare(
          `DELETE FROM tasks_snapshots WHERE id IN(SELECT id FROM tasks_snapshots WHERE account_id=?${id ? ' AND id=?' : ''} AND NOT EXISTS(SELECT 1 FROM tasks_snapshot_items WHERE snapshot_id=tasks_snapshots.id) AND NOT EXISTS(SELECT 1 FROM tasks_snapshot_labels WHERE snapshot_id=tasks_snapshots.id) AND NOT EXISTS(SELECT 1 FROM tasks_snapshot_lists WHERE snapshot_id=tasks_snapshots.id) LIMIT ?)`,
        )
        .bind(...bindings, limit - deleted)
        .run();
      deleted += result.meta.changes;
    }
    const pending = await this.db
      .prepare(`SELECT 1 FROM tasks_snapshots WHERE account_id=?${id ? ' AND id=?' : ''} LIMIT 1`)
      .bind(...bindings)
      .first();
    return { done: !pending, deleted };
  }
}
