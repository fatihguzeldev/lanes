import type { D1Database } from '@cloudflare/workers-types';
import { type RecurrenceStatus } from '../../contracts/recurrence';
import type { RecurrencePersistence } from './persistence';
import { identity, parseRule } from './state';

export class RecurrenceQueries {
  constructor(
    private readonly db: D1Database,
    private readonly persistence: RecurrencePersistence,
  ) {}

  async status(accountId: string, taskId: string): Promise<RecurrenceStatus | null> {
    identity(accountId);
    identity(taskId);
    const task = await this.persistence.task(accountId, taskId);
    if (!task) return null;
    const occurrence = await this.persistence.occurrence(accountId, taskId);
    const series = task.series_id
      ? await this.persistence.series(accountId, task.series_id)
      : occurrence
        ? await this.persistence.series(accountId, occurrence.series_id)
        : null;
    const pause =
      !task.repeat_rule_json && task.deleted_at === null
        ? await this.db
            .prepare(
              'SELECT rule_json,reason,paused_at FROM tasks_schedule_pauses WHERE account_id=? AND task_id=?',
            )
            .bind(accountId, taskId)
            .first<{
              rule_json: string;
              reason: 'provider_day_removed' | 'provider_nested_task';
              paused_at: number;
            }>()
        : null;
    const pausedRule = pause
      ? { rule: parseRule(pause.rule_json), reason: pause.reason, pausedAt: pause.paused_at }
      : null;
    if (!series && !task.repeat_rule_json && !pausedRule) return null;
    const active = series ? await this.persistence.task(accountId, series.active_task_id) : task;
    const watch = active
      ? await this.db
          .prepare('SELECT next_at FROM tasks_recurrence_watches WHERE account_id=? AND task_id=?')
          .bind(accountId, active.id)
          .first<{ next_at: number }>()
      : null;
    const pausedWatch = watch?.next_at === Number.MAX_SAFE_INTEGER;
    return {
      taskId,
      seriesId: series?.id ?? null,
      occurrenceId: task.occurrence_id,
      state: pausedRule
        ? 'paused'
        : series?.state === 'uncertain'
          ? 'uncertain'
          : task.deleted_at !== null ||
              !active ||
              active.deleted_at !== null ||
              active.repeat_rule_json === null
            ? 'stopped'
            : pausedWatch
              ? 'paused'
              : (series?.state ?? 'active'),
      createdCount: series?.created_count ?? 1,
      successorTaskId: occurrence?.target_task_id ?? null,
      operationId: occurrence?.operation_id ?? null,
      checklistComplete: occurrence?.checklist_complete === 1,
      pausedRule,
      nextAttemptAt: occurrence?.next_at ?? null,
      errorCode: occurrence?.error_code ?? (pausedWatch ? 'reconnect_required' : null),
    };
  }
}
