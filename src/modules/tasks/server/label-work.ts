import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import type { HistoryService } from '../../history/server';
import { TaskMetadataService } from './metadata';

/** The admitted deletion job and its revision serialize each atomic local slice. No provider work is sent. */
export class LabelDeletionWork {
  private readonly metadata: TaskMetadataService;
  constructor(
    private readonly db: D1Database,
    history: HistoryService,
    private readonly now: () => number = Date.now,
  ) {
    this.metadata = new TaskMetadataService(db, {
      history,
      commitWrites: (writes) => db.batch(writes),
    });
  }
  async advanceNext(): Promise<boolean> {
    const job = await this.db
      .prepare(
        `SELECT job.id,job.account_id,job.revision FROM tasks_label_deletions job
      JOIN accounts_connections account ON account.id=job.account_id
      WHERE job.state='pending' AND job.next_attempt_at<=? AND account.state NOT IN('disconnecting','disconnected')
        AND account.disconnect_requested_at IS NULL
      ORDER BY job.next_attempt_at,job.id LIMIT 1`,
      )
      .bind(this.now())
      .first<{ id: string; account_id: string; revision: number }>();
    if (!job) return false;
    try {
      await this.metadata.continueLabelDeletion(
        job.account_id,
        job.id,
        {
          operationId: job.id,
          stepKey: `continue:${job.revision}`,
          origin: 'owner',
          recordedAt: new Date(this.now()).toISOString(),
        },
        10,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'conflict') return false;
      throw error;
    }
    return true;
  }
}
