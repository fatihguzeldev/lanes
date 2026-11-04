import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type {
  OperationListReservations,
  OperationSqlCondition,
} from '../../../operations/server/journal/resources';
const inventoryFreshness = 60_000;

/** Task list inventory and reservations. The operation journal commits these writes with its receipts. */
export class TaskListReservations implements OperationListReservations {
  constructor(private readonly db: D1Database) {}
  async capacity(
    accountId: string,
    now = Date.now(),
  ): Promise<{ known: number | null; reserved: number; available: number | null; stale: boolean }> {
    const row = await this.db
      .prepare(
        `SELECT inventory_count,inventory_complete_at,
      COALESCE((SELECT SUM(remaining) FROM tasks_list_reservations WHERE account_id=?),0) AS reserved
      FROM tasks_account_state WHERE account_id=?`,
      )
      .bind(accountId, accountId)
      .first<{ inventory_count: number; inventory_complete_at: number | null; reserved: number }>();
    const known =
      row?.inventory_complete_at === null || row?.inventory_complete_at === undefined
        ? null
        : row.inventory_count;
    return {
      known,
      reserved: row?.reserved ?? 0,
      available: known === null ? null : Math.max(0, 2000 - known - (row?.reserved ?? 0)),
      stale: !row?.inventory_complete_at || row.inventory_complete_at < now - inventoryFreshness,
    };
  }
  validate(steps: readonly { kind: string }[], slots: number, sealed: boolean): void {
    const capturedSlots = steps.filter((step) => step.kind === 'list.create').length;
    if (capturedSlots > slots || (sealed && capturedSlots !== slots))
      throw new AppError(
        'validation_failed',
        'the list reservation does not match the captured plan.',
        400,
      );
    if (!Number.isInteger(slots) || slots < 0 || slots > 100)
      throw new AppError(
        'validation_failed',
        'a creation plan can reserve at most 100 new lists.',
        400,
      );
  }
  slotFor(kind: string): number {
    return kind === 'list.create' ? 1 : 0;
  }
  admissionCondition(accountId: string, slots: number, now: number): OperationSqlCondition {
    return {
      sql: `?=0 OR EXISTS
      (SELECT 1 FROM tasks_account_state s WHERE s.account_id=? AND s.inventory_complete_at>=?
       AND s.inventory_count+COALESCE((SELECT SUM(r.remaining) FROM tasks_list_reservations r WHERE r.account_id=s.account_id),0)+?<=2000)`,
      bindings: [slots, accountId, now - inventoryFreshness, slots],
    };
  }
  reserveWrite(
    input: { id: string; accountId: string },
    slots: number,
    now: number,
    inputHash: string,
  ): D1PreparedStatement {
    const exists = `EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND input_hash=?)`;
    return this.db
      .prepare(
        `INSERT INTO tasks_list_reservations(operation_id,account_id,slots,remaining,created_at)
        SELECT ?,?,?,?,? WHERE ${exists} ON CONFLICT(operation_id) DO NOTHING`,
      )
      .bind(input.id, input.accountId, slots, slots, now, input.id, input.accountId, inputHash);
  }
  async explainAdmissionFailure(accountId: string, slots: number, now: number): Promise<never> {
    const inventory = await this.db
      .prepare(
        `SELECT inventory_count,inventory_complete_at,
      COALESCE((SELECT SUM(remaining) FROM tasks_list_reservations WHERE account_id=?),0) AS reserved
      FROM tasks_account_state WHERE account_id=?`,
      )
      .bind(accountId, accountId)
      .first<{ inventory_count: number; inventory_complete_at: number | null; reserved: number }>();
    if (
      !inventory ||
      inventory.inventory_complete_at === null ||
      inventory.inventory_complete_at < now - inventoryFreshness
    )
      throw new AppError(
        'conflict',
        'refresh the complete google list inventory before reserving list capacity.',
        409,
      );
    throw new AppError(
      'list_limit_reached',
      `this action needs ${slots} list slots; ${Math.max(0, 2000 - inventory.inventory_count - inventory.reserved)} are available.`,
      409,
    );
  }
  releaseUnsealedWrite(id: string, accountId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND account_id=? AND state='failed' AND input_sealed=0 AND confirmed_steps=0)`,
      )
      .bind(id, id, accountId);
  }
  releaseRejectedWrite(id: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?
          AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND state IN ('failed','cancelled'))`,
      )
      .bind(id, id);
  }
  releaseFinishedWrite(id: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?
        AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=? AND terminal_at IS NOT NULL)`,
      )
      .bind(id, id);
  }
  stopWrites(accountId: string, operationId: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE tasks_account_state SET inventory_complete_at=NULL,inventory_revision=inventory_revision+1
          WHERE account_id=? AND EXISTS(SELECT 1 FROM tasks_list_reservations WHERE operation_id=? AND remaining>0)`,
        )
        .bind(accountId, operationId),
      this.db
        .prepare('UPDATE tasks_list_reservations SET remaining=0 WHERE operation_id=?')
        .bind(operationId),
    ];
  }
  cancelWrite(id: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE tasks_list_reservations SET remaining=MIN(remaining,
        (SELECT COALESCE(SUM(list_slot),0) FROM tasks_operation_steps WHERE operation_id=? AND state IN ('dispatched','uncertain')))
        WHERE operation_id=?`,
      )
      .bind(id, id);
  }
  confirmWrites(id: string, key: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS
        (SELECT 1 FROM tasks_list_reservations r JOIN tasks_operation_steps s ON s.operation_id=r.operation_id
         JOIN tasks_lists l ON l.account_id=r.account_id AND l.provider_id=json_extract(s.response_json,'$.id') AND l.deleted_at IS NULL
         WHERE r.operation_id=? AND s.item_key=? AND r.remaining>=1)`,
        )
        .bind(id, key),
      this.db
        .prepare(
          `UPDATE tasks_account_state SET inventory_count=inventory_count+CASE WHEN EXISTS
        (SELECT 1 FROM tasks_operation_steps s JOIN tasks_lists l ON l.account_id=tasks_account_state.account_id
         AND l.provider_id=json_extract(s.response_json,'$.id') WHERE s.operation_id=? AND s.item_key=?
         AND l.last_seen_scan=tasks_account_state.last_complete_scan_id AND tasks_account_state.last_complete_scan_id IS NOT NULL)
        THEN 0 ELSE 1 END,inventory_revision=inventory_revision+1
        WHERE account_id=(SELECT account_id FROM tasks_operations WHERE id=?)`,
        )
        .bind(id, key, id),
      this.db
        .prepare('UPDATE tasks_list_reservations SET remaining=remaining-1 WHERE operation_id=?')
        .bind(id),
    ];
  }
  sealCondition(id: string): OperationSqlCondition {
    return {
      sql: `(SELECT COALESCE(SUM(list_slot),0) FROM tasks_operation_steps WHERE operation_id=?)=(SELECT slots FROM tasks_list_reservations WHERE operation_id=?)`,
      bindings: [id, id],
    };
  }
  async cleanup(cutoff: number, remaining: number) {
    return await this.db
      .prepare(
        `DELETE FROM tasks_list_reservations WHERE operation_id IN
      (SELECT r.operation_id FROM tasks_list_reservations r JOIN tasks_operations o ON o.id=r.operation_id
       WHERE o.terminal_at<=? AND NOT EXISTS(SELECT 1 FROM tasks_command_plans p WHERE p.operation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id)
       ORDER BY o.terminal_at,o.id LIMIT ?)`,
      )
      .bind(cutoff, remaining)
      .run();
  }
}
