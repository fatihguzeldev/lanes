import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import { localWriteGuard, providerWriteGuard } from '../../../accounts/server/connections/access';

const tables = {
  copy: {
    header: 'tasks_command_copy_validation',
    nodes: 'tasks_command_copy_graph_nodes',
    edges: 'tasks_command_copy_graph_edges',
    source: 'tasks_command_copy_entries',
    scope: 'operation_id',
    content: 'input_json',
  },
  template: {
    header: 'tasks_template_validation',
    nodes: 'tasks_template_graph_nodes',
    edges: 'tasks_template_graph_edges',
    source: 'tasks_template_nodes',
    scope: 'snapshot_id',
    content: 'content_json',
  },
} as const;

interface Checkpoint {
  stage: 'building' | 'checking' | 'ready' | 'invalid';
  next_position: number;
  checked_tasks: number;
  total_tasks: number;
  revision: number;
}
export interface DependencyValidationProgress {
  stage: 'building' | 'checking' | 'ready';
  checkedTasks: number;
  totalTasks: number;
  remainingTasks: number;
}
const invalid = () =>
  new AppError('validation_failed', 'the captured dependency references contain a cycle.', 422);
const conflict = () =>
  new AppError(
    'conflict',
    'this dependency validation checkpoint advanced. continue its recorded input.',
    409,
    true,
  );

/** Input-local Kahn validation. Each round removes bounded edges, never transitive paths. */
export class CapturedDependencyValidator {
  constructor(
    private readonly db: D1Database,
    private readonly kind: 'copy' | 'template',
  ) {}
  private get tables() {
    return tables[this.kind];
  }
  private accessGuard(accountId: string) {
    return this.kind === 'copy'
      ? providerWriteGuard(this.db, accountId)
      : localWriteGuard(this.db, accountId);
  }
  private async commit(writes: D1PreparedStatement[]) {
    try {
      return await this.db.batch(writes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw conflict();
    }
  }
  private guard(operationId: string, accountId: string, revision: number): D1PreparedStatement {
    const condition =
      this.kind === 'copy'
        ? `SELECT 1 FROM tasks_command_copy_validation v JOIN tasks_command_plans p ON p.operation_id=v.operation_id JOIN tasks_operations o ON o.id=p.operation_id
         WHERE v.operation_id=? AND v.account_id=? AND v.revision=? AND o.terminal_at IS NULL AND o.cancel_requested=0 AND o.state='accepted'
         AND o.input_sealed=0 AND json_extract(p.copy_context_json,'$.sealed')=0`
        : `SELECT 1 FROM tasks_template_validation v JOIN tasks_template_snapshots snapshot ON snapshot.id=v.snapshot_id
         JOIN tasks_template_documents document ON document.snapshot_id=snapshot.id
         WHERE v.snapshot_id=? AND v.account_id=? AND v.revision=? AND snapshot.account_id=v.account_id AND snapshot.sealed=0`;
    return this.db
      .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(${condition})`)
      .bind(operationId, accountId, revision);
  }
  private async checkpoint(operationId: string, accountId: string): Promise<Checkpoint | null> {
    return this.db
      .prepare(
        `SELECT stage,next_position,checked_tasks,total_tasks,revision FROM ${this.tables.header} WHERE ${this.tables.scope}=? AND account_id=?`,
      )
      .bind(operationId, accountId)
      .first<Checkpoint>();
  }
  async started(operationId: string, accountId: string): Promise<boolean> {
    return (await this.checkpoint(operationId, accountId)) !== null;
  }
  async initialize(
    operationId: string,
    accountId: string,
    totalTasks: number,
    guards: D1PreparedStatement[],
  ): Promise<void> {
    await this.commit([
      this.accessGuard(accountId),
      ...guards,
      this.db
        .prepare(
          `INSERT INTO ${this.tables.header}(${this.tables.scope},account_id,stage,total_tasks) VALUES(?,?,?,?) ON CONFLICT(${this.tables.scope}) DO NOTHING`,
        )
        .bind(operationId, accountId, totalTasks ? 'building' : 'ready', totalTasks),
    ]);
  }
  async advance(operationId: string, accountId: string): Promise<DependencyValidationProgress> {
    let current = await this.checkpoint(operationId, accountId);
    if (!current) throw conflict();
    if (current.stage === 'invalid') throw invalid();
    if (current.stage === 'building') {
      const end = Math.min(current.next_position + 100, current.total_tasks);
      await this.commit([
        this.accessGuard(accountId),
        this.guard(operationId, accountId, current.revision),
        this.db
          .prepare(
            `INSERT INTO ${this.tables.nodes}(${this.tables.scope},node_key,remaining)
     SELECT ${this.tables.scope},item_key,json_array_length(${this.tables.content},'$.dependencyKeys') FROM ${this.tables.source} WHERE ${this.tables.scope}=? AND position>=? AND position<?`,
          )
          .bind(operationId, current.next_position, end),
        this.db
          .prepare(
            `INSERT INTO ${this.tables.edges}(${this.tables.scope},source_key,target_key)
     SELECT entry.${this.tables.scope},entry.item_key,dependency.value FROM ${this.tables.source} entry,json_each(entry.${this.tables.content},'$.dependencyKeys') dependency
      WHERE entry.${this.tables.scope}=? AND entry.position>=? AND entry.position<?`,
          )
          .bind(operationId, current.next_position, end),
        this.db
          .prepare(
            `UPDATE ${this.tables.header} SET next_position=?,stage=?,revision=revision+1 WHERE ${this.tables.scope}=?`,
          )
          .bind(end, end === current.total_tasks ? 'checking' : 'building', operationId),
      ]);
      current = {
        ...current,
        next_position: end,
        stage: end === current.total_tasks ? 'checking' : 'building',
        revision: current.revision + 1,
      };
    }
    // 20 invocation queries at most, independent of graph size or fanout. Processed
    // targets remain queued until every dependent edge has been removed in 500-edge slices.
    for (let round = 0; current.stage === 'checking' && round < 10; round++) {
      const candidates = (
        await this.db
          .prepare(
            `SELECT node_key FROM ${this.tables.nodes} WHERE ${this.tables.scope}=? AND processed=0 AND remaining=0 ORDER BY node_key LIMIT 100`,
          )
          .bind(operationId)
          .all<{ node_key: string }>()
      ).results;
      const selected: string[] = [];
      for (const item of candidates) {
        if (
          selected.length &&
          new TextEncoder().encode(JSON.stringify([...selected, item.node_key])).byteLength > 48000
        )
          break;
        selected.push(item.node_key);
      }
      const json = JSON.stringify(selected);
      const edges = `SELECT edge.rowid FROM ${this.tables.nodes} target JOIN ${this.tables.edges} edge
    ON edge.${this.tables.scope}=target.${this.tables.scope} AND edge.target_key=target.node_key
    WHERE target.${this.tables.scope}=? AND target.processed=1 ORDER BY target.node_key,edge.source_key LIMIT 500`;
      const results = await this.commit([
        this.accessGuard(accountId),
        this.guard(operationId, accountId, current.revision),
        this.db
          .prepare(
            `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE (SELECT COUNT(*) FROM ${this.tables.nodes}
      WHERE ${this.tables.scope}=? AND processed=0 AND remaining=0 AND node_key IN(SELECT value FROM json_each(?)))<>?`,
          )
          .bind(operationId, json, selected.length),
        this.db
          .prepare(
            `UPDATE ${this.tables.nodes} SET processed=1 WHERE ${this.tables.scope}=? AND node_key IN(SELECT value FROM json_each(?))`,
          )
          .bind(operationId, json),
        this.db
          .prepare(
            `UPDATE ${this.tables.nodes} SET remaining=remaining-(SELECT COUNT(*) FROM ${this.tables.edges} edge
      WHERE edge.${this.tables.scope}=${this.tables.nodes}.${this.tables.scope} AND edge.source_key=${this.tables.nodes}.node_key AND edge.rowid IN(${edges}))
      WHERE ${this.tables.scope}=? AND processed=0 AND node_key IN(SELECT edge.source_key FROM ${this.tables.edges} edge WHERE edge.rowid IN(${edges}))`,
          )
          .bind(operationId, operationId, operationId),
        this.db
          .prepare(`DELETE FROM ${this.tables.edges} WHERE rowid IN(${edges})`)
          .bind(operationId),
        this.db
          .prepare(
            `UPDATE ${this.tables.nodes} SET processed=2 WHERE ${this.tables.scope}=? AND processed=1 AND NOT EXISTS
      (SELECT 1 FROM ${this.tables.edges} edge WHERE edge.${this.tables.scope}=${this.tables.nodes}.${this.tables.scope} AND edge.target_key=${this.tables.nodes}.node_key)`,
          )
          .bind(operationId),
        this.db
          .prepare(
            `UPDATE ${this.tables.header} SET checked_tasks=checked_tasks+?,revision=revision+1 WHERE ${this.tables.scope}=?`,
          )
          .bind(selected.length, operationId),
      ]);
      current = {
        ...current,
        checked_tasks: current.checked_tasks + selected.length,
        revision: current.revision + 1,
      };
      if (!selected.length && !results[5]?.meta.changes) {
        const stage: 'ready' | 'invalid' =
          current.checked_tasks === current.total_tasks ? 'ready' : 'invalid';
        await this.commit([
          this.accessGuard(accountId),
          this.guard(operationId, accountId, current.revision),
          this.db
            .prepare(
              `UPDATE ${this.tables.header} SET stage=?,revision=revision+1 WHERE ${this.tables.scope}=?`,
            )
            .bind(stage, operationId),
        ]);
        if (stage === 'invalid') throw invalid();
        current = { ...current, stage, revision: current.revision + 1 };
      }
    }
    if (current.stage === 'invalid') throw invalid();
    return {
      stage: current.stage,
      checkedTasks: current.checked_tasks,
      totalTasks: current.total_tasks,
      remainingTasks: current.total_tasks - current.checked_tasks,
    };
  }
}
