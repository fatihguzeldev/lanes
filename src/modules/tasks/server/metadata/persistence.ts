import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { HistoryEventInput } from '../../../history/contracts/events';
import type { TaskRow } from './records';
import type { TaskMetadataOptions, MetadataContext } from './context';

export const taskSelection = `SELECT t.id,t.account_id,t.list_id,t.title,l.title AS list_title,t.priority,t.starred,t.revision,t.deleted_at,
  COALESCE((SELECT json_group_array(label_id) FROM (SELECT label_id FROM tasks_task_labels WHERE account_id=t.account_id AND task_id=t.id ORDER BY label_id)),'[]') AS labels_json,
  COALESCE((SELECT json_group_array(blocker_id) FROM (SELECT blocker_id FROM tasks_dependencies WHERE account_id=t.account_id AND task_id=t.id ORDER BY blocker_id)),'[]') AS blockers_json
  FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id`;

/** Metadata reads, claim guards and history join the caller's receipt transaction. */
export class MetadataPersistence {
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskMetadataOptions,
  ) {}

  async first<T>(statement: D1PreparedStatement): Promise<T | null> {
    try {
      return await statement.first<T>();
    } catch {
      throw new AppError('storage_unavailable', 'metadata could not be read', 503, true);
    }
  }

  async rows<T>(statement: D1PreparedStatement): Promise<T[]> {
    try {
      return (await statement.all<T>()).results;
    } catch {
      throw new AppError('storage_unavailable', 'metadata could not be read', 503, true);
    }
  }

  /** D1 batch update changes=0 does not abort later receipt writes; this CHECK does. */
  guard(condition: string, bindings: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
      .bind(...bindings);
  }

  async commit(writes: D1PreparedStatement[], explain: () => Promise<void>): Promise<void> {
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

  history(
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
}
