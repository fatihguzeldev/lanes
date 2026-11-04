import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import { assertProviderWritable, providerWriteGuard } from '../../accounts/access';
import { accountRemovalGuard } from '../../accounts/lifecycle';
import {
  BeginCompletedDeletionSchema,
  ConfirmCompletedDeletionSchema,
  type CompletedDeletionItem,
  type CompletedDeletionState,
  type CompletedDeletionSummary,
} from '../completed-deletion-contract';
import type { TaskCommandService } from './commands/provider-commands';
import type { OperationRecord, OperationStore } from './operations';

interface Options {
  commands: TaskCommandService;
  operations: OperationStore;
  now?: () => number;
}
interface Header {
  id: string;
  account_id: string;
  owner_subject: string;
  list_id: string;
  provider_list_id: string;
  list_title: string;
  list_revision: number;
  projection_revision: number;
  request_hash: string;
  state: CompletedDeletionState;
  selected_count: number;
  total_count: number;
  open_count: number;
  assigned_count: number;
  root_count: number;
  captured_count: number;
  deleted_count: number;
  deleted_roots: number;
  failed_roots: number;
  cancelled_roots: number;
  capture_cursor: string | null;
  capture_hash: string;
  preview_hash: string | null;
  current_task_id: string | null;
  work_claim: string | null;
  work_until: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  payload_pruned_at: number | null;
}
interface Item {
  deletion_id: string;
  task_id: string;
  root_task_id: string;
  parent_id: string | null;
  title: string | null;
  completed: number;
  revision: number;
  provider_id: string;
  provider_etag: string | null;
  is_root: number;
  assignment_source: 'docs' | 'chat' | null;
  child_count: number;
  can_delete: number;
  state: CompletedDeletionItem['state'];
  operation_id: string | null;
  error_code: string | null;
}
const day = 86400000;
const conflict = (
  message = 'the selected list changed. keep these results and prepare a new preview before deleting a different selection.',
) => new AppError('conflict', message, 409);
async function hash(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
const messages: Record<string, string> = {
  conflict:
    'the list or a captured task changed; this selection will not be replaced automatically.',
  outcome_uncertain: 'a deletion may have succeeded. inspect its task operation before continuing.',
  reconnect_required: 'reconnect this account before continuing.',
  permission_required: 'google did not allow this deletion.',
  provider_unavailable: 'google is temporarily unavailable.',
  storage_unavailable: 'progress could not be stored. confirmed outcomes remain retained.',
  validation_failed: 'a captured task cannot be deleted safely.',
  cancelled: 'unsent deletions were cancelled. confirmed deletions remain permanent.',
};
const error = (code: string | null) =>
  code
    ? {
        code,
        message:
          messages[code] ?? 'this task could not be deleted. inspect its retained operation.',
      }
    : null;
const selected = `t.deleted_at IS NULL AND (t.completed=1 OR EXISTS(SELECT 1 FROM tasks_tasks p WHERE p.account_id=t.account_id AND p.id=t.parent_id AND p.deleted_at IS NULL AND p.completed=1))`;
const root = `CASE WHEN EXISTS(SELECT 1 FROM tasks_tasks p WHERE p.account_id=t.account_id AND p.id=t.parent_id AND p.deleted_at IS NULL AND p.completed=1) THEN t.parent_id ELSE t.id END`;

/** Frozen list selection; every provider deletion still belongs to the common task command journal. */
export class CompletedTaskDeletionService {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  private async row(account: string, id: string): Promise<Header> {
    const value = await this.db
      .prepare('SELECT * FROM tasks_completed_deletions WHERE id=? AND account_id=?')
      .bind(id, account)
      .first<Header>();
    if (!value)
      throw new AppError(
        'not_found',
        'this completed-task deletion is not available in the selected account.',
        404,
      );
    return value;
  }
  private guard(sql: string, values: unknown[]) {
    return this.db
      .prepare(`INSERT INTO tasks_write_guards(valid)SELECT 0 WHERE NOT(${sql})`)
      .bind(...values);
  }
  private sourceGuard(row: Header) {
    return this.guard(
      'EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND revision=? AND projection_revision=? AND tasks_complete_at IS NOT NULL AND completed_complete_at IS NOT NULL AND sync_cursor IS NULL AND deleted_at IS NULL AND provider_missing_at IS NULL)',
      [row.account_id, row.list_id, row.list_revision, row.projection_revision],
    );
  }
  private async sourceCurrent(row: Header) {
    return !!(await this.db
      .prepare(
        'SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND revision=? AND projection_revision=? AND tasks_complete_at IS NOT NULL AND completed_complete_at IS NOT NULL AND sync_cursor IS NULL AND deleted_at IS NULL AND provider_missing_at IS NULL',
      )
      .bind(row.account_id, row.list_id, row.list_revision, row.projection_revision)
      .first());
  }
  private async stale(row: Header) {
    await this.db
      .prepare(
        "UPDATE tasks_completed_deletions SET state='stale',error_code='conflict',updated_at=?,work_claim=NULL,work_until=NULL WHERE id=? AND finished_at IS NULL",
      )
      .bind(this.now(), row.id)
      .run();
  }
  async get(account: string, id: string): Promise<CompletedDeletionSummary> {
    const row = await this.row(account, id);
    const active = row.current_task_id
      ? await this.db
          .prepare(
            'SELECT operation_id FROM tasks_completed_deletion_items WHERE deletion_id=? AND task_id=?',
          )
          .bind(id, row.current_task_id)
          .first<string>('operation_id')
      : null;
    return {
      id: row.id,
      accountId: row.account_id,
      listId: row.list_id,
      listTitle: row.list_title,
      listRevision: row.list_revision,
      state: row.state,
      selectedCompletedCount: row.selected_count,
      totalDeleteCount: row.total_count,
      openDescendantCount: row.open_count,
      assignedTaskCount: row.assigned_count,
      rootCount: row.root_count,
      capturedCount: row.captured_count,
      deletedCount: row.deleted_count,
      deletedRootCount: row.deleted_roots,
      failedRootCount: row.failed_roots,
      pendingRootCount: Math.max(
        0,
        row.root_count - row.deleted_roots - row.failed_roots - row.cancelled_roots,
      ),
      previewHash: row.preview_hash,
      operationId: active ?? null,
      coverageComplete: row.state !== 'stale',
      payloadRetained: row.payload_pruned_at === null,
      error: error(row.error_code),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }
  async begin(input: {
    id: string;
    accountId: string;
    ownerSubject: string;
    listId: string;
    listRevision: number;
  }): Promise<CompletedDeletionSummary> {
    const parsed = BeginCompletedDeletionSchema.safeParse({
      id: input.id,
      listRevision: input.listRevision,
    });
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'choose the current list revision and a fresh deletion identity.',
        400,
      );
    const requestHash = await hash([
        input.id,
        input.accountId,
        input.ownerSubject,
        input.listId,
        input.listRevision,
      ]),
      prior = await this.db
        .prepare('SELECT account_id,request_hash FROM tasks_completed_deletions WHERE id=?')
        .bind(input.id)
        .first<{ account_id: string; request_hash: string }>();
    if (prior) {
      if (prior.account_id !== input.accountId || prior.request_hash !== requestHash)
        throw conflict('this deletion identity belongs to a different owner or list selection.');
      return this.get(input.accountId, input.id);
    }
    const active = await this.db
      .prepare(
        'SELECT id FROM tasks_completed_deletions WHERE account_id=? AND list_id=? AND finished_at IS NULL LIMIT 1',
      )
      .bind(input.accountId, input.listId)
      .first<{ id: string }>();
    if (active)
      throw new AppError(
        'conflict',
        'review or cancel the existing unfinished deletion before preparing another selection.',
        409,
        false,
        { deletionId: active.id },
      );
    const now = this.now(),
      issued = Number(input.id.slice(0, 13));
    if (issued > now + 300000 || now - issued > day)
      throw conflict('this unrecorded deletion identity has expired.');
    await assertProviderWritable(this.db, input.accountId);
    const list = await this.db
      .prepare(
        'SELECT id,provider_id,title,revision,projection_revision,tasks_complete_at,completed_complete_at,sync_cursor,provider_missing_at FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL',
      )
      .bind(input.accountId, input.listId)
      .first<{
        id: string;
        provider_id: string;
        title: string;
        revision: number;
        projection_revision: number;
        tasks_complete_at: number | null;
        completed_complete_at: number | null;
        sync_cursor: string | null;
        provider_missing_at: number | null;
      }>();
    if (!list) throw new AppError('not_found', 'the selected task list is not available.', 404);
    if (
      list.revision !== input.listRevision ||
      list.tasks_complete_at === null ||
      list.completed_complete_at === null ||
      list.sync_cursor !== null ||
      list.provider_missing_at !== null
    )
      throw conflict(
        'refresh complete open and completed task coverage before preparing this deletion.',
      );
    const counts = await this.db
      .prepare(
        `SELECT COUNT(*) AS total,SUM(t.completed) AS completed,SUM(CASE WHEN t.completed=0 THEN 1 ELSE 0 END) AS open,SUM(CASE WHEN json_extract(t.capabilities_json,'$.assignmentSource') IS NOT NULL THEN 1 ELSE 0 END) AS assigned,SUM(CASE WHEN t.id=(${root}) THEN 1 ELSE 0 END) AS roots,SUM(CASE WHEN t.unsupported_hierarchy=1 OR t.provider_missing_at IS NOT NULL OR json_extract(t.capabilities_json,'$.canDelete')=0 THEN 1 ELSE 0 END) AS blocked FROM tasks_tasks t WHERE t.account_id=? AND t.list_id=? AND ${selected}`,
      )
      .bind(input.accountId, input.listId)
      .first<{
        total: number;
        completed: number | null;
        open: number | null;
        assigned: number | null;
        roots: number | null;
        blocked: number | null;
      }>();
    if (counts?.blocked)
      throw new AppError(
        'validation_failed',
        'refresh or correct the restricted tasks before deleting this completed selection.',
        422,
      );
    if ((counts?.total ?? 0) > 100000)
      throw new AppError(
        'validation_failed',
        'this selection exceeds the 100,000-task deletion preview bound. use a smaller list.',
        422,
      );
    try {
      await this.db.batch([
        providerWriteGuard(this.db, input.accountId),
        this.guard(
          'EXISTS(SELECT 1 FROM tasks_lists WHERE id=? AND account_id=? AND revision=? AND projection_revision=? AND deleted_at IS NULL)',
          [list.id, input.accountId, list.revision, list.projection_revision],
        ),
        this.db
          .prepare(
            `INSERT INTO tasks_completed_deletions(id,account_id,owner_subject,list_id,provider_list_id,list_title,list_revision,projection_revision,request_hash,state,selected_count,total_count,open_count,assigned_count,root_count,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,'capturing',?,?,?,?,?,?,?) ON CONFLICT(id)DO NOTHING`,
          )
          .bind(
            input.id,
            input.accountId,
            input.ownerSubject,
            input.listId,
            list.provider_id,
            list.title,
            list.revision,
            list.projection_revision,
            requestHash,
            counts?.completed ?? 0,
            counts?.total ?? 0,
            counts?.open ?? 0,
            counts?.assigned ?? 0,
            counts?.roots ?? 0,
            now,
            now,
          ),
      ]);
    } catch {
      const winner = await this.db
        .prepare(
          'SELECT id,request_hash FROM tasks_completed_deletions WHERE account_id=? AND list_id=? AND finished_at IS NULL LIMIT 1',
        )
        .bind(input.accountId, input.listId)
        .first<{ id: string; request_hash: string }>();
      if (winner) {
        if (winner.id === input.id && winner.request_hash === requestHash)
          return this.get(input.accountId, input.id);
        throw new AppError(
          'conflict',
          'another deletion capture already owns this list. review that retained selection.',
          409,
          false,
          { deletionId: winner.id },
        );
      }
      await assertProviderWritable(this.db, input.accountId);
      const current = await this.db
        .prepare(
          'SELECT revision,projection_revision FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL',
        )
        .bind(input.accountId, input.listId)
        .first<{ revision: number; projection_revision: number }>();
      if (
        current?.revision !== list.revision ||
        current.projection_revision !== list.projection_revision
      )
        throw conflict();
      throw new AppError(
        'storage_unavailable',
        'the completed-task deletion preview could not be recorded. no provider request was sent.',
        503,
        true,
      );
    }
    const saved = await this.row(input.accountId, input.id);
    if (saved.request_hash !== requestHash) throw conflict();
    return this.get(input.accountId, input.id);
  }
  async captureNext(account: string, id: string): Promise<CompletedDeletionSummary> {
    const row = await this.row(account, id);
    if (row.state !== 'capturing') return this.get(account, id);
    if (!(await this.sourceCurrent(row))) {
      await this.stale(row);
      return this.get(account, id);
    }
    const items = (
      await this.db
        .prepare(
          `SELECT t.id AS task_id,(${root}) AS root_task_id,t.parent_id,t.title,t.completed,t.revision,t.provider_id,t.provider_etag,CASE WHEN t.id=(${root})THEN 1 ELSE 0 END AS is_root,json_extract(t.capabilities_json,'$.assignmentSource') AS assignment_source,(SELECT COUNT(*)FROM tasks_tasks c WHERE c.account_id=t.account_id AND c.list_id=t.list_id AND c.parent_id=t.id AND c.deleted_at IS NULL) AS child_count,CASE WHEN t.unsupported_hierarchy=0 AND t.provider_missing_at IS NULL AND COALESCE(json_extract(t.capabilities_json,'$.canDelete'),1)=1 THEN 1 ELSE 0 END AS can_delete FROM tasks_tasks t WHERE t.account_id=? AND t.list_id=? AND ${selected} ${row.capture_cursor === null ? '' : 'AND t.id>?'} ORDER BY t.id LIMIT 10`,
        )
        .bind(account, row.list_id, ...(row.capture_cursor === null ? [] : [row.capture_cursor]))
        .all<Omit<Item, 'deletion_id' | 'state' | 'operation_id' | 'error_code'>>()
    ).results;
    let chain = row.capture_hash;
    for (const item of items) chain = await hash([chain, item]);
    const captured = row.captured_count + items.length,
      done = captured === row.total_count;
    if (captured > row.total_count || (!items.length && !done)) {
      await this.stale(row);
      throw conflict();
    }
    const previewHash = done
      ? await hash([
          row.request_hash,
          row.list_revision,
          row.projection_revision,
          row.selected_count,
          row.total_count,
          row.open_count,
          row.assigned_count,
          chain,
        ])
      : null;
    try {
      await this.db.batch([
        this.sourceGuard(row),
        this.guard(
          "EXISTS(SELECT 1 FROM tasks_completed_deletions WHERE id=? AND state='capturing' AND captured_count=? AND capture_hash=?)",
          [id, row.captured_count, row.capture_hash],
        ),
        ...items.map((item) =>
          this.db
            .prepare(
              'INSERT INTO tasks_completed_deletion_items(deletion_id,task_id,root_task_id,parent_id,title,completed,revision,provider_id,provider_etag,is_root,assignment_source,child_count,can_delete)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .bind(
              id,
              item.task_id,
              item.root_task_id,
              item.parent_id,
              item.title,
              item.completed,
              item.revision,
              item.provider_id,
              item.provider_etag,
              item.is_root,
              item.assignment_source,
              item.child_count,
              item.can_delete,
            ),
        ),
        this.db
          .prepare(
            'UPDATE tasks_completed_deletions SET captured_count=?,capture_cursor=?,capture_hash=?,preview_hash=?,state=?,updated_at=? WHERE id=?',
          )
          .bind(
            captured,
            items.at(-1)?.task_id ?? row.capture_cursor,
            chain,
            previewHash,
            done ? 'preview' : 'capturing',
            this.now(),
            id,
          ),
      ]);
    } catch {
      if (!(await this.sourceCurrent(row))) {
        await this.stale(row);
        throw conflict();
      }
      if ((await this.row(account, id)).captured_count === row.captured_count)
        throw new AppError(
          'storage_unavailable',
          'the deletion preview could not be captured.',
          503,
          true,
        );
    }
    return this.get(account, id);
  }
  async confirm(account: string, id: string, input: unknown): Promise<CompletedDeletionSummary> {
    const parsed = ConfirmCompletedDeletionSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'confirm the frozen selection, open descendants and assigned tasks.',
        400,
      );
    const row = await this.row(account, id);
    if (parsed.data.previewHash !== row.preview_hash)
      throw conflict('the frozen deletion preview does not match this confirmation.');
    if (
      parsed.data.confirmOpenDescendantCount !== row.open_count ||
      parsed.data.confirmAssignedTaskCount !== row.assigned_count
    )
      throw new AppError(
        'validation_failed',
        'acknowledge every open descendant and assigned task shown in this preview.',
        422,
      );
    if (row.state !== 'preview') {
      if (
        ['running', 'partial', 'uncertain', 'paused', 'finished', 'cancelled'].includes(row.state)
      )
        return this.get(account, id);
      throw conflict();
    }
    await assertProviderWritable(this.db, account);
    if (!(await this.sourceCurrent(row))) {
      await this.stale(row);
      throw conflict();
    }
    try {
      await this.db.batch([
        providerWriteGuard(this.db, account),
        this.sourceGuard(row),
        this.guard(
          "EXISTS(SELECT 1 FROM tasks_completed_deletions WHERE id=? AND state='preview' AND preview_hash=?)",
          [id, parsed.data.previewHash],
        ),
        this.db
          .prepare(
            "UPDATE tasks_completed_deletion_items SET state='pending' WHERE deletion_id=? AND state='captured'",
          )
          .bind(id),
        this.db
          .prepare(
            'UPDATE tasks_completed_deletions SET state=?,finished_at=?,updated_at=? WHERE id=?',
          )
          .bind(
            row.root_count ? 'running' : 'finished',
            row.root_count ? null : this.now(),
            this.now(),
            id,
          ),
      ]);
    } catch {
      const saved = await this.row(account, id);
      if (
        saved.preview_hash === parsed.data.previewHash &&
        ['running', 'partial', 'uncertain', 'paused', 'finished', 'cancelled'].includes(saved.state)
      )
        return this.get(account, id);
      if (!(await this.sourceCurrent(row))) {
        await this.stale(row);
        throw conflict();
      }
      await assertProviderWritable(this.db, account);
      throw new AppError(
        'storage_unavailable',
        'the deletion confirmation could not be recorded. no provider request was sent.',
        503,
        true,
      );
    }
    return this.get(account, id);
  }
  /** Only the common known task.delete receipt may join these statements to its fenced commit. */
  prepareConfirmedDeletionWrites(
    account: string,
    operationId: string,
    taskId: string,
  ): D1PreparedStatement[] {
    const relation = `SELECT i.deletion_id FROM tasks_completed_deletion_items i JOIN tasks_completed_deletions r ON r.id=i.deletion_id WHERE i.operation_id=? AND i.task_id=? AND i.is_root=1 AND i.state<>'deleted' AND r.account_id=?`;
    return [
      this.db
        .prepare(
          `UPDATE tasks_completed_deletions SET deleted_count=deleted_count+(SELECT COUNT(*)FROM tasks_completed_deletion_items WHERE deletion_id=tasks_completed_deletions.id AND root_task_id=? AND state<>'deleted'),deleted_roots=deleted_roots+1,projection_revision=projection_revision+COALESCE((SELECT SUM(d.delta) FROM tasks_command_projection_deltas d WHERE d.operation_id=? AND d.list_id=tasks_completed_deletions.list_id),0),current_task_id=NULL,updated_at=? WHERE id IN(${relation})`,
        )
        .bind(taskId, operationId, this.now(), operationId, taskId, account),
      this.db
        .prepare(
          `UPDATE tasks_completed_deletion_items SET state='deleted',error_code=NULL WHERE deletion_id IN(SELECT i.deletion_id FROM tasks_completed_deletion_items i JOIN tasks_completed_deletions r ON r.id=i.deletion_id WHERE i.operation_id=? AND i.task_id=? AND i.is_root=1 AND r.account_id=?) AND root_task_id=?`,
        )
        .bind(operationId, taskId, account, taskId),
    ];
  }
  prepareDispatchGuards(
    account: string,
    operationId: string,
    taskId: string,
  ): D1PreparedStatement[] {
    return [
      this.guard(
        "NOT EXISTS(SELECT 1 FROM tasks_completed_deletion_items i JOIN tasks_completed_deletions r ON r.id=i.deletion_id WHERE i.operation_id=? AND i.task_id=? AND r.account_id=? AND r.state<>'running')",
        [operationId, taskId, account],
      ),
    ];
  }
  private async reconcile(row: Header, item: Item, operation: OperationRecord): Promise<void> {
    if (!operation.finished) {
      const state =
        operation.state === 'uncertain'
          ? 'uncertain'
          : ['reconnect_required', 'blocked_by_limit', 'failed'].includes(operation.state)
            ? 'paused'
            : 'running';
      await this.db
        .prepare(
          'UPDATE tasks_completed_deletions SET state=?,error_code=?,updated_at=? WHERE id=?',
        )
        .bind(
          state,
          state === 'uncertain'
            ? 'outcome_uncertain'
            : state === 'paused'
              ? 'reconnect_required'
              : null,
          this.now(),
          row.id,
        )
        .run();
      return;
    }
    const current = await this.db
      .prepare('SELECT state FROM tasks_completed_deletion_items WHERE deletion_id=? AND task_id=?')
      .bind(row.id, item.task_id)
      .first<string>('state');
    if (current === 'deleted') return;
    if (operation.state === 'succeeded')
      throw new AppError(
        'storage_unavailable',
        'the task deletion receipt is confirmed but its bulk checkpoint is missing. do not repeat it.',
        503,
        true,
      );
    const code =
      (await this.options.operations.summary(operation.id, row.account_id))?.error?.code ??
      'conflict';
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE tasks_completed_deletions SET failed_roots=failed_roots+1,current_task_id=NULL,state=CASE WHEN state='cancelled' THEN state ELSE 'partial' END,error_code=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks_completed_deletion_items WHERE deletion_id=? AND task_id=? AND state NOT IN('failed','deleted','cancelled'))",
        )
        .bind(code, this.now(), row.id, row.id, item.task_id),
      this.db
        .prepare(
          "UPDATE tasks_completed_deletion_items SET state='failed',error_code=? WHERE deletion_id=? AND root_task_id=? AND state NOT IN('deleted','cancelled')",
        )
        .bind(code, row.id, item.task_id),
    ]);
  }
  async advance(account: string, id: string): Promise<CompletedDeletionSummary> {
    const initial = await this.row(account, id);
    if (initial.state !== 'running') return this.get(account, id);
    const claim = crypto.randomUUID(),
      now = this.now();
    const claimed = await this.db
      .prepare(
        "UPDATE tasks_completed_deletions SET work_claim=?,work_until=?,work_order=work_order+1,updated_at=? WHERE id=? AND state='running' AND (work_until IS NULL OR work_until<=?)",
      )
      .bind(claim, now + 30000, now, id, now)
      .run();
    if (!claimed.meta.changes) return this.get(account, id);
    try {
      const row = await this.row(account, id);
      const item = await this.db
        .prepare(
          "SELECT * FROM tasks_completed_deletion_items WHERE deletion_id=? AND is_root=1 AND state IN('pending','admitted','uncertain') ORDER BY CASE WHEN task_id=? THEN 0 ELSE 1 END,task_id LIMIT 1",
        )
        .bind(id, row.current_task_id)
        .first<Item>();
      if (!item) {
        await this.db
          .prepare(
            "UPDATE tasks_completed_deletions SET state=CASE WHEN failed_roots>0 THEN 'partial' ELSE 'finished' END,finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=?",
          )
          .bind(now, now, id)
          .run();
        return this.get(account, id);
      }
      if (item.operation_id) {
        let operation = await this.options.operations.get(item.operation_id, account);
        if (!operation && now - Number(item.operation_id.slice(0, 13)) > day) {
          if (!(await this.sourceCurrent(row))) {
            await this.stale(row);
            return this.get(account, id);
          }
          // The journal rejects this old unrecorded identity forever. Renew only
          // its unsent child identity; retain the original frozen selection.
          await this.db.batch([
            this.sourceGuard(row),
            this.guard(
              "EXISTS(SELECT 1 FROM tasks_completed_deletions WHERE id=? AND state='running' AND work_claim=?)",
              [id, claim],
            ),
            this.db
              .prepare(
                "UPDATE tasks_completed_deletion_items SET operation_id=NULL,state='pending' WHERE deletion_id=? AND task_id=? AND operation_id=?",
              )
              .bind(id, item.task_id, item.operation_id),
            this.db
              .prepare('UPDATE tasks_completed_deletions SET current_task_id=NULL WHERE id=?')
              .bind(id),
          ]);
          return this.get(account, id);
        }
        if (
          !operation &&
          this.now() - Number(item.operation_id.slice(0, 13)) <= day &&
          (await this.options.commands.hasCapturedCommand(account, item.operation_id))
        ) {
          await this.options.commands.prepare({
            operationId: item.operation_id,
            accountId: account,
            ownerSubject: row.owner_subject,
            command: {
              kind: 'task.delete',
              taskId: item.task_id,
              revision: item.revision,
              confirm: true,
              confirmSubtaskCount: item.child_count,
              ...(row.assigned_count ? { confirmAssignment: true } : {}),
            },
          });
          operation = await this.options.operations.get(item.operation_id, account);
        }
        if (operation) {
          if (!operation.finished && ['accepted', 'running', 'partial'].includes(operation.state))
            await this.options.commands.advance(account, operation.id);
          await this.reconcile(
            row,
            item,
            (await this.options.operations.get(operation.id, account))!,
          );
          return this.get(account, id);
        }
      }
      if (!(await this.sourceCurrent(row))) {
        await this.stale(row);
        return this.get(account, id);
      }
      await assertProviderWritable(this.db, account);
      const operationId = `${now}:${(await hash([id, item.task_id])).slice(0, 32)}`;
      await this.db.batch([
        this.sourceGuard(row),
        this.guard(
          "EXISTS(SELECT 1 FROM tasks_completed_deletions WHERE id=? AND state='running' AND work_claim=?)",
          [id, claim],
        ),
        this.db
          .prepare(
            "UPDATE tasks_completed_deletion_items SET operation_id=?,state='admitted' WHERE deletion_id=? AND task_id=? AND operation_id IS NULL",
          )
          .bind(operationId, id, item.task_id),
        this.db
          .prepare('UPDATE tasks_completed_deletions SET current_task_id=? WHERE id=?')
          .bind(item.task_id, id),
      ]);
      const saved = await this.db
        .prepare(
          'SELECT operation_id FROM tasks_completed_deletion_items WHERE deletion_id=? AND task_id=?',
        )
        .bind(id, item.task_id)
        .first<string>('operation_id');
      if (!saved) throw conflict();
      const guards = [
        this.sourceGuard(row),
        this.guard(
          "EXISTS(SELECT 1 FROM tasks_completed_deletions WHERE id=? AND state='running')",
          [id],
        ),
        this.guard(
          'NOT EXISTS(SELECT 1 FROM tasks_completed_deletion_items i LEFT JOIN tasks_tasks t ON t.account_id=? AND t.id=i.task_id WHERE i.deletion_id=? AND i.root_task_id=? AND (t.id IS NULL OR t.deleted_at IS NOT NULL OR t.list_id<>? OR t.revision<>i.revision OR t.provider_id<>i.provider_id OR t.provider_etag IS NOT i.provider_etag))',
          [account, id, item.task_id, row.list_id],
        ),
      ];
      await this.options.commands.prepare(
        {
          operationId: saved,
          accountId: account,
          ownerSubject: row.owner_subject,
          command: {
            kind: 'task.delete',
            taskId: item.task_id,
            revision: item.revision,
            confirm: true,
            confirmSubtaskCount: item.child_count,
            ...(row.assigned_count ? { confirmAssignment: true } : {}),
          },
        },
        guards,
      );
      // Admission and provider execution use separate bounded invocations.
      // The next slice resumes this exact journal identity.
    } catch (cause) {
      const row = await this.row(account, id);
      if (
        cause instanceof AppError &&
        cause.code === 'conflict' &&
        !(await this.sourceCurrent(row))
      )
        await this.stale(row);
      else {
        const code = cause instanceof AppError ? cause.code : 'storage_unavailable';
        await this.db
          .prepare(
            "UPDATE tasks_completed_deletions SET state='paused',error_code=?,updated_at=? WHERE id=? AND state='running'",
          )
          .bind(code, now, id)
          .run();
        if (!(cause instanceof AppError)) throw cause;
      }
    } finally {
      await this.db
        .prepare(
          'UPDATE tasks_completed_deletions SET work_claim=NULL,work_until=NULL WHERE id=? AND work_claim=?',
        )
        .bind(id, claim)
        .run();
    }
    return this.get(account, id);
  }
  async resume(account: string, id: string): Promise<CompletedDeletionSummary> {
    const row = await this.row(account, id);
    if (row.finished_at !== null || ['capturing', 'preview', 'cancelled'].includes(row.state))
      return this.get(account, id);
    if (row.state === 'stale') throw conflict();
    await assertProviderWritable(this.db, account);
    if (row.current_task_id) {
      const item = await this.db
        .prepare('SELECT * FROM tasks_completed_deletion_items WHERE deletion_id=? AND task_id=?')
        .bind(id, row.current_task_id)
        .first<Item>();
      const operation = item?.operation_id
        ? await this.options.operations.get(item.operation_id, account)
        : null;
      if (item && operation) {
        if (['reconnect_required', 'blocked_by_limit'].includes(operation.state))
          await this.options.operations.resume(operation.id, account, this.now());
        await this.reconcile(
          row,
          item,
          (await this.options.operations.get(operation.id, account))!,
        );
        if (!operation.finished) return this.get(account, id);
      }
    }
    const current = await this.row(account, id);
    if (!(await this.sourceCurrent(current))) {
      await this.stale(current);
      throw conflict();
    }
    await this.db
      .prepare(
        "UPDATE tasks_completed_deletions SET state='running',error_code=NULL,updated_at=? WHERE id=? AND finished_at IS NULL AND state<>'cancelled'",
      )
      .bind(this.now(), id)
      .run();
    return this.get(account, id);
  }
  async cancel(account: string, id: string): Promise<CompletedDeletionSummary> {
    const row = await this.row(account, id);
    if (row.finished_at !== null) return this.get(account, id);
    await this.db
      .prepare(
        "UPDATE tasks_completed_deletions SET state='cancelled',error_code='cancelled',updated_at=? WHERE id=?",
      )
      .bind(this.now(), id)
      .run();
    if (row.current_task_id) {
      const item = await this.db
        .prepare('SELECT * FROM tasks_completed_deletion_items WHERE deletion_id=? AND task_id=?')
        .bind(id, row.current_task_id)
        .first<Item>();
      if (item?.operation_id) {
        let operation = await this.options.operations.get(item.operation_id, account);
        if (
          !operation &&
          this.now() - Number(item.operation_id.slice(0, 13)) <= day &&
          (await this.options.commands.hasCapturedCommand(account, item.operation_id))
        ) {
          await this.options.commands.prepare({
            operationId: item.operation_id,
            accountId: account,
            ownerSubject: row.owner_subject,
            command: {
              kind: 'task.delete',
              taskId: item.task_id,
              revision: item.revision,
              confirm: true,
              confirmSubtaskCount: item.child_count,
              ...(row.assigned_count ? { confirmAssignment: true } : {}),
            },
          });
          operation = await this.options.operations.get(item.operation_id, account);
        }
        if (operation && !operation.finished) {
          await this.options.operations.cancel(operation.id, account, this.now());
          const settled = await this.options.operations.get(operation.id, account);
          if (!settled?.finished) return this.get(account, id);
        }
      }
    }
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE tasks_completed_deletions SET cancelled_roots=(SELECT COUNT(*)FROM tasks_completed_deletion_items WHERE deletion_id=? AND is_root=1 AND state NOT IN('deleted','failed')),current_task_id=NULL,finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=?",
        )
        .bind(id, this.now(), this.now(), id),
      this.db
        .prepare(
          "UPDATE tasks_completed_deletion_items SET state='cancelled' WHERE deletion_id=? AND state NOT IN('deleted','failed')",
        )
        .bind(id),
    ]);
    return this.get(account, id);
  }
  async readPreview(account: string, id: string, input: { limit?: number; cursor?: string } = {}) {
    const row = await this.row(account, id),
      limit = this.limit(input.limit),
      cursor = this.cursor(input.cursor, { account, id });
    const items = (
      await this.db
        .prepare(
          `SELECT * FROM tasks_completed_deletion_items WHERE deletion_id=? ${cursor ? 'AND task_id>?' : ''} ORDER BY task_id LIMIT ?`,
        )
        .bind(id, ...(cursor ? [cursor.key] : []), limit + 1)
        .all<Item>()
    ).results;
    return {
      items: items.slice(0, limit).map(
        (item) =>
          ({
            taskId: item.task_id,
            rootTaskId: item.root_task_id,
            parentId: item.parent_id,
            title: item.title,
            completed: item.completed === 1,
            revision: item.revision,
            isRoot: item.is_root === 1,
            assignmentSource: item.assignment_source,
            state: item.state,
            operationId: item.operation_id,
            payloadRetained: item.title !== null,
            error: error(item.error_code),
          }) satisfies CompletedDeletionItem,
      ),
      nextCursor:
        items.length > limit ? this.encode({ account, id, key: items[limit - 1]!.task_id }) : null,
      coverage: {
        complete: row.captured_count === row.total_count,
        stale: row.state === 'stale',
        lastSyncedAt: new Date(row.updated_at).toISOString(),
      },
    };
  }
  async list(account: string, listId: string, input: { limit?: number; cursor?: string } = {}) {
    const limit = this.limit(input.limit),
      cursor = this.cursor(input.cursor, { account, listId });
    const rows = (
      await this.db
        .prepare(
          'SELECT id,created_at,CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END AS phase FROM tasks_completed_deletions WHERE account_id=? AND list_id=? AND (? IS NULL OR (CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END)>? OR ((CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END)=? AND(created_at>? OR(created_at=? AND id>?)))) ORDER BY phase,created_at,id LIMIT ?',
        )
        .bind(
          account,
          listId,
          cursor?.phase ?? null,
          cursor?.phase ?? null,
          cursor?.phase ?? null,
          cursor?.at ?? null,
          cursor?.at ?? null,
          cursor?.key ?? null,
          limit + 1,
        )
        .all<{ id: string; created_at: number; phase: number }>()
    ).results;
    const items = [];
    for (const row of rows.slice(0, limit)) items.push(await this.get(account, row.id));
    return {
      items,
      nextCursor:
        rows.length > limit
          ? this.encode({
              account,
              listId,
              key: rows[limit - 1]!.id,
              at: rows[limit - 1]!.created_at,
              phase: rows[limit - 1]!.phase,
            })
          : null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
    };
  }
  private limit(value = 10) {
    if (!Number.isInteger(value) || value < 1 || value > 10)
      throw new AppError('validation_failed', 'read between one and ten deletion records.', 400);
    return value;
  }
  private encode(value: unknown) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
  }
  private cursor(
    value: string | undefined,
    scope: Record<string, string>,
  ): { key: string; at?: number; phase?: number } | null {
    if (!value) return null;
    try {
      if (value.length > 8192) throw Error();
      const parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
        ),
      ) as Record<string, unknown>;
      if (
        Object.entries(scope).some(([key, item]) => parsed[key] !== item) ||
        typeof parsed.key !== 'string' ||
        parsed.key.length > 2048 ||
        ('listId' in scope && parsed.phase !== 0 && parsed.phase !== 1) ||
        (parsed.at !== undefined &&
          (typeof parsed.at !== 'number' || !Number.isSafeInteger(parsed.at)))
      )
        throw Error();
      return parsed as { key: string; at?: number; phase?: number };
    } catch {
      throw new AppError(
        'validation_failed',
        'this deletion cursor belongs to another account or selection.',
        400,
      );
    }
  }
  async advanceNext(): Promise<CompletedDeletionSummary | null> {
    const row = await this.db
      .prepare(
        "SELECT r.id,r.account_id,r.state FROM tasks_completed_deletions r WHERE finished_at IS NULL AND(state='running' OR(state='cancelled' AND(current_task_id IS NULL OR EXISTS(SELECT 1 FROM tasks_completed_deletion_items i JOIN tasks_operations o ON o.id=i.operation_id WHERE i.deletion_id=r.id AND i.task_id=r.current_task_id AND o.terminal_at IS NOT NULL))))AND(work_until IS NULL OR work_until<=?)ORDER BY work_order,updated_at,id LIMIT 1",
      )
      .bind(this.now())
      .first<{ id: string; account_id: string; state: CompletedDeletionState }>();
    return row
      ? row.state === 'cancelled'
        ? this.cancel(row.account_id, row.id)
        : this.advance(row.account_id, row.id)
      : null;
  }
  async pauseAccount(account: string, limit = 100): Promise<{ done: boolean; pending: boolean }> {
    this.bound(limit);
    const rows = (
      await this.db
        .prepare(
          "SELECT id FROM tasks_completed_deletions WHERE account_id=? AND finished_at IS NULL AND state<>'cancelled' ORDER BY created_at,id LIMIT 1",
        )
        .bind(account)
        .all<{ id: string }>()
    ).results;
    for (const row of rows) await this.cancel(account, row.id);
    const pending = !!(await this.db
      .prepare(
        "SELECT 1 FROM tasks_completed_deletions WHERE account_id=? AND finished_at IS NULL AND state<>'cancelled' LIMIT 1",
      )
      .bind(account)
      .first());
    return { done: !pending && rows.length === 0, pending };
  }
  async removeAccountSlice(
    account: string,
    limit = 100,
  ): Promise<{ done: boolean; deleted: number }> {
    this.bound(limit);
    if (
      !(await this.db
        .prepare('SELECT 1 FROM tasks_completed_deletions WHERE account_id=? LIMIT 1')
        .bind(account)
        .first())
    )
      return { done: true, deleted: 0 };
    if (await this.options.operations.hasUnresolvedProviderWork(account))
      throw new AppError(
        'outcome_uncertain',
        'resolve issued provider outcomes before removing their deletion evidence.',
        409,
      );
    let deleted =
      (
        await this.db.batch([
          accountRemovalGuard(this.db, account),
          this.db
            .prepare(
              'DELETE FROM tasks_completed_deletion_items WHERE rowid IN(SELECT i.rowid FROM tasks_completed_deletion_items i JOIN tasks_completed_deletions r ON r.id=i.deletion_id WHERE r.account_id=? LIMIT ?)',
            )
            .bind(account, limit),
        ])
      )[1]?.meta.changes ?? 0;
    if (deleted < limit)
      deleted +=
        (
          await this.db.batch([
            accountRemovalGuard(this.db, account),
            this.db
              .prepare(
                'DELETE FROM tasks_completed_deletions WHERE id IN(SELECT id FROM tasks_completed_deletions r WHERE account_id=? AND NOT EXISTS(SELECT 1 FROM tasks_completed_deletion_items WHERE deletion_id=r.id)LIMIT ?)',
              )
              .bind(account, limit - deleted),
          ])
        )[1]?.meta.changes ?? 0;
    return {
      done: !(await this.db
        .prepare('SELECT 1 FROM tasks_completed_deletions WHERE account_id=? LIMIT 1')
        .bind(account)
        .first()),
      deleted,
    };
  }
  private bound(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'cleanup between one and one hundred records.', 400);
  }
  async cleanup(limit = 100, now = this.now()): Promise<number> {
    this.bound(limit);
    let changed = (
      await this.db
        .prepare(
          "UPDATE tasks_completed_deletions SET state='cancelled',finished_at=updated_at+?,updated_at=?,error_code='cancelled' WHERE id IN(SELECT id FROM tasks_completed_deletions WHERE state IN('capturing','preview','stale') AND finished_at IS NULL AND updated_at<=? LIMIT ?)",
        )
        .bind(day, now, now - day, limit)
        .run()
    ).meta.changes;
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'UPDATE tasks_completed_deletion_items SET title=NULL WHERE rowid IN(SELECT i.rowid FROM tasks_completed_deletion_items i JOIN tasks_completed_deletions r ON r.id=i.deletion_id WHERE r.finished_at<=? AND i.title IS NOT NULL LIMIT ?)',
          )
          .bind(now - day, limit - changed)
          .run()
      ).meta.changes;
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'UPDATE tasks_completed_deletions SET payload_pruned_at=? WHERE id IN(SELECT id FROM tasks_completed_deletions r WHERE finished_at<=? AND payload_pruned_at IS NULL AND NOT EXISTS(SELECT 1 FROM tasks_completed_deletion_items WHERE deletion_id=r.id AND title IS NOT NULL)LIMIT ?)',
          )
          .bind(now, now - day, limit - changed)
          .run()
      ).meta.changes;
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'DELETE FROM tasks_completed_deletion_items WHERE rowid IN(SELECT i.rowid FROM tasks_completed_deletion_items i JOIN tasks_completed_deletions r ON r.id=i.deletion_id WHERE r.finished_at<=? AND r.payload_pruned_at IS NOT NULL LIMIT ?)',
          )
          .bind(now - 90 * day, limit - changed)
          .run()
      ).meta.changes;
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'DELETE FROM tasks_completed_deletions WHERE id IN(SELECT id FROM tasks_completed_deletions r WHERE finished_at<=? AND NOT EXISTS(SELECT 1 FROM tasks_completed_deletion_items WHERE deletion_id=r.id)LIMIT ?)',
          )
          .bind(now - 90 * day, limit - changed)
          .run()
      ).meta.changes;
    return changed;
  }
}
