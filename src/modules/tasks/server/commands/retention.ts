import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';

const day = 86_400_000;
async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
const tables = [
  { name: 'tasks_command_copy_graph_edges', key: 'source_key,target_key' },
  { name: 'tasks_command_copy_graph_nodes', key: 'node_key' },
  { name: 'tasks_command_copy_validation', key: 'operation_id' },
  { name: 'tasks_command_copy_receipts', key: 'item_key' },
  { name: 'tasks_command_copy_entries', key: 'item_key' },
  { name: 'tasks_command_copy_lists', key: 'item_key' },
  { name: 'tasks_command_copy_sources', key: 'item_key' },
  { name: 'tasks_command_move_members', key: 'task_id' },
  { name: 'tasks_command_projection_deltas', key: 'step_key,list_id' },
  { name: 'tasks_command_locks', key: 'list_id' },
  { name: 'tasks_command_resources', key: 'list_id' },
  { name: 'tasks_command_steps', key: 'item_key' },
] as const;

/** Finished command bodies are staging, not an indefinite title/note version store.
 * Minimal request/chunk hashes, identities and copy baselines survive for receipt replay. */
export class CommandRetention {
  readonly receiptJoin = 'LEFT JOIN tasks_command_plans p ON p.operation_id=o.id';
  readonly payloadPrunable = '(p.operation_id IS NULL OR p.payload_pruned_at IS NOT NULL)';
  readonly captureAbsent =
    'NOT EXISTS(SELECT 1 FROM tasks_command_plans p WHERE p.operation_id=o.id)';
  constructor(private readonly db: D1Database) {}
  async cleanup(limit = 100, now = Date.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(now))
      throw new AppError('validation_failed', 'clean up at most 100 captured rows at a time.', 422);
    let remaining = limit,
      changed = 0;
    const cutoff = now - day,
      expired = now - 90 * day;
    const count = (n: number) => {
      remaining -= n;
      changed += n;
    };
    const terminal = `EXISTS(SELECT 1 FROM tasks_operations o WHERE o.id=p.operation_id AND o.terminal_at IS NOT NULL AND o.terminal_at<=?)`;
    // Hash a few headers per slice before dropping their private request bodies.
    const plans = (
      await this.db
        .prepare(
          `SELECT p.operation_id,p.request_json FROM tasks_command_plans p WHERE p.payload_pruned_at IS NULL AND ${terminal} ORDER BY p.created_at,p.operation_id LIMIT ?`,
        )
        .bind(cutoff, Math.min(remaining, 5))
        .all<{ operation_id: string; request_json: string }>()
    ).results;
    if (plans.length) {
      const writes: D1PreparedStatement[] = [];
      for (const plan of plans)
        writes.push(
          this.db
            .prepare(
              `UPDATE tasks_command_plans SET request_hash=?,request_json='{}',payload_pruned_at=?,copy_context_json=CASE WHEN copy_context_json IS NULL THEN NULL ELSE json_object('version',2,'sealed',json('true'),'source',json_extract(copy_context_json,'$.source'),'origin',json_extract(copy_context_json,'$.origin'),'totalTasks',json_extract(copy_context_json,'$.totalTasks'),'totalLists',json_extract(copy_context_json,'$.totalLists'),'newListCount',json_extract(copy_context_json,'$.newListCount')) END WHERE operation_id=? AND payload_pruned_at IS NULL`,
            )
            .bind(await hash(plan.request_json), now, plan.operation_id),
        );
      const results = await this.db.batch(writes);
      count(results.reduce((sum, result) => sum + result.meta.changes, 0));
    }
    // Caller-visible captured chunks retain their own hashes for exact append replay.
    for (const name of ['tasks_command_copy_entries', 'tasks_command_copy_lists'] as const) {
      if (!remaining) break;
      const rows = (
        await this.db
          .prepare(
            `SELECT body.operation_id,body.item_key,body.input_json FROM ${name} body JOIN tasks_command_plans p ON p.operation_id=body.operation_id WHERE body.input_json<>'{}' AND ${terminal} ORDER BY p.created_at,p.operation_id,body.item_key LIMIT ?`,
          )
          .bind(cutoff, Math.min(remaining, 10))
          .all<{ operation_id: string; item_key: string; input_json: string }>()
      ).results;
      if (!rows.length) continue;
      const writes: D1PreparedStatement[] = [];
      for (const row of rows)
        writes.push(
          this.db
            .prepare(
              `UPDATE ${name} SET input_hash=?,input_json='{}'${name === 'tasks_command_copy_lists' ? ",list_json='{}'" : ''} WHERE operation_id=? AND item_key=? AND input_json<>'{}'`,
            )
            .bind(await hash(row.input_json), row.operation_id, row.item_key),
        );
      const results = await this.db.batch(writes);
      count(results.reduce((sum, result) => sum + result.meta.changes, 0));
    }
    for (const descriptor of [
      {
        name: 'tasks_command_steps',
        condition: "body.input_json<>'{}'",
        set: "input_json='{}'",
        key: 'item_key',
      },
      {
        name: 'tasks_command_copy_sources',
        condition: "body.input_json<>'{}'",
        set: "input_json='{}'",
        key: 'item_key',
      },
      {
        name: 'tasks_command_move_members',
        condition:
          "body.response_json IS NOT NULL AND (body.response_json<>'{}' OR body.title_key IS NOT NULL OR body.search_text IS NOT NULL)",
        set: "response_json='{}',title_key=NULL,search_text=NULL",
        key: 'task_id',
      },
    ]) {
      if (!remaining) break;
      const result = await this.db
        .prepare(
          `UPDATE ${descriptor.name} SET ${descriptor.set} WHERE (operation_id,${descriptor.key}) IN(SELECT body.operation_id,body.${descriptor.key} FROM ${descriptor.name} body JOIN tasks_command_plans p ON p.operation_id=body.operation_id WHERE ${descriptor.condition} AND ${terminal} ORDER BY p.created_at,p.operation_id,body.${descriptor.key} LIMIT ?)`,
        )
        .bind(cutoff, remaining)
        .run();
      count(result.meta.changes);
    }
    // Validation scratch is dispensable after the immutable copy is sealed. An
    // abandoned terminal checkpoint can also be removed with its 24-hour payloads.
    for (const table of tables.slice(0, 3)) {
      if (!remaining) break;
      const keys = table.key.split(',');
      const result = await this.db
        .prepare(
          `DELETE FROM ${table.name} WHERE (operation_id,${table.key}) IN
        (SELECT body.operation_id,${keys.map((key) => 'body.' + key).join(',')} FROM ${table.name} body
         JOIN tasks_command_plans p ON p.operation_id=body.operation_id LEFT JOIN tasks_operations o ON o.id=p.operation_id
         WHERE json_extract(p.copy_context_json,'$.sealed')=1 OR o.terminal_at<=?
         ORDER BY p.created_at,p.operation_id,${keys.map((key) => 'body.' + key).join(',')} LIMIT ?)`,
        )
        .bind(cutoff, remaining)
        .run();
      count(result.meta.changes);
    }
    // Finished minimal receipts expire after 90 days. Never cascade thousands of rows
    // through an operation deletion: this owner removes its children in bounded slices.
    const eligible = `((o.terminal_at IS NOT NULL AND o.terminal_at<=?) OR (o.id IS NULL AND p.created_at<=? AND CAST(substr(p.operation_id,1,13) AS INTEGER)<=?))`;
    for (const table of tables) {
      if (!remaining) break;
      const keys = table.key.split(',');
      const result = await this.db
        .prepare(
          `DELETE FROM ${table.name} WHERE (operation_id,${table.key}) IN(SELECT body.operation_id,${keys.map((key) => 'body.' + key).join(',')} FROM ${table.name} body JOIN tasks_command_plans p ON p.operation_id=body.operation_id LEFT JOIN tasks_operations o ON o.id=p.operation_id WHERE ${eligible} ORDER BY p.created_at,p.operation_id,${keys.map((key) => 'body.' + key).join(',')} LIMIT ?)`,
        )
        .bind(expired, cutoff, cutoff, remaining)
        .run();
      count(result.meta.changes);
    }
    if (remaining) {
      const empty = tables
        .map(
          (table) =>
            `NOT EXISTS(SELECT 1 FROM ${table.name} body WHERE body.operation_id=p.operation_id)`,
        )
        .join(' AND ');
      const result = await this.db
        .prepare(
          `DELETE FROM tasks_command_plans WHERE operation_id IN(SELECT p.operation_id FROM tasks_command_plans p LEFT JOIN tasks_operations o ON o.id=p.operation_id WHERE ${eligible} AND ${empty} ORDER BY p.created_at,p.operation_id LIMIT ?)`,
        )
        .bind(expired, cutoff, cutoff, remaining)
        .run();
      count(result.meta.changes);
    }
    return changed;
  }
}
