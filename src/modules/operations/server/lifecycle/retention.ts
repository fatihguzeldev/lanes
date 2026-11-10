import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { OperationResources } from '../journal/resources';

/** Retention never ages out unfinished work or commits provider requests. */
export class OperationRetention {
  private readonly captures: OperationResources['captures'];
  private readonly lists: OperationResources['lists'];
  constructor(
    private readonly db: D1Database,
    resources: OperationResources,
  ) {
    this.captures = resources.captures;
    this.lists = resources.lists;
  }

  /** Bound child-row deletion as well as operation count; unfinished work is never aged out. */
  async pruneTerminalPayloads(limit = 100, now = Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'prune at most100 terminal payload rows.', 400);
    const cutoff = now - 86_400_000;
    const allowed = `o.terminal_at<=? AND ${this.captures.payloadPrunable}`;
    const stepResult = await this.db
      .prepare(
        `UPDATE tasks_operation_steps SET input_json='null',response_json=NULL WHERE (operation_id,item_key) IN
      (SELECT s.operation_id,s.item_key FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
       ${this.captures.receiptJoin} WHERE ${allowed} AND (s.input_json<>'null' OR s.response_json IS NOT NULL)
       ORDER BY o.terminal_at,o.id,s.position LIMIT ?)`,
      )
      .bind(cutoff, limit)
      .run();
    const changed = stepResult.meta.changes;
    if (changed >= limit) return changed;
    const operationResult = await this.db
      .prepare(
        `UPDATE tasks_operations SET input_json='null' WHERE id IN
      (SELECT o.id FROM tasks_operations o ${this.captures.receiptJoin}
       WHERE ${allowed} AND o.input_json<>'null' ORDER BY o.terminal_at,o.id LIMIT ?)`,
      )
      .bind(cutoff, limit - changed)
      .run();
    return changed + operationResult.meta.changes;
  }

  async cleanup(limit = 100, now = Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'cleanup accepts at most100 records.', 400);
    const cutoff = now - 90 * 86_400_000;
    let remaining = limit;
    for (const table of ['tasks_operation_stops', 'tasks_operation_resolutions'] as const) {
      const result = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE (operation_id,item_key) IN
        (SELECT r.operation_id,r.item_key FROM ${table} r JOIN tasks_operations o ON o.id=r.operation_id
         WHERE o.terminal_at<=? ORDER BY o.terminal_at,o.id LIMIT ?)`,
        )
        .bind(cutoff, remaining)
        .run();
      remaining -= result.meta.changes;
      if (!remaining) return 0;
    }
    const steps = await this.db
      .prepare(
        `DELETE FROM tasks_operation_steps WHERE (operation_id,item_key) IN
        (SELECT s.operation_id,s.item_key FROM tasks_operation_steps s JOIN tasks_operations o ON o.id=s.operation_id
         WHERE o.terminal_at<=? AND o.state IN ('succeeded','failed','cancelled','partial')
         AND ${this.captures.captureAbsent}
         ORDER BY o.terminal_at,o.id,s.position LIMIT ?)`,
      )
      .bind(cutoff, remaining)
      .run();
    remaining -= steps.meta.changes;
    if (!remaining) return 0;
    // Remove this child explicitly: deleting its parent would hide a cascade from the budget.
    const reservations = await this.lists.cleanup(cutoff, remaining);
    remaining -= reservations.meta.changes;
    if (!remaining) return 0;
    const operations = await this.db
      .prepare(
        `DELETE FROM tasks_operations WHERE id IN
        (SELECT o.id FROM tasks_operations o WHERE o.terminal_at<=? AND o.state IN ('succeeded','failed','cancelled','partial')
         AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id)
         AND ${this.captures.captureAbsent}
         AND NOT EXISTS(SELECT 1 FROM tasks_operation_resolutions r WHERE r.operation_id=o.id)
         AND NOT EXISTS(SELECT 1 FROM tasks_operation_stops stopped WHERE stopped.operation_id=o.id)
         ORDER BY o.terminal_at,o.id LIMIT ?)`,
      )
      .bind(cutoff, remaining)
      .run();
    return operations.meta.changes;
  }
}
