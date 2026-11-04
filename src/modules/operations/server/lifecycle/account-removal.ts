import type { D1Database } from '@cloudflare/workers-types';
import { accountRemovalGuard } from '../../../accounts/server/lifecycle/write-guards';

export type OperationRemovalTarget = 'stops' | 'resolutions' | 'steps' | 'receipts';

const targets = {
  stops: { table: 'tasks_operation_stops', where: 'target.account_id=?' },
  resolutions: { table: 'tasks_operation_resolutions', where: 'target.account_id=?' },
  steps: {
    table: 'tasks_operation_steps',
    where: 'target.operation_id IN(SELECT id FROM tasks_operations WHERE account_id=?)',
  },
  receipts: { table: 'tasks_operations', where: 'target.account_id=?' },
} as const;

/** The account coordinator retains its existing task-owner cleanup cursor and ordering. */
export class OperationAccountRemoval {
  constructor(private readonly db: D1Database) {}

  selection(target: OperationRemovalTarget, position: number): string {
    const entry = targets[target];
    return `SELECT ${position} AS position WHERE EXISTS(SELECT 1 FROM ${entry.table} target WHERE ${entry.where} LIMIT 1)`;
  }

  async remove(
    target: OperationRemovalTarget,
    accountId: string,
    limit: number,
  ): Promise<{ done: boolean; deleted: number }> {
    const entry = targets[target];
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
