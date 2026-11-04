import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';
import type { HistoryService } from '../../../history/server/events/event-store';
import type { HistoryEventInput } from '../../../history/contracts/events';
import { LabelInputSchema, LabelSchema, PrioritySchema, type Label, type Priority } from '../../contracts/task';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import {
  LabelDeletionJobSchema,
  LabelPatchSchema,
  PendingLabelDeletionsQuerySchema,
  TaskMetadataPatchSchema,
  type LabelDeletionJob,
  type PendingLabelDeletionsQuery,
} from '../../contracts/metadata-commands';
import { normalizeLabelName } from '../../model/task';

/** Only operation composition supplies this context; it is absent from browser commands. */
export interface MetadataContext {
  operationId: string;
  stepKey: string;
  origin: 'owner' | 'scheduled';
  recordedAt: string;
  scheduleId?: string | undefined;
  runId?: string | undefined;
}
export interface TaskMetadataOptions {
  commitWrites(writes: D1PreparedStatement[]): Promise<unknown>;
  history: Pick<HistoryService, 'eventWrite'>;
}
export interface MetadataPatchResult {
  taskId: string;
  revision: number;
  graphRevision: number;
}
export interface PreparedMetadataPatch {
  writes: D1PreparedStatement[];
  result: MetadataPatchResult;
}
export interface CreatedTaskMetadata {
  taskId: string;
  expectedTaskRevision: number;
  labelIds: string[];
  priority: Priority;
  starred: boolean;
  blockedBy: string[];
}
interface TaskRow {
  id: string;
  account_id: string;
  list_id: string;
  title: string;
  list_title: string;
  priority: Priority;
  starred: number;
  revision: number;
  deleted_at: number | null;
  labels_json: string;
  blockers_json: string;
}
interface LabelRow {
  id: string;
  account_id: string;
  name: string;
  name_key: string;
  color: string;
  revision: number;
}
interface JobRow {
  id: string;
  account_id: string;
  label_id: string;
  label_name: string;
  state: 'pending' | 'completed';
  removed_associations: number;
  revision: number;
  created_at: number;
  completed_at: number | null;
}
const id = ResourceIdSchema.max(1_024);
const revision = z.number().int().nonnegative().safe();
const contextSchema = z
  .object({
    operationId: ResourceIdSchema.max(256),
    stepKey: ResourceIdSchema.max(256),
    origin: z.enum(['owner', 'scheduled']),
    recordedAt: z.iso
      .datetime({ offset: true })
      .refine((value) => !/\.\d{4}/.test(value), 'capture millisecond precision'),
    scheduleId: id.optional(),
    runId: id.optional(),
  })
  .strict();
const createdSchema = z
  .array(
    z
      .object({
        taskId: id,
        expectedTaskRevision: revision,
        labelIds: z.array(id).max(20),
        priority: PrioritySchema,
        starred: z.boolean(),
        blockedBy: z.array(id).max(50),
      })
      .strict()
      .refine(
        (value) =>
          new Set(value.labelIds).size === value.labelIds.length &&
          new Set(value.blockedBy).size === value.blockedBy.length,
        'use each metadata identity once',
      ),
  )
  .max(10)
  .refine(
    (value) => new Set(value.map((item) => item.taskId)).size === value.length,
    'use each new task once',
  );
const taskSelection = `SELECT t.id,t.account_id,t.list_id,t.title,l.title AS list_title,t.priority,t.starred,t.revision,t.deleted_at,
  COALESCE((SELECT json_group_array(label_id) FROM (SELECT label_id FROM tasks_task_labels WHERE account_id=t.account_id AND task_id=t.id ORDER BY label_id)),'[]') AS labels_json,
  COALESCE((SELECT json_group_array(blocker_id) FROM (SELECT blocker_id FROM tasks_dependencies WHERE account_id=t.account_id AND task_id=t.id ORDER BY blocker_id)),'[]') AS blockers_json
  FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id`;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the metadata fields',
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
function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1_024)
    throw new AppError('validation_failed', 'one metadata slice may contain at most 64 kib', 422);
}
function label(row: LabelRow): Label {
  return LabelSchema.parse({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    color: row.color,
    revision: row.revision,
  });
}
function job(row: JobRow): LabelDeletionJob {
  return LabelDeletionJobSchema.parse({
    id: row.id,
    accountId: row.account_id,
    labelId: row.label_id,
    labelName: row.label_name,
    state: row.state,
    removedAssociations: row.removed_associations,
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  });
}
function same(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const ordered = [...right].sort();
  return [...left].sort().every((value, index) => value === ordered[index]);
}

export class TaskMetadataService {
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskMetadataOptions,
  ) {}
  private async first<T>(statement: D1PreparedStatement): Promise<T | null> {
    try {
      return await statement.first<T>();
    } catch {
      throw new AppError('storage_unavailable', 'metadata could not be read', 503, true);
    }
  }
  private async rows<T>(statement: D1PreparedStatement): Promise<T[]> {
    try {
      return (await statement.all<T>()).results;
    } catch {
      throw new AppError('storage_unavailable', 'metadata could not be read', 503, true);
    }
  }
  /** D1 batch update changes=0 does not abort later receipt writes; this CHECK does. */
  private guard(condition: string, bindings: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
      .bind(...bindings);
  }
  private async commit(writes: D1PreparedStatement[], explain: () => Promise<void>): Promise<void> {
    try {
      await this.options.commitWrites(writes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      await explain();
      throw new AppError(
        'storage_unavailable',
        'metadata and its operation receipt could not be saved',
        503,
        true,
      );
    }
  }
  private async activeTask(
    accountId: string,
    taskId: string,
    expectedRevision: number,
  ): Promise<TaskRow> {
    const row = await this.first<TaskRow>(
      this.db
        .prepare(
          `${taskSelection} WHERE t.account_id=? AND t.id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL`,
        )
        .bind(accountId, taskId),
    );
    if (!row) throw new AppError('not_found', 'this retained task is no longer available', 404);
    if (row.revision !== expectedRevision)
      throw new AppError('conflict', 'this task changed; refresh before reapplying metadata', 409);
    return row;
  }
  private async activeLabel(
    accountId: string,
    labelId: string,
    expectedRevision?: number,
  ): Promise<LabelRow> {
    const row = await this.first<LabelRow>(
      this.db
        .prepare('SELECT * FROM tasks_labels WHERE account_id=? AND id=?')
        .bind(accountId, labelId),
    );
    if (!row) throw new AppError('not_found', 'this label is no longer available', 404);
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      throw new AppError('conflict', 'this label changed; refresh before reapplying the edit', 409);
    return row;
  }
  private async assertLabelNotDeleting(accountId: string, labelId: string): Promise<void> {
    if (
      await this.first(
        this.db
          .prepare(
            "SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND label_id=? AND state='pending'",
          )
          .bind(accountId, labelId),
      )
    ) {
      throw new AppError(
        'conflict',
        'this label is being deleted; its remaining associations are still visible',
        409,
      );
    }
  }
  private async assertLabelNameFree(
    accountId: string,
    nameKey: string,
    excludingId: string | null,
  ): Promise<void> {
    if (
      await this.first(
        this.db
          .prepare(
            'SELECT 1 FROM tasks_labels WHERE account_id=? AND name_key=? AND (? IS NULL OR id<>?)',
          )
          .bind(accountId, nameKey, excludingId, excludingId),
      )
    ) {
      throw new AppError('conflict', 'an account label already uses this name', 409, false, {
        name: 'choose a different label name',
      });
    }
  }
  async getGraphRevision(accountId: string): Promise<number> {
    parse(id, accountId);
    const row = await this.first<{ graph_revision: number }>(
      this.db
        .prepare('SELECT graph_revision FROM tasks_account_state WHERE account_id=?')
        .bind(accountId),
    );
    if (!row) throw new AppError('not_found', 'this account graph is no longer available', 404);
    return row.graph_revision;
  }
  private async validateLabels(accountId: string, labelIds: string[]): Promise<void> {
    if (!labelIds.length) return;
    const rows = await this.rows<{ id: string; deleting: number }>(
      this.db
        .prepare(
          `SELECT label.id,EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending') AS deleting
      FROM tasks_labels label WHERE label.account_id=? AND label.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(labelIds)),
    );
    if (rows.length !== labelIds.length)
      throw new AppError(
        'validation_failed',
        'choose existing labels from this account',
        422,
        false,
        { labelIds: 'one or more labels are missing or belong to another account' },
      );
    if (rows.some((row) => row.deleting === 1))
      throw new AppError('conflict', 'a selected label is being deleted', 409);
  }
  private labelsGuard(accountId: string, labelIds: string[]): D1PreparedStatement {
    return this.guard(
      `NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN tasks_labels label ON label.account_id=? AND label.id=selected.value
      WHERE label.id IS NULL OR EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending'))`,
      [JSON.stringify(labelIds), accountId],
    );
  }
  private graphGuard(accountId: string, expectedGraphRevision: number): D1PreparedStatement {
    return this.guard(
      'EXISTS (SELECT 1 FROM tasks_account_state WHERE account_id=? AND graph_revision=?)',
      [accountId, expectedGraphRevision],
    );
  }
  private cycleCondition(
    accountId: string,
    taskId: string,
    blockerIds: string[],
  ): { sql: string; bindings: unknown[] } {
    // UNION terminates even if old/corrupt data contains a cycle. Replace this task's
    // outgoing edges while following every candidate blocker's existing ancestors.
    return {
      sql: `EXISTS (WITH RECURSIVE reachable(id) AS (
      SELECT value FROM json_each(?) UNION SELECT d.blocker_id FROM tasks_dependencies d JOIN reachable r ON r.id=d.task_id WHERE d.account_id=? AND d.task_id<>?
    ) SELECT 1 FROM reachable WHERE id=?)`,
      bindings: [JSON.stringify(blockerIds), accountId, taskId, taskId],
    };
  }
  private async validateDependencies(
    accountId: string,
    taskId: string,
    blockerIds: string[],
    expectedGraphRevision: number,
  ): Promise<void> {
    if ((await this.getGraphRevision(accountId)) !== expectedGraphRevision)
      throw new AppError(
        'conflict',
        'the dependency graph changed; refresh before reapplying the edit',
        409,
      );
    if (blockerIds.includes(taskId))
      throw new AppError('validation_failed', 'a task cannot block itself', 422, false, {
        blockedBy: 'remove this task from its blockers',
      });
    const count = await this.first<{ n: number }>(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(blockerIds)),
    );
    if (count?.n !== blockerIds.length)
      throw new AppError(
        'validation_failed',
        'choose retained blockers from this account',
        422,
        false,
        { blockedBy: 'one or more blockers are missing, deleted or belong to another account' },
      );
    const cycle = this.cycleCondition(accountId, taskId, blockerIds);
    if (await this.first(this.db.prepare(`SELECT 1 WHERE ${cycle.sql}`).bind(...cycle.bindings)))
      throw new AppError('validation_failed', 'this dependency would create a cycle', 422, false, {
        blockedBy: 'remove the cyclic dependency',
      });
  }
  private blockersGuard(
    accountId: string,
    taskId: string,
    blockerIds: string[],
  ): D1PreparedStatement {
    const cycle = this.cycleCondition(accountId, taskId, blockerIds);
    return this.guard(
      `NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN tasks_tasks blocker ON blocker.account_id=? AND blocker.id=selected.value LEFT JOIN tasks_lists list ON list.account_id=blocker.account_id AND list.id=blocker.list_id WHERE blocker.id IS NULL OR blocker.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR blocker.id=?) AND NOT (${cycle.sql})`,
      [JSON.stringify(blockerIds), accountId, taskId, ...cycle.bindings],
    );
  }
  private history(
    row: TaskRow,
    kind: 'labels_changed' | 'priority_changed' | 'star_changed' | 'dependencies_changed',
    before: unknown,
    after: unknown,
    context: MetadataContext,
  ): D1PreparedStatement {
    const input = {
      id: crypto.randomUUID(),
      accountId: row.account_id,
      taskId: row.id,
      listId: row.list_id,
      taskTitle: row.title,
      listTitle: row.list_title,
      recordedAt: context.recordedAt,
      origin: context.origin,
      dedupKey: JSON.stringify(['metadata', context.operationId, context.stepKey, row.id, kind]),
      kind,
      summary: {
        operationId: context.operationId,
        stepKey: context.stepKey,
        ...(context.scheduleId ? { scheduleId: context.scheduleId } : {}),
        ...(context.runId ? { runId: context.runId } : {}),
        before,
        after,
      },
    } as HistoryEventInput;
    return this.options.history.eventWrite(input);
  }

  async prepareTaskPatch(
    accountId: string,
    taskId: string,
    input: unknown,
    expectedRevision: number,
    context: MetadataContext,
    expectedGraphRevision?: number,
  ): Promise<PreparedMetadataPatch> {
    return this.preparePatch(
      accountId,
      taskId,
      input,
      expectedRevision,
      context,
      expectedGraphRevision,
      false,
    );
  }
  /** Internal settlement of captured metadata accompanying an accepted provider write.
   * The caller must fence its dispatched, known-response claim in the same batch and
   * place these CAS writes before the provider projection advances the task revision.
   * This seam may drain after disconnect and must never be exposed as a user command. */
  async prepareConfirmedTaskPatch(
    accountId: string,
    taskId: string,
    input: unknown,
    expectedRevision: number,
    context: MetadataContext,
    expectedGraphRevision?: number,
  ): Promise<PreparedMetadataPatch> {
    return this.preparePatch(
      accountId,
      taskId,
      input,
      expectedRevision,
      context,
      expectedGraphRevision,
      true,
    );
  }
  private async preparePatch(
    accountId: string,
    taskId: string,
    input: unknown,
    expectedRevision: number,
    rawContext: MetadataContext,
    expectedGraphRevision: number | undefined,
    confirmed: boolean,
  ): Promise<PreparedMetadataPatch> {
    parse(id, accountId);
    parse(id, taskId);
    parse(revision, expectedRevision);
    const patch = parse(TaskMetadataPatchSchema, input),
      context = parse(contextSchema, rawContext);
    bounded({ patch, context });
    if (patch.blockedBy !== undefined && expectedGraphRevision === undefined)
      throw new AppError(
        'validation_failed',
        'a dependency edit needs the graph revision',
        422,
        false,
        { expectedGraphRevision: 'refresh the account graph' },
      );
    if (expectedGraphRevision !== undefined) parse(revision, expectedGraphRevision);
    if (!confirmed) await assertLocalWritable(this.db, accountId);
    const row = await this.activeTask(accountId, taskId, expectedRevision);
    if (patch.labelIds !== undefined) await this.validateLabels(accountId, patch.labelIds);
    if (patch.blockedBy !== undefined)
      await this.validateDependencies(accountId, taskId, patch.blockedBy, expectedGraphRevision!);
    const graphRevision = expectedGraphRevision ?? (await this.getGraphRevision(accountId));
    const beforeLabels = JSON.parse(row.labels_json) as string[],
      beforeBlockers = JSON.parse(row.blockers_json) as string[];
    const dependencyChanged =
      patch.blockedBy !== undefined && !same(beforeBlockers, patch.blockedBy);
    const writes = [
      ...(confirmed ? [] : [localWriteGuard(this.db, accountId)]),
      this.guard(
        `EXISTS (SELECT 1 FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.id=? AND t.revision=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL)`,
        [accountId, taskId, expectedRevision],
      ),
    ];
    if (patch.labelIds !== undefined) writes.push(this.labelsGuard(accountId, patch.labelIds));
    if (patch.blockedBy !== undefined)
      writes.push(
        this.graphGuard(accountId, graphRevision),
        this.blockersGuard(accountId, taskId, patch.blockedBy),
      );
    writes.push(
      this.db
        .prepare(
          'UPDATE tasks_tasks SET priority=?,starred=?,revision=revision+1 WHERE account_id=? AND id=?',
        )
        .bind(
          patch.priority ?? row.priority,
          patch.starred === undefined ? row.starred : Number(patch.starred),
          accountId,
          taskId,
        ),
      this.db
        .prepare(
          'UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id=?',
        )
        .bind(accountId, row.list_id),
    );
    if (patch.labelIds !== undefined) {
      writes.push(
        this.db
          .prepare('DELETE FROM tasks_task_labels WHERE account_id=? AND task_id=?')
          .bind(accountId, taskId),
        this.db
          .prepare(
            'INSERT INTO tasks_task_labels(account_id,task_id,label_id) SELECT ?,?,value FROM json_each(?)',
          )
          .bind(accountId, taskId, JSON.stringify(patch.labelIds)),
      );
      if (!same(beforeLabels, patch.labelIds))
        writes.push(this.history(row, 'labels_changed', beforeLabels, patch.labelIds, context));
    }
    if (patch.priority !== undefined && patch.priority !== row.priority)
      writes.push(this.history(row, 'priority_changed', row.priority, patch.priority, context));
    if (patch.starred !== undefined && Number(patch.starred) !== row.starred)
      writes.push(this.history(row, 'star_changed', row.starred === 1, patch.starred, context));
    if (patch.blockedBy !== undefined && dependencyChanged) {
      writes.push(
        this.db
          .prepare('DELETE FROM tasks_dependencies WHERE account_id=? AND task_id=?')
          .bind(accountId, taskId),
        this.db
          .prepare(
            'INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) SELECT ?,?,value FROM json_each(?)',
          )
          .bind(accountId, taskId, JSON.stringify(patch.blockedBy)),
        this.db
          .prepare(
            'UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=?',
          )
          .bind(accountId),
        this.history(row, 'dependencies_changed', beforeBlockers, patch.blockedBy, context),
      );
    }
    return {
      writes,
      result: {
        taskId,
        revision: row.revision + 1,
        graphRevision: graphRevision + Number(dependencyChanged),
      },
    };
  }
  async patchTask(
    accountId: string,
    taskId: string,
    input: unknown,
    expectedRevision: number,
    context: MetadataContext,
    expectedGraphRevision?: number,
  ): Promise<MetadataPatchResult> {
    const prepared = await this.prepareTaskPatch(
      accountId,
      taskId,
      input,
      expectedRevision,
      context,
      expectedGraphRevision,
    );
    await this.commit(prepared.writes, async () => {
      await this.prepareTaskPatch(
        accountId,
        taskId,
        input,
        expectedRevision,
        context,
        expectedGraphRevision,
      );
    });
    return prepared.result;
  }

  async createLabel(
    accountId: string,
    input: unknown,
    rawContext: MetadataContext,
    admittedId: string = crypto.randomUUID(),
  ): Promise<Label> {
    parse(id, accountId);
    parse(id, admittedId);
    parse(contextSchema, rawContext);
    const value = parse(LabelInputSchema, input);
    value.name = value.name.normalize('NFC');
    const nameKey = normalizeLabelName(value.name);
    const explain = async () => {
      await assertLocalWritable(this.db, accountId);
      await this.assertLabelNameFree(accountId, nameKey, null);
    };
    await explain();
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.guard('NOT EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND name_key=?)', [
          accountId,
          nameKey,
        ]),
        this.db
          .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES (?,?,?,?,?)')
          .bind(admittedId, accountId, value.name, nameKey, value.color),
      ],
      explain,
    );
    return label(await this.activeLabel(accountId, admittedId));
  }
  async updateLabel(
    accountId: string,
    labelId: string,
    input: unknown,
    expectedRevision: number,
    rawContext: MetadataContext,
  ): Promise<Label> {
    parse(id, accountId);
    parse(id, labelId);
    parse(revision, expectedRevision);
    parse(contextSchema, rawContext);
    const patch = parse(LabelPatchSchema, input);
    if (patch.name !== undefined) patch.name = patch.name.normalize('NFC');
    const explain = async () => {
      await assertLocalWritable(this.db, accountId);
      const row = await this.activeLabel(accountId, labelId, expectedRevision);
      await this.assertLabelNotDeleting(accountId, labelId);
      await this.assertLabelNameFree(
        accountId,
        normalizeLabelName(patch.name ?? row.name),
        labelId,
      );
      return row;
    };
    const row = await explain(),
      name = patch.name ?? row.name,
      nameKey = normalizeLabelName(name);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.guard(
          `EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND id=? AND revision=?) AND NOT EXISTS (SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND label_id=? AND state='pending') AND NOT EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND name_key=? AND id<>?)`,
          [accountId, labelId, expectedRevision, accountId, labelId, accountId, nameKey, labelId],
        ),
        this.db
          .prepare(
            'UPDATE tasks_labels SET name=?,name_key=?,color=?,revision=revision+1 WHERE account_id=? AND id=?',
          )
          .bind(name, nameKey, patch.color ?? row.color, accountId, labelId),
      ],
      async () => {
        await explain();
      },
    );
    return label(await this.activeLabel(accountId, labelId));
  }

  async listPendingLabelDeletions(
    accountId: string,
    input: PendingLabelDeletionsQuery = {},
  ): Promise<Page<LabelDeletionJob>> {
    parse(id, accountId);
    const options = parse(PendingLabelDeletionsQuerySchema, input);
    let anchor: { accountId: string; createdAt: number; id: string } | null = null;
    if (options.cursor) {
      try {
        const encoded = options.cursor
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(options.cursor.length / 4) * 4, '=');
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
        );
        anchor = z
          .object({ accountId: id, createdAt: z.number().int().safe(), id })
          .strict()
          .parse(JSON.parse(decoded));
        if (anchor.accountId !== accountId) throw new Error();
      } catch {
        throw new AppError(
          'validation_failed',
          'the deletion-job page belongs to another account or selection',
          422,
        );
      }
    }
    const rows = await this.rows<JobRow>(
      this.db
        .prepare(
          `SELECT * FROM tasks_label_deletions WHERE account_id=? AND state='pending' ${anchor ? 'AND (created_at,id)>(?,?)' : ''} ORDER BY created_at,id LIMIT ?`,
        )
        .bind(accountId, ...(anchor ? [anchor.createdAt, anchor.id] : []), options.limit + 1),
    );
    const selected = rows.slice(0, options.limit),
      last = selected.at(-1);
    const cursor =
      rows.length > options.limit && last
        ? JSON.stringify({ accountId, createdAt: last.created_at, id: last.id })
        : null;
    const nextCursor = cursor
      ? btoa(String.fromCharCode(...new TextEncoder().encode(cursor)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '')
      : null;
    return {
      items: selected.map(job),
      nextCursor,
      coverage: { complete: true, lastSyncedAt: null, stale: false },
    };
  }

  async getLabelDeletion(accountId: string, jobId: string): Promise<LabelDeletionJob> {
    parse(id, accountId);
    parse(id, jobId);
    const row = await this.first<JobRow>(
      this.db
        .prepare('SELECT * FROM tasks_label_deletions WHERE account_id=? AND id=?')
        .bind(accountId, jobId),
    );
    if (!row) throw new AppError('not_found', 'this label deletion is no longer available', 404);
    return job(row);
  }
  async startLabelDeletion(
    accountId: string,
    labelId: string,
    expectedRevision: number,
    rawContext: MetadataContext,
    admittedJobId: string = crypto.randomUUID(),
  ): Promise<LabelDeletionJob> {
    parse(id, accountId);
    parse(id, labelId);
    parse(id, admittedJobId);
    parse(revision, expectedRevision);
    const context = parse(contextSchema, rawContext);
    const explain = async () => {
      await assertLocalWritable(this.db, accountId);
      const row = await this.activeLabel(accountId, labelId, expectedRevision);
      await this.assertLabelNotDeleting(accountId, labelId);
      return row;
    };
    const row = await explain();
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.guard(
          `EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND id=? AND revision=?) AND NOT EXISTS (SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND label_id=? AND state='pending')`,
          [accountId, labelId, expectedRevision, accountId, labelId],
        ),
        this.db
          .prepare(
            "INSERT INTO tasks_label_deletions(id,account_id,label_id,label_name,state,created_at) VALUES (?,?,?,?,'pending',?)",
          )
          .bind(admittedJobId, accountId, labelId, row.name, Date.parse(context.recordedAt)),
      ],
      async () => {
        await explain();
      },
    );
    return this.getLabelDeletion(accountId, admittedJobId);
  }
  /** One invocation is one journal step. Replaying that receipt must not invoke it again. */
  async continueLabelDeletion(
    accountId: string,
    jobId: string,
    rawContext: MetadataContext,
    limit = 10,
  ): Promise<LabelDeletionJob> {
    parse(id, accountId);
    parse(id, jobId);
    parse(z.number().int().min(1).max(10), limit);
    const context = parse(contextSchema, rawContext);
    await assertLocalWritable(this.db, accountId);
    const current = await this.getLabelDeletion(accountId, jobId);
    if (current.state === 'completed') {
      await this.commit([localWriteGuard(this.db, accountId)], () =>
        assertLocalWritable(this.db, accountId),
      );
      return current;
    }
    const rows = await this.rows<TaskRow>(
      this.db
        .prepare(
          `${taskSelection} JOIN tasks_task_labels selected ON selected.account_id=t.account_id AND selected.task_id=t.id WHERE selected.account_id=? AND selected.label_id=? ORDER BY t.id LIMIT ?`,
        )
        .bind(accountId, current.labelId, limit),
    );
    // Reduce a slice when unusually long identities would exceed the operation budget.
    const selected: TaskRow[] = [];
    for (const row of rows) {
      if (new TextEncoder().encode(JSON.stringify([...selected, row])).byteLength > 60 * 1_024)
        break;
      selected.push(row);
    }
    if (rows.length && !selected.length)
      throw new AppError(
        'validation_failed',
        'one stored label association exceeds the metadata slice limit',
        422,
      );
    const captured = JSON.stringify(
      selected.map((row) => ({ id: row.id, revision: row.revision })),
    );
    const writes = [
      localWriteGuard(this.db, accountId),
      this.guard(
        "EXISTS (SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND id=? AND revision=? AND state='pending')",
        [accountId, jobId, current.revision],
      ),
      this.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN tasks_tasks task ON task.account_id=? AND task.id=json_extract(selected.value,'$.id') WHERE task.id IS NULL OR task.revision<>json_extract(selected.value,'$.revision'))`,
        [captured, accountId],
      ),
      this.db
        .prepare(
          "UPDATE tasks_tasks SET revision=revision+1 WHERE account_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
        )
        .bind(accountId, captured),
      this.db
        .prepare(
          "UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id IN (SELECT list_id FROM tasks_tasks WHERE account_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)))",
        )
        .bind(accountId, accountId, captured),
      this.db
        .prepare(
          "DELETE FROM tasks_task_labels WHERE account_id=? AND label_id=? AND task_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
        )
        .bind(accountId, current.labelId, captured),
    ];
    for (const row of selected) {
      const before = JSON.parse(row.labels_json) as string[];
      if (row.deleted_at === null)
        writes.push(
          this.history(
            row,
            'labels_changed',
            before,
            before.filter((labelId) => labelId !== current.labelId),
            context,
          ),
        );
    }
    writes.push(
      this.db
        .prepare(
          `UPDATE tasks_label_deletions SET removed_associations=removed_associations+?,revision=revision+1,next_attempt_at=?,
      state=CASE WHEN EXISTS (SELECT 1 FROM tasks_task_labels WHERE account_id=? AND label_id=?) THEN 'pending' ELSE 'completed' END,
      completed_at=CASE WHEN EXISTS (SELECT 1 FROM tasks_task_labels WHERE account_id=? AND label_id=?) THEN NULL ELSE ? END WHERE account_id=? AND id=?`,
        )
        .bind(
          selected.length,
          Date.parse(context.recordedAt),
          accountId,
          current.labelId,
          accountId,
          current.labelId,
          Date.parse(context.recordedAt),
          accountId,
          jobId,
        ),
      this.db
        .prepare(
          "DELETE FROM tasks_labels WHERE account_id=? AND id=? AND NOT EXISTS (SELECT 1 FROM tasks_task_labels WHERE account_id=? AND label_id=?) AND EXISTS (SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND id=? AND state='completed')",
        )
        .bind(accountId, current.labelId, accountId, current.labelId, accountId, jobId),
    );
    await this.commit(writes, async () => {
      await assertLocalWritable(this.db, accountId);
      const latest = await this.getLabelDeletion(accountId, jobId);
      if (latest.revision !== current.revision)
        throw new AppError(
          'conflict',
          'this label deletion advanced; refresh its progress before continuing',
          409,
        );
      for (const row of selected) {
        const task = await this.first<{ revision: number }>(
          this.db
            .prepare('SELECT revision FROM tasks_tasks WHERE account_id=? AND id=?')
            .bind(accountId, row.id),
        );
        if (task?.revision !== row.revision)
          throw new AppError(
            'conflict',
            'a task changed during this label deletion slice; retry with a new step',
            409,
          );
      }
    });
    return this.getLabelDeletion(accountId, jobId);
  }

  /** Resolve reusable label definitions in a confirmed create receipt. The caller
   * places these writes before initial task metadata and owns its journal claim fence. */
  async prepareResolveLabelDefinitions(
    accountId: string,
    input: unknown,
    rawContext: MetadataContext,
  ): Promise<{
    writes: D1PreparedStatement[];
    labelIds: string[];
    colorConflicts: { name: string; requestedColor: string; keptColor: string }[];
  }> {
    parse(id, accountId);
    const context = parse(contextSchema, rawContext),
      definitions = parse(z.array(LabelInputSchema).max(20), input);
    bounded(definitions);
    const normalized = definitions.map((value) => ({
      ...value,
      name: value.name.normalize('NFC'),
      key: normalizeLabelName(value.name),
    }));
    if (new Set(normalized.map((value) => value.key)).size !== normalized.length)
      throw new AppError('validation_failed', 'use each normalized label name once', 422);
    const known = await this.rows<LabelRow & { deleting: number }>(
      this.db
        .prepare(
          "SELECT label.*,EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending') AS deleting FROM tasks_labels label WHERE label.account_id=? AND label.name_key IN (SELECT value FROM json_each(?))",
        )
        .bind(accountId, JSON.stringify(normalized.map((value) => value.key))),
    );
    const selected = [];
    const colorConflicts: { name: string; requestedColor: string; keptColor: string }[] = [];
    for (const definition of normalized) {
      const existing = known.find((value) => value.name_key === definition.key);
      if (existing) {
        if (existing.deleting)
          throw new AppError('conflict', 'a reusable label is being deleted', 409);
        if (existing.color !== definition.color)
          colorConflicts.push({
            name: existing.name,
            requestedColor: definition.color,
            keptColor: existing.color,
          });
        selected.push({
          ...definition,
          id: existing.id,
          existing: true,
          revision: existing.revision,
        });
      } else {
        const bytes = new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(
              JSON.stringify([accountId, context.operationId, context.stepKey, definition.key]),
            ),
          ),
        );
        selected.push({
          ...definition,
          id:
            'label-' +
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
              .join('')
              .slice(0, 32),
          existing: false,
          revision: 0,
        });
      }
    }
    if (!selected.length) return { writes: [], labelIds: [], colorConflicts: [] };
    const encoded = JSON.stringify(selected);
    const writes = [
      this.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) definition LEFT JOIN tasks_labels label ON label.account_id=? AND label.name_key=json_extract(definition.value,'$.key') WHERE (json_extract(definition.value,'$.existing')=1 AND (label.id IS NULL OR label.id<>json_extract(definition.value,'$.id') OR label.revision<>json_extract(definition.value,'$.revision'))) OR (json_extract(definition.value,'$.existing')=0 AND label.id IS NOT NULL) OR EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=? AND job.label_id=label.id AND job.state='pending'))`,
        [encoded, accountId, accountId],
      ),
      this.db
        .prepare(
          `INSERT INTO tasks_labels(id,account_id,name,name_key,color) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.key'),json_extract(value,'$.color') FROM json_each(?) WHERE json_extract(value,'$.existing')=0`,
        )
        .bind(accountId, encoded),
    ];
    return { writes, labelIds: selected.map((value) => value.id), colorConflicts };
  }

  /** Initial edges of a captured copy, after every copied identity exists. The
   * caller fences its claimed local journal step and updates copy receipt baselines
   * in the same batch. Existing labels/priority/star survive; no edit history is invented. */
  async prepareCopiedDependencies(
    accountId: string,
    input: { taskId: string; expectedTaskRevision: number; blockedBy: string[] }[],
    rawContext: MetadataContext,
    expectedGraphRevision: number,
  ): Promise<D1PreparedStatement[]> {
    parse(id, accountId);
    parse(contextSchema, rawContext);
    parse(revision, expectedGraphRevision);
    const copies = parse(
      z
        .array(
          z
            .object({
              taskId: id,
              expectedTaskRevision: revision,
              blockedBy: z
                .array(id)
                .max(50)
                .refine(
                  (values) => new Set(values).size === values.length,
                  'use each blocker once',
                ),
            })
            .strict(),
        )
        .max(10)
        .refine(
          (values) => new Set(values.map((value) => value.taskId)).size === values.length,
          'use each copy once',
        ),
      input,
    );
    bounded(copies);
    if (!copies.length) return [];
    const encoded = JSON.stringify(copies),
      hasEdges = copies.some((value) => value.blockedBy.length > 0);
    const writes = [
      this.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy LEFT JOIN tasks_tasks task ON task.account_id=? AND task.id=json_extract(copy.value,'$.taskId') LEFT JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.id IS NULL OR task.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR task.revision<>json_extract(copy.value,'$.expectedTaskRevision') OR EXISTS (SELECT 1 FROM tasks_dependencies edge WHERE edge.account_id=task.account_id AND edge.task_id=task.id))`,
        [encoded, accountId],
      ),
    ];
    if (!hasEdges) return writes;
    writes.push(
      this.graphGuard(accountId, expectedGraphRevision),
      this.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy,json_each(copy.value,'$.blockedBy') selected LEFT JOIN tasks_tasks blocker ON blocker.account_id=? AND blocker.id=selected.value LEFT JOIN tasks_lists list ON list.account_id=blocker.account_id AND list.id=blocker.list_id WHERE blocker.id IS NULL OR blocker.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR blocker.id=json_extract(copy.value,'$.taskId'))`,
        [encoded, accountId],
      ),
      this.db
        .prepare(
          `INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) SELECT ?,json_extract(copy.value,'$.taskId'),selected.value FROM json_each(?) copy,json_each(copy.value,'$.blockedBy') selected`,
        )
        .bind(accountId, encoded),
      this.guard(
        `NOT EXISTS (WITH RECURSIVE reach(source,target) AS (SELECT json_extract(value,'$.taskId'),json_extract(value,'$.taskId') FROM json_each(?) UNION SELECT reach.source,edge.blocker_id FROM reach JOIN tasks_dependencies edge ON edge.account_id=? AND edge.task_id=reach.target) SELECT 1 FROM reach JOIN tasks_dependencies edge ON edge.account_id=? AND edge.task_id=reach.target AND edge.blocker_id=reach.source)`,
        [encoded, accountId, accountId],
      ),
      this.db
        .prepare(
          `UPDATE tasks_tasks SET revision=revision+1 WHERE account_id=? AND id IN (SELECT json_extract(value,'$.taskId') FROM json_each(?) WHERE json_array_length(value,'$.blockedBy')>0)`,
        )
        .bind(accountId, encoded),
      this.db
        .prepare(
          `UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id IN (SELECT list_id FROM tasks_tasks WHERE account_id=? AND id IN (SELECT json_extract(value,'$.taskId') FROM json_each(?) WHERE json_array_length(value,'$.blockedBy')>0))`,
        )
        .bind(accountId, accountId, encoded),
      this.db
        .prepare(
          'UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=?',
        )
        .bind(accountId),
    );
    return writes;
  }

  /** Pre-admission checks for a direct create. Copied-set remapping is captured by
   * its operation planner; new identities do not exist yet at this boundary. */
  async validateCreationMetadata(
    accountId: string,
    input: unknown,
    expectedGraphRevision?: number,
  ): Promise<void> {
    return this.validateCreationMetadataBatch(accountId, [input], expectedGraphRevision);
  }
  /** Validate a bounded capture chunk without one database request per field/task. */
  async validateCreationMetadataBatch(
    accountId: string,
    input: unknown[],
    expectedGraphRevision?: number,
  ): Promise<void> {
    parse(id, accountId);
    const item = z
      .object({
        labelIds: z.array(id).max(20).default([]),
        priority: PrioritySchema.default('none'),
        starred: z.boolean().default(false),
        blockedBy: z.array(id).max(50).default([]),
      })
      .strict()
      .refine(
        (value) =>
          new Set(value.labelIds).size === value.labelIds.length &&
          new Set(value.blockedBy).size === value.blockedBy.length,
        'use each metadata identity once',
      );
    const values = parse(z.array(item).max(10), input);
    bounded(values);
    await assertLocalWritable(this.db, accountId);
    const encoded = JSON.stringify(values);
    const invalid = await this.first<{ reason: string }>(
      this.db
        .prepare(
          `SELECT 'missing_label' AS reason FROM json_each(?) item,json_each(item.value,'$.labelIds') selected LEFT JOIN tasks_labels label ON label.account_id=? AND label.id=selected.value WHERE label.id IS NULL
      UNION ALL SELECT 'deleting_label' FROM json_each(?) item,json_each(item.value,'$.labelIds') selected JOIN tasks_label_deletions job ON job.account_id=? AND job.label_id=selected.value AND job.state='pending'
      UNION ALL SELECT 'missing_blocker' FROM json_each(?) item,json_each(item.value,'$.blockedBy') selected LEFT JOIN tasks_tasks task ON task.account_id=? AND task.id=selected.value LEFT JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.id IS NULL OR task.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL LIMIT 1`,
        )
        .bind(encoded, accountId, encoded, accountId, encoded, accountId),
    );
    if (invalid?.reason === 'deleting_label')
      throw new AppError('conflict', 'a selected label is being deleted', 409);
    if (invalid)
      throw new AppError(
        'validation_failed',
        'choose retained labels and blockers from this account',
        422,
      );
    if (expectedGraphRevision !== undefined) parse(revision, expectedGraphRevision);
    if (!values.some((value) => value.blockedBy.length)) return;
    if (expectedGraphRevision === undefined)
      throw new AppError('validation_failed', 'new task dependencies need the graph revision', 422);
    if ((await this.getGraphRevision(accountId)) !== expectedGraphRevision)
      throw new AppError(
        'conflict',
        'the dependency graph changed; refresh before creating the task',
        409,
      );
  }

  /** Run after confirmed create projection writes, in their same atomic receipt batch.
   * The caller captures/remaps copied dependencies; this seam also serves direct creation.
   * The caller must fence its dispatched, known-response journal claim. This internal
   * settlement may drain after disconnect; it must never be exposed as a user command.
   * Existing task metadata is never overwritten. No live-edit/completion events are made. */
  async prepareCreatedMetadata(
    accountId: string,
    input: CreatedTaskMetadata[],
    rawContext: MetadataContext,
    expectedGraphRevision: number,
  ): Promise<D1PreparedStatement[]> {
    parse(id, accountId);
    parse(revision, expectedGraphRevision);
    const context = parse(contextSchema, rawContext),
      copies = parse(createdSchema, input);
    bounded({ copies, context });
    if (!copies.length) return [];
    const encoded = JSON.stringify(copies),
      hasEdges = copies.some((copy) => copy.blockedBy.length > 0);
    const writes = [
      this.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy LEFT JOIN tasks_tasks task ON task.account_id=? AND task.id=json_extract(copy.value,'$.taskId') LEFT JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.id IS NULL OR task.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR task.revision<>json_extract(copy.value,'$.expectedTaskRevision') OR task.priority<>'none' OR task.starred<>0 OR EXISTS (SELECT 1 FROM tasks_task_labels labels WHERE labels.account_id=task.account_id AND labels.task_id=task.id) OR EXISTS (SELECT 1 FROM tasks_dependencies deps WHERE deps.account_id=task.account_id AND deps.task_id=task.id))`,
        [encoded, accountId],
      ),
      this.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy,json_each(copy.value,'$.labelIds') selected LEFT JOIN tasks_labels label ON label.account_id=? AND label.id=selected.value WHERE label.id IS NULL OR EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending'))`,
        [encoded, accountId],
      ),
    ];
    if (hasEdges)
      writes.push(
        this.graphGuard(accountId, expectedGraphRevision),
        this.guard(
          `NOT EXISTS (SELECT 1 FROM json_each(?) copy,json_each(copy.value,'$.blockedBy') selected LEFT JOIN tasks_tasks blocker ON blocker.account_id=? AND blocker.id=selected.value LEFT JOIN tasks_lists list ON list.account_id=blocker.account_id AND list.id=blocker.list_id WHERE blocker.id IS NULL OR blocker.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR blocker.id=json_extract(copy.value,'$.taskId'))`,
          [encoded, accountId],
        ),
      );
    writes.push(
      this.db
        .prepare(
          `UPDATE tasks_tasks SET priority=(SELECT json_extract(value,'$.priority') FROM json_each(?) WHERE json_extract(value,'$.taskId')=tasks_tasks.id),starred=(SELECT json_extract(value,'$.starred') FROM json_each(?) WHERE json_extract(value,'$.taskId')=tasks_tasks.id) WHERE account_id=? AND id IN (SELECT json_extract(value,'$.taskId') FROM json_each(?))`,
        )
        .bind(encoded, encoded, accountId, encoded),
      this.db
        .prepare(
          `INSERT INTO tasks_task_labels(account_id,task_id,label_id) SELECT ?,json_extract(copy.value,'$.taskId'),selected.value FROM json_each(?) copy,json_each(copy.value,'$.labelIds') selected`,
        )
        .bind(accountId, encoded),
      this.db
        .prepare(
          "UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id IN (SELECT list_id FROM tasks_tasks WHERE account_id=? AND id IN (SELECT json_extract(value,'$.taskId') FROM json_each(?)))",
        )
        .bind(accountId, accountId, encoded),
    );
    if (hasEdges) {
      writes.push(
        this.db
          .prepare(
            `INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) SELECT ?,json_extract(copy.value,'$.taskId'),selected.value FROM json_each(?) copy,json_each(copy.value,'$.blockedBy') selected`,
          )
          .bind(accountId, encoded),
        // Check the final SQL graph after every copied edge has been inserted.
        this.guard(
          `NOT EXISTS (WITH RECURSIVE reach(source,target) AS (
          SELECT json_extract(value,'$.taskId'),json_extract(value,'$.taskId') FROM json_each(?)
          UNION SELECT reach.source,edge.blocker_id FROM reach JOIN tasks_dependencies edge ON edge.account_id=? AND edge.task_id=reach.target
        ) SELECT 1 FROM reach JOIN tasks_dependencies edge ON edge.account_id=? AND edge.task_id=reach.target AND edge.blocker_id=reach.source)`,
          [encoded, accountId, accountId],
        ),
        this.db
          .prepare(
            'UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=?',
          )
          .bind(accountId),
      );
    }
    return writes;
  }
}
