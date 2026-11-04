import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';
import type { Priority } from '../../contracts/task';
import { PrioritySchema } from '../../contracts/task';
import { TaskMetadataPatchSchema } from '../../contracts/metadata-commands';
import type { TaskRow } from './records';
import type {
  MetadataContext,
  TaskMetadataOptions,
  MetadataPatchResult,
  PreparedMetadataPatch,
  CreatedTaskMetadata,
} from './context';
import { id, revision, contextSchema, createdSchema, parse, bounded } from './validation';
import { MetadataPersistence, taskSelection } from './persistence';
import { TaskLabelService } from './labels';
import { LabelDeletionService } from './label-deletion';

function same(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const ordered = [...right].sort();
  return [...left].sort().every((value, index) => value === ordered[index]);
}

export class TaskMetadataService {
  private readonly persistence: MetadataPersistence;
  readonly labels: TaskLabelService;
  readonly labelDeletions: LabelDeletionService;
  constructor(
    private readonly db: D1Database,
    options: TaskMetadataOptions,
  ) {
    this.persistence = new MetadataPersistence(db, options);
    this.labels = new TaskLabelService(db, this.persistence);
    this.labelDeletions = new LabelDeletionService(db, this.persistence, this.labels);
  }

  private async activeTask(
    accountId: string,
    taskId: string,
    expectedRevision: number,
  ): Promise<TaskRow> {
    const row = await this.persistence.first<TaskRow>(
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

  async getGraphRevision(accountId: string): Promise<number> {
    parse(id, accountId);
    const row = await this.persistence.first<{ graph_revision: number }>(
      this.db
        .prepare('SELECT graph_revision FROM tasks_account_state WHERE account_id=?')
        .bind(accountId),
    );
    if (!row) throw new AppError('not_found', 'this account graph is no longer available', 404);
    return row.graph_revision;
  }

  private graphGuard(accountId: string, expectedGraphRevision: number): D1PreparedStatement {
    return this.persistence.guard(
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
    const count = await this.persistence.first<{ n: number }>(
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
    if (
      await this.persistence.first(
        this.db.prepare(`SELECT 1 WHERE ${cycle.sql}`).bind(...cycle.bindings),
      )
    )
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
    return this.persistence.guard(
      `NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN tasks_tasks blocker ON blocker.account_id=? AND blocker.id=selected.value LEFT JOIN tasks_lists list ON list.account_id=blocker.account_id AND list.id=blocker.list_id WHERE blocker.id IS NULL OR blocker.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR blocker.id=?) AND NOT (${cycle.sql})`,
      [JSON.stringify(blockerIds), accountId, taskId, ...cycle.bindings],
    );
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
    if (patch.labelIds !== undefined) await this.labels.validateLabels(accountId, patch.labelIds);
    if (patch.blockedBy !== undefined)
      await this.validateDependencies(accountId, taskId, patch.blockedBy, expectedGraphRevision!);
    const graphRevision = expectedGraphRevision ?? (await this.getGraphRevision(accountId));
    const beforeLabels = JSON.parse(row.labels_json) as string[],
      beforeBlockers = JSON.parse(row.blockers_json) as string[];
    const dependencyChanged =
      patch.blockedBy !== undefined && !same(beforeBlockers, patch.blockedBy);
    const writes = [
      ...(confirmed ? [] : [localWriteGuard(this.db, accountId)]),
      this.persistence.guard(
        `EXISTS (SELECT 1 FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.id=? AND t.revision=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL)`,
        [accountId, taskId, expectedRevision],
      ),
    ];
    if (patch.labelIds !== undefined)
      writes.push(this.labels.labelsGuard(accountId, patch.labelIds));
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
        writes.push(
          this.persistence.history(row, 'labels_changed', beforeLabels, patch.labelIds, context),
        );
    }
    if (patch.priority !== undefined && patch.priority !== row.priority)
      writes.push(
        this.persistence.history(row, 'priority_changed', row.priority, patch.priority, context),
      );
    if (patch.starred !== undefined && Number(patch.starred) !== row.starred)
      writes.push(
        this.persistence.history(row, 'star_changed', row.starred === 1, patch.starred, context),
      );
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
        this.persistence.history(
          row,
          'dependencies_changed',
          beforeBlockers,
          patch.blockedBy,
          context,
        ),
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
    await this.persistence.commit(prepared.writes, async () => {
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
      this.persistence.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy LEFT JOIN tasks_tasks task ON task.account_id=? AND task.id=json_extract(copy.value,'$.taskId') LEFT JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.id IS NULL OR task.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR task.revision<>json_extract(copy.value,'$.expectedTaskRevision') OR EXISTS (SELECT 1 FROM tasks_dependencies edge WHERE edge.account_id=task.account_id AND edge.task_id=task.id))`,
        [encoded, accountId],
      ),
    ];
    if (!hasEdges) return writes;
    writes.push(
      this.graphGuard(accountId, expectedGraphRevision),
      this.persistence.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy,json_each(copy.value,'$.blockedBy') selected LEFT JOIN tasks_tasks blocker ON blocker.account_id=? AND blocker.id=selected.value LEFT JOIN tasks_lists list ON list.account_id=blocker.account_id AND list.id=blocker.list_id WHERE blocker.id IS NULL OR blocker.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR blocker.id=json_extract(copy.value,'$.taskId'))`,
        [encoded, accountId],
      ),
      this.db
        .prepare(
          `INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) SELECT ?,json_extract(copy.value,'$.taskId'),selected.value FROM json_each(?) copy,json_each(copy.value,'$.blockedBy') selected`,
        )
        .bind(accountId, encoded),
      this.persistence.guard(
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
    const invalid = await this.persistence.first<{ reason: string }>(
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
      this.persistence.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy LEFT JOIN tasks_tasks task ON task.account_id=? AND task.id=json_extract(copy.value,'$.taskId') LEFT JOIN tasks_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.id IS NULL OR task.deleted_at IS NOT NULL OR list.deleted_at IS NOT NULL OR task.revision<>json_extract(copy.value,'$.expectedTaskRevision') OR task.priority<>'none' OR task.starred<>0 OR EXISTS (SELECT 1 FROM tasks_task_labels labels WHERE labels.account_id=task.account_id AND labels.task_id=task.id) OR EXISTS (SELECT 1 FROM tasks_dependencies deps WHERE deps.account_id=task.account_id AND deps.task_id=task.id))`,
        [encoded, accountId],
      ),
      this.persistence.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) copy,json_each(copy.value,'$.labelIds') selected LEFT JOIN tasks_labels label ON label.account_id=? AND label.id=selected.value WHERE label.id IS NULL OR EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending'))`,
        [encoded, accountId],
      ),
    ];
    if (hasEdges)
      writes.push(
        this.graphGuard(accountId, expectedGraphRevision),
        this.persistence.guard(
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
        this.persistence.guard(
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
