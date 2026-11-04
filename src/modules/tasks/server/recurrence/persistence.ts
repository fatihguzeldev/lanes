import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { OperationRecord } from '../../../operations/server/journal/context';
import type { OperationStore } from '../../../operations/server/journal/store';
import type { Occurrence, Series, TaskRow } from './records';

/** Occurrence reads, claim fences and transactional state transitions. */
export class RecurrencePersistence {
  constructor(
    private readonly db: D1Database,
    private readonly operations: OperationStore,
    private readonly now: () => number,
  ) {}

  async task(accountId: string, taskId: string): Promise<TaskRow | null> {
    return this.db
      .prepare(
        'SELECT id,account_id,list_id,parent_id,title,completed,repeat_rule_json,scheduled_day,series_id,occurrence_id,revision,provider_etag,provider_missing_at,deleted_at FROM tasks_tasks WHERE account_id=? AND id=?',
      )
      .bind(accountId, taskId)
      .first<TaskRow>();
  }

  async series(accountId: string, id: string): Promise<Series | null> {
    return this.db
      .prepare(
        'SELECT id,account_id,active_task_id,state,created_count,revision FROM tasks_recurrence_series WHERE account_id=? AND id=?',
      )
      .bind(accountId, id)
      .first<Series>();
  }

  async occurrence(accountId: string, taskId: string): Promise<Occurrence | null> {
    return this.db
      .prepare(
        "SELECT * FROM tasks_recurrence_occurrences WHERE account_id=? AND source_task_id=? ORDER BY CASE WHEN state IN ('cancelled','stopped','finished') THEN 1 ELSE 0 END,attempt DESC,created_at DESC,id DESC LIMIT 1",
      )
      .bind(accountId, taskId)
      .first<Occurrence>();
  }

  guard(occurrence: Occurrence): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_recurrence_occurrences WHERE id=? AND account_id=? AND claim_id=? AND claim_until>?)',
      )
      .bind(occurrence.id, occurrence.account_id, occurrence.claim_id, this.now());
  }

  async commit(occurrence: Occurrence, writes: D1PreparedStatement[]): Promise<void> {
    try {
      await this.db.batch([this.guard(occurrence), ...writes]);
    } catch {
      throw new AppError(
        'conflict',
        'this recurrence slice no longer owns its captured state',
        409,
        true,
      );
    }
  }

  resolvedTransitionWrites(id: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='resolved',snapshot_json='{}' WHERE id=?",
        )
        .bind(id),
      this.db
        .prepare('DELETE FROM tasks_recurrence_transition_children WHERE transition_id=?')
        .bind(id),
    ];
  }

  async operationState(occurrence: Occurrence, operation: OperationRecord): Promise<void> {
    if (
      operation.state === 'uncertain' ||
      operation.state === 'reconnect_required' ||
      operation.state === 'blocked_by_limit' ||
      operation.state === 'failed' ||
      operation.state === 'cancelled'
    ) {
      const state = operation.state === 'uncertain' ? 'uncertain' : 'paused';
      const summary = await this.operations.queries.summary(operation.id, occurrence.account_id);
      await this.commit(occurrence, [
        this.db
          .prepare(
            'UPDATE tasks_recurrence_occurrences SET state=?,next_at=NULL,error_code=? WHERE id=?',
          )
          .bind(state, summary?.error?.code ?? operation.state, occurrence.id),
        this.db
          .prepare(
            'UPDATE tasks_recurrence_series SET state=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .bind(state, this.now(), occurrence.series_id),
      ]);
    } else {
      const summary = await this.operations.queries.summary(operation.id, occurrence.account_id);
      if (summary?.nextAttemptAt && summary.nextAttemptAt > this.now())
        await this.commit(occurrence, [
          this.db
            .prepare('UPDATE tasks_recurrence_occurrences SET next_at=? WHERE id=?')
            .bind(summary.nextAttemptAt, occurrence.id),
        ]);
    }
  }
}
