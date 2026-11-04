import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import { accountRemovalGuard, type LifecycleOwner } from '../../accounts/server/lifecycle/removal';
import { assertDisconnecting, disconnectWorkGuard } from '../../accounts/server/connections/access';
import type { OperationStore } from './operations';
import type { TaskCommandService } from './commands/provider-commands';
import type { CompletedTaskDeletionService } from './completed-deletion';
export interface TasksLifecycleOptions {
  operations: Pick<OperationStore, 'drainDisconnect' | 'hasUnresolvedProviderWork'> & {
    deferDisconnectRepair?(operationId: string, accountId: string): Promise<void>;
  };
  commands: Pick<TaskCommandService, 'advance'>;
  completedDeletion?: Pick<CompletedTaskDeletionService, 'pauseAccount' | 'removeAccountSlice'>;
  now?: () => number;
}
const never = Number.MAX_SAFE_INTEGER;
interface CleanupTable {
  table: string;
  where: string;
}
const direct = (table: string): CleanupTable => ({ table, where: 'target.account_id=?' });
const commandChild = (table: string): CleanupTable => ({
  table,
  where: 'target.operation_id IN(SELECT operation_id FROM tasks_command_plans WHERE account_id=?)',
});
// Children precede parents. Emptying them explicitly keeps FK/trigger cascades
// outside the deletion budget from becoming hidden work.
const cleanup: readonly CleanupTable[] = [
  direct('tasks_recurrence_watches'),
  { table: 'hierarchy', where: '' },
  direct('tasks_recurrence_observation_children'),
  {
    table: 'tasks_recurrence_transition_children',
    where:
      'target.transition_id IN(SELECT id FROM tasks_recurrence_transitions WHERE account_id=?)',
  },
  direct('tasks_recurrence_reopen_requests'),
  {
    table: 'tasks_recurrence_copy_items',
    where:
      'target.occurrence_id IN(SELECT id FROM tasks_recurrence_occurrences WHERE account_id=?)',
  },
  direct('tasks_recurrence_occurrences'),
  direct('tasks_recurrence_series'),
  direct('tasks_recurrence_observations'),
  direct('tasks_recurrence_transitions'),
  direct('tasks_schedule_pauses'),
  direct('tasks_task_labels'),
  direct('tasks_dependencies'),
  direct('tasks_label_deletions'),
  direct('tasks_labels'),
  commandChild('tasks_command_copy_receipts'),
  commandChild('tasks_command_copy_graph_edges'),
  commandChild('tasks_command_copy_graph_nodes'),
  commandChild('tasks_command_copy_validation'),
  commandChild('tasks_command_copy_entries'),
  commandChild('tasks_command_copy_lists'),
  commandChild('tasks_command_copy_sources'),
  commandChild('tasks_command_move_members'),
  commandChild('tasks_command_projection_deltas'),
  commandChild('tasks_command_steps'),
  commandChild('tasks_command_resources'),
  direct('tasks_command_locks'),
  direct('tasks_operation_stops'),
  direct('tasks_operation_resolutions'),
  {
    table: 'tasks_operation_steps',
    where: 'target.operation_id IN(SELECT id FROM tasks_operations WHERE account_id=?)',
  },
  direct('tasks_list_reservations'),
  direct('tasks_command_plans'),
  direct('tasks_operations'),
  direct('tasks_sync_checks'),
  direct('tasks_sync_list_work'),
  direct('tasks_sync_jobs'),
  direct('tasks_tasks'),
  direct('tasks_lists'),
  direct('tasks_account_state'),
];
export class TasksLifecycle implements LifecycleOwner {
  readonly name = 'tasks';
  constructor(
    private readonly db: D1Database,
    private readonly options: TasksLifecycleOptions,
  ) {}
  async pause(accountId: string): Promise<{ done: boolean; pending: boolean }> {
    const now = this.options.now?.() ?? Date.now();
    await assertDisconnecting(this.db, accountId);
    const deletion = await this.options.completedDeletion?.pauseAccount(accountId, 100);
    if (deletion && !deletion.done) return deletion;
    const issued = await this.options.operations.drainDisconnect(accountId, 10, now, {
      sql: "EXISTS(SELECT 1 FROM tasks_command_plans p WHERE p.operation_id=o.id) OR o.kind LIKE 'task.%' OR o.kind LIKE 'list.%'",
      bindings: [],
    });
    if (issued.repairOperationId) {
      try {
        await this.options.commands.advance(accountId, issued.repairOperationId);
      } catch (error) {
        if (error instanceof AppError && error.code === 'storage_unavailable' && error.retryable)
          return { done: false, pending: true };
        if (!this.options.operations.deferDisconnectRepair)
          throw new AppError(
            'installation_unavailable',
            'disconnect repair needs its journal deferral capability',
            503,
          );
        await this.options.operations.deferDisconnectRepair(issued.repairOperationId, accountId);
      }
      return { done: false, pending: false };
    }
    if (!issued.done) return { done: false, pending: issued.pending };
    const active = await this.db
      .prepare(
        `SELECT 1 AS active FROM tasks_sync_jobs WHERE account_id=? AND claim_until>?
      UNION ALL SELECT 1 FROM tasks_recurrence_occurrences WHERE account_id=? AND claim_until>? LIMIT 1`,
      )
      .bind(accountId, now, accountId, now)
      .first();
    if (active) return { done: false, pending: true };
    const sync = await this.db
      .prepare('SELECT 1 AS active FROM tasks_sync_jobs WHERE account_id=? AND next_at<>?')
      .bind(accountId, never)
      .first();
    if (sync) {
      await this.db.batch([
        disconnectWorkGuard(this.db, accountId),
        this.db
          .prepare(
            "UPDATE tasks_sync_jobs SET next_at=?,claim_id=NULL,claim_until=NULL,error_code='reconnect_required' WHERE account_id=?",
          )
          .bind(never, accountId),
      ]);
      return { done: false, pending: false };
    }
    const jobs = (
      await this.db
        .prepare(
          'SELECT id,series_id FROM tasks_recurrence_occurrences WHERE account_id=? AND next_at IS NOT NULL LIMIT 50',
        )
        .bind(accountId)
        .all<{ id: string; series_id: string }>()
    ).results;
    if (jobs.length) {
      await this.db.batch([
        disconnectWorkGuard(this.db, accountId),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_occurrences SET state='paused',next_at=NULL,claim_id=NULL,claim_until=NULL,error_code='reconnect_required' WHERE account_id=? AND id IN(SELECT value FROM json_each(?))",
          )
          .bind(accountId, JSON.stringify(jobs.map((job) => job.id))),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='paused',revision=revision+1,updated_at=? WHERE account_id=? AND id IN(SELECT value FROM json_each(?))",
          )
          .bind(now, accountId, JSON.stringify([...new Set(jobs.map((job) => job.series_id))])),
      ]);
      return { done: false, pending: false };
    }
    const watches = await this.db.batch([
      disconnectWorkGuard(this.db, accountId),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_watches SET next_at=? WHERE rowid IN(SELECT rowid FROM tasks_recurrence_watches WHERE account_id=? AND next_at<>? LIMIT 100)',
        )
        .bind(never, accountId, never),
    ]);
    if (watches[1]?.meta.changes) return { done: false, pending: false };
    const labels = await this.db.batch([
      disconnectWorkGuard(this.db, accountId),
      this.db
        .prepare(
          "UPDATE tasks_label_deletions SET next_attempt_at=? WHERE rowid IN(SELECT rowid FROM tasks_label_deletions WHERE account_id=? AND state='pending' AND next_attempt_at<>? LIMIT 100)",
        )
        .bind(never, accountId, never),
    ]);
    if (labels[1]?.meta.changes) return { done: false, pending: false };
    const series = await this.db.batch([
      disconnectWorkGuard(this.db, accountId),
      this.db
        .prepare(
          "UPDATE tasks_recurrence_series SET state='paused',revision=revision+1,updated_at=? WHERE rowid IN(SELECT rowid FROM tasks_recurrence_series WHERE account_id=? AND state IN('active','pending','undoing') LIMIT 100)",
        )
        .bind(now, accountId),
    ]);
    return { done: !series[1]?.meta.changes, pending: false };
  }
  async hasUnresolved(accountId: string): Promise<boolean> {
    return this.options.operations.hasUnresolvedProviderWork(accountId);
  }
  async pendingProviderWork(accountId: string): Promise<boolean> {
    const result = await this.pause(accountId);
    return !result.done || result.pending;
  }
  async remove(accountId: string, limit = 100): Promise<{ done: boolean; deleted: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError(
        'validation_failed',
        'remove at most 100 local task records per slice',
        422,
      );
    if (await this.hasUnresolved(accountId))
      throw new AppError(
        'outcome_uncertain',
        'resolve issued provider outcomes before discarding their task evidence',
        409,
      );
    const deletion = await this.options.completedDeletion?.removeAccountSlice(accountId, limit);
    if (deletion && (deletion.deleted || !deletion.done)) return deletion;
    const selectionSql = cleanup
      .map((entry, position) =>
        entry.table === 'hierarchy'
          ? `SELECT ${position} AS position WHERE EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND (parent_id IS NOT NULL OR repeat_rule_json IS NOT NULL OR series_id IS NOT NULL OR occurrence_id IS NOT NULL) LIMIT 1)`
          : `SELECT ${position} AS position WHERE EXISTS(SELECT 1 FROM ${entry.table} target WHERE ${entry.where} LIMIT 1)`,
      )
      .join(' UNION ALL ');
    const selected = await this.db
      .prepare(`SELECT position FROM (${selectionSql}) ORDER BY position LIMIT 1`)
      .bind(...cleanup.map(() => accountId))
      .first<{ position: number }>();
    if (!selected) return { done: true, deleted: 0 };
    const entry = cleanup[selected.position]!;
    if (entry.table === 'hierarchy') {
      await this.db.batch([
        accountRemovalGuard(this.db, accountId),
        this.db
          .prepare(
            'UPDATE tasks_tasks SET parent_id=NULL,repeat_rule_json=NULL,series_id=NULL,occurrence_id=NULL WHERE rowid IN(SELECT rowid FROM tasks_tasks WHERE account_id=? AND (parent_id IS NOT NULL OR repeat_rule_json IS NOT NULL OR series_id IS NOT NULL OR occurrence_id IS NOT NULL) LIMIT ?)',
          )
          .bind(accountId, limit),
      ]);
      return { done: false, deleted: 0 };
    }
    const result = await this.db.batch([
      accountRemovalGuard(this.db, accountId),
      this.db
        .prepare(
          `DELETE FROM ${entry.table} WHERE rowid IN(SELECT target.rowid FROM ${entry.table} target WHERE ${entry.where} LIMIT ?)`,
        )
        .bind(accountId, limit),
    ]);
    return { done: false, deleted: result[1]?.meta.changes ?? 0 };
  }
}
