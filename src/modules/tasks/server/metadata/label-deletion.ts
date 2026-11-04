import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';
import {
  LabelDeletionJobSchema,
  PendingLabelDeletionsQuerySchema,
} from '../../contracts/metadata-commands';
import type {
  LabelDeletionJob,
  PendingLabelDeletionsQuery,
} from '../../contracts/metadata-commands';
import type { JobRow, TaskRow } from './records';
import type { MetadataContext } from './context';
import { id, revision, contextSchema, parse } from './validation';
import { taskSelection, type MetadataPersistence } from './persistence';
import type { TaskLabelService } from './labels';

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

/** Each bounded label deletion slice joins the admitted local operation receipt. */
export class LabelDeletionService {
  constructor(
    private readonly db: D1Database,
    private readonly persistence: MetadataPersistence,
    private readonly labels: TaskLabelService,
  ) {}

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
    const rows = await this.persistence.rows<JobRow>(
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
    const row = await this.persistence.first<JobRow>(
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
      const row = await this.labels.activeLabel(accountId, labelId, expectedRevision);
      await this.labels.assertLabelNotDeleting(accountId, labelId);
      return row;
    };
    const row = await explain();
    await this.persistence.commit(
      [
        localWriteGuard(this.db, accountId),
        this.persistence.guard(
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
      await this.persistence.commit([localWriteGuard(this.db, accountId)], () =>
        assertLocalWritable(this.db, accountId),
      );
      return current;
    }
    const rows = await this.persistence.rows<TaskRow>(
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
      this.persistence.guard(
        "EXISTS (SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND id=? AND revision=? AND state='pending')",
        [accountId, jobId, current.revision],
      ),
      this.persistence.guard(
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
          this.persistence.history(
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
    await this.persistence.commit(writes, async () => {
      await assertLocalWritable(this.db, accountId);
      const latest = await this.getLabelDeletion(accountId, jobId);
      if (latest.revision !== current.revision)
        throw new AppError(
          'conflict',
          'this label deletion advanced; refresh its progress before continuing',
          409,
        );
      for (const row of selected) {
        const task = await this.persistence.first<{ revision: number }>(
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
}
