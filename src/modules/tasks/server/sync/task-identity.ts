import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  GoogleTasksError,
  type GoogleTaskDTO,
  type GoogleTasksClient,
} from '../provider/google-tasks';
import type { ProjectionListRow } from '../projection/store';
import { noCapturedCommand } from './command-fence';

/** Resolve observed addresses before adopting an existing task's identity and metadata. */
export class TaskIdentityReconciliation {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number,
  ) {}

  // The sync coordinator commits these guards and source repairs with its claim and target list fence.
  async prepare(
    accountId: string,
    reader: Pick<GoogleTasksClient, 'getTask'>,
    list: Pick<ProjectionListRow, 'id' | 'provider_id'>,
    records: GoogleTaskDTO[],
  ): Promise<{
    records: GoogleTaskDTO[];
    knownTaskIds: Map<string, string>;
    guards: D1PreparedStatement[];
    sourceWrites: D1PreparedStatement[];
  }> {
    const knownTaskIds = new Map<string, string>();
    const guards: D1PreparedStatement[] = [];
    const sources = new Set<string>();
    const retained: GoogleTaskDTO[] = [];
    for (const task of records) {
      const candidates = task.deleted
        ? []
        : (
            await this.db
              .prepare(
                `SELECT t.id,t.list_id,t.revision,l.provider_id AS provider_list_id,l.projection_revision
            FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
            WHERE t.account_id=? AND t.provider_id=? AND t.deleted_at IS NULL AND t.list_id<>? AND l.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM tasks_tasks current WHERE current.account_id=t.account_id AND current.list_id=? AND current.provider_id=t.provider_id)
            LIMIT 2`,
              )
              .bind(accountId, task.id, list.id, list.id)
              .all<{
                id: string;
                list_id: string;
                revision: number;
                provider_list_id: string;
                projection_revision: number;
              }>()
          ).results;
      const old = candidates.length === 1 ? candidates[0] : undefined;
      if (old) {
        let missing = false;
        try {
          await reader.getTask(old.provider_list_id, task.id);
        } catch (error) {
          if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
          missing = true;
        }
        if (!missing) {
          // A stale list page must not recreate the task at its previous address.
          try {
            const current = await reader.getTask(list.provider_id, task.id);
            if (current.deleted) continue;
          } catch (error) {
            if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
            continue;
          }
        } else {
          knownTaskIds.set(task.id, old.id);
          sources.add(old.list_id);
          guards.push(
            this.db
              .prepare(
                `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(
              SELECT 1 FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
              WHERE t.account_id=? AND t.id=? AND t.list_id=? AND t.provider_id=? AND t.revision=? AND t.deleted_at IS NULL
              AND l.deleted_at IS NULL AND l.projection_revision=? AND ${noCapturedCommand('t.account_id', 't.list_id')} AND ${noCapturedCommand('t.account_id', '?')})`,
              )
              .bind(
                accountId,
                old.id,
                old.list_id,
                task.id,
                old.revision,
                old.projection_revision,
                list.id,
              ),
          );
        }
      }
      retained.push(task);
    }
    const sourceWrites = [...sources].flatMap((source) => [
      this.db
        .prepare(
          'UPDATE tasks_lists SET projection_revision=projection_revision+1,tasks_complete_at=NULL,completed_complete_at=NULL WHERE account_id=? AND id=?',
        )
        .bind(accountId, source),
      this.db
        .prepare(
          `INSERT INTO tasks_sync_list_work(account_id,list_id,priority,next_at,mode) VALUES (?,?,0,?,'full')
        ON CONFLICT(account_id,list_id) DO UPDATE SET priority=0,next_at=MIN(next_at,excluded.next_at),
        mode='full',page_token=NULL,scan_id=NULL,started_at=NULL,updated_min=NULL,
        page_json=NULL,page_offset=0,page_projection_revision=NULL`,
        )
        .bind(accountId, source, this.now()),
    ]);
    return { records: retained, knownTaskIds, guards, sourceWrites };
  }
}
