import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { ClaimedStep } from '../../../operations/server/journal/context';
import type { TaskList } from '../../contracts/task';
import { normalizeTaskSearchText } from '../../model/task';
import type {
  GoogleTaskDTO,
  GoogleTaskListDTO,
  GoogleTaskPatch,
  GoogleTasksClient,
} from '../provider/google-tasks';
import { GoogleTaskSchema, GoogleTasksError } from '../provider/google-tasks';
import type { TaskCommandOptions } from './context';
import { CopyEntrySchema } from './copy-contract';
import { TaskCommandEffects } from './effects';
import type { CapturedStep } from './state';
type SettlementOptions = Pick<
  TaskCommandOptions,
  | 'clientFor'
  | 'confirmedTaskDeletionWrites'
  | 'listRemovalWrites'
  | 'metadata'
  | 'operations'
  | 'placementSettlementWrites'
  | 'placementWrites'
  | 'projection'
  | 'providerOrderRefreshWrites'
  | 'remainingProviderRequests'
  | 'now'
>;

/** Commits confirmed provider values, local effects and the execution receipt in one batch. */
export class TaskCommandSettlement {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: SettlementOptions,
    private readonly effects: TaskCommandEffects,
  ) {
    this.now = options.now ?? Date.now;
  }

  private copyReceiptWrite(operationId: string, key: string, taskId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_command_copy_receipts(operation_id,item_key,task_id,revision,provider_etag) SELECT ?,?,id,revision,provider_etag FROM tasks_tasks WHERE id=? ON CONFLICT(operation_id,item_key) DO UPDATE SET revision=excluded.revision,provider_etag=excluded.provider_etag`,
      )
      .bind(operationId, key, taskId);
  }

  async commitCopyDependencies(
    accountId: string,
    claim: ClaimedStep,
    step: CapturedStep,
  ): Promise<void> {
    const rows = (
      await this.db
        .prepare(
          `SELECT e.item_key,e.task_id,e.input_json,r.revision FROM tasks_command_copy_entries e JOIN tasks_command_copy_receipts r ON r.operation_id=e.operation_id AND r.item_key=e.item_key WHERE e.operation_id=? ORDER BY e.position LIMIT 10 OFFSET ?`,
        )
        .bind(claim.operationId, step.copyPosition ?? 0)
        .all<{ item_key: string; task_id: string; input_json: string; revision: number }>()
    ).results;
    const copies = [];
    for (const row of rows) {
      const entry = CopyEntrySchema.parse(JSON.parse(row.input_json));
      const mapped = (
        await this.db
          .prepare(
            'SELECT task_id FROM tasks_command_copy_entries WHERE operation_id=? AND item_key IN(SELECT value FROM json_each(?))',
          )
          .bind(claim.operationId, JSON.stringify(entry.dependencyKeys ?? []))
          .all<{ task_id: string }>()
      ).results.map((value) => value.task_id);
      copies.push({
        taskId: row.task_id,
        expectedTaskRevision: row.revision,
        blockedBy: [...mapped, ...(entry.existingBlockerIds ?? [])],
      });
    }
    const hasEdges = copies.some((value) => value.blockedBy.length);
    if (hasEdges && !this.options.metadata)
      throw new AppError(
        'installation_unavailable',
        'copied dependencies need the metadata owner.',
        503,
      );
    const graph =
      (
        await this.db
          .prepare('SELECT graph_revision FROM tasks_account_state WHERE account_id=?')
          .bind(accountId)
          .first<{ graph_revision: number }>()
      )?.graph_revision ?? 0;
    const writes = hasEdges
      ? await this.options.metadata!.prepareCopiedDependencies(
          accountId,
          copies,
          {
            operationId: claim.operationId,
            stepKey: claim.key,
            origin: step.origin ?? 'owner',
            recordedAt: new Date(this.now()).toISOString(),
            ...(step.scheduleId ? { scheduleId: step.scheduleId } : {}),
            ...(step.runId ? { runId: step.runId } : {}),
          },
          graph,
        )
      : [];
    writes.push(
      ...rows.map((row) => this.copyReceiptWrite(claim.operationId, row.item_key, row.task_id)),
    );
    await this.options.operations.commitLocalStep(
      claim.operationId,
      claim.key,
      claim.claimId!,
      { appliedDependencies: copies.reduce((sum, value) => sum + value.blockedBy.length, 0) },
      await this.withProjectionDeltas(
        accountId,
        claim.operationId,
        claim.key,
        [
          ...new Set(
            (
              await this.db
                .prepare(
                  'SELECT DISTINCT list_id FROM tasks_tasks WHERE account_id=? AND id IN(SELECT value FROM json_each(?))',
                )
                .bind(accountId, JSON.stringify(rows.map((row) => row.task_id)))
                .all<{ list_id: string }>()
            ).results.map((value) => value.list_id),
          ),
        ],
        writes,
      ),
      this.now(),
    );
  }

  private async projectionBases(
    accountId: string,
    listIds: readonly string[],
  ): Promise<{ id: string; projection_revision: number }[]> {
    return (
      await this.db
        .prepare(
          'SELECT id,projection_revision FROM tasks_lists WHERE account_id=? AND id IN(SELECT value FROM json_each(?))',
        )
        .bind(accountId, JSON.stringify([...new Set(listIds)]))
        .all<{ id: string; projection_revision: number }>()
    ).results;
  }

  async withProjectionDeltas(
    accountId: string,
    operationId: string,
    key: string,
    listIds: readonly string[],
    writes: D1PreparedStatement[],
    bases?: { id: string; projection_revision: number }[],
  ): Promise<D1PreparedStatement[]> {
    const rows = bases ?? (await this.projectionBases(accountId, listIds));
    return [
      ...rows.map((row) =>
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND projection_revision=?)',
          )
          .bind(accountId, row.id, row.projection_revision),
      ),
      ...writes,
      ...rows.map((row) =>
        this.db
          .prepare(
            `INSERT INTO tasks_command_projection_deltas(operation_id,step_key,list_id,delta) SELECT ?,?,id,projection_revision-? FROM tasks_lists WHERE account_id=? AND id=? ON CONFLICT(operation_id,step_key,list_id) DO NOTHING`,
          )
          .bind(operationId, key, row.projection_revision, accountId, row.id),
      ),
    ];
  }

  private async verifyMoveMembers(
    accountId: string,
    claim: ClaimedStep,
    step: CapturedStep,
    parent: GoogleTaskDTO,
    provided?: GoogleTasksClient,
  ): Promise<boolean> {
    await this.db.batch([
      this.effects.event(
        accountId,
        claim.operationId,
        claim.key,
        step,
        'task_moved',
        {
          from: { listId: step.list.id, parentId: step.task!.parentId },
          to: { listId: step.destination!.id, parentId: step.parent?.id ?? null },
        },
        parent.updated ?? null,
      ),
    ]);
    const pending = (
      await this.db
        .prepare(
          'SELECT task_id,source_provider_id,target_provider_id FROM tasks_command_move_members WHERE operation_id=? AND response_json IS NULL ORDER BY task_id LIMIT 5',
        )
        .bind(claim.operationId)
        .all<{ task_id: string; source_provider_id: string; target_provider_id: string | null }>()
    ).results;
    if (pending.length) {
      let client: GoogleTasksClient;
      try {
        client = provided ?? (await this.options.clientFor(accountId));
      } catch {
        await this.options.operations.pauseRepair(
          claim.operationId,
          claim.key,
          claim.claimId!,
          { code: 'conflict' },
          this.now(),
        );
        return false;
      }
      const available = Math.max(
        0,
        Math.min(5, Math.floor(this.options.remainingProviderRequests?.() ?? 5)),
      );
      for (const member of pending.slice(0, available)) {
        let current: GoogleTaskDTO;
        try {
          current = await client.getTask(
            step.destination!.providerId,
            member.target_provider_id ?? member.source_provider_id,
          );
        } catch (error) {
          if ((error instanceof GoogleTasksError || error instanceof AppError) && error.retryable) {
            await this.options.operations.deferRepair(
              claim.operationId,
              claim.key,
              claim.claimId!,
              {
                retryAt:
                  this.now() +
                  Math.max(
                    1000,
                    (error instanceof GoogleTasksError ? (error.retryAfterSeconds ?? 1) : 1) * 1000,
                  ),
                code: error.code,
              },
              this.now(),
            );
            return false;
          }
          await this.options.operations.pauseRepair(
            claim.operationId,
            claim.key,
            claim.claimId!,
            { code: 'conflict' },
            this.now(),
          );
          return false;
        }
        if (
          current.deleted ||
          current.parent !== parent.id ||
          current.title === undefined ||
          current.status === undefined ||
          current.assignmentInfo
        ) {
          await this.options.operations.pauseRepair(
            claim.operationId,
            claim.key,
            claim.claimId!,
            { code: 'conflict' },
            this.now(),
          );
          return false;
        }
        await this.db.batch([
          this.db
            .prepare(
              'UPDATE tasks_command_move_members SET target_provider_id=?,response_json=?,title_key=?,search_text=? WHERE operation_id=? AND task_id=?',
            )
            .bind(
              current.id,
              JSON.stringify(current),
              normalizeTaskSearchText(current.title),
              normalizeTaskSearchText(current.title + '\n' + (current.notes ?? '')),
              claim.operationId,
              member.task_id,
            ),
          this.effects.event(
            accountId,
            claim.operationId,
            claim.key + ':child:' + member.task_id,
            { ...step, task: { ...step.task!, id: member.task_id, title: current.title } },
            'task_moved',
            {
              from: { listId: step.list.id, parentId: step.task!.id },
              to: { listId: step.destination!.id, parentId: step.task!.id },
            },
            current.updated ?? null,
          ),
        ]);
      }
    }
    const left = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM tasks_command_move_members WHERE operation_id=? AND response_json IS NULL',
      )
      .bind(claim.operationId)
      .first<{ n: number }>();
    if (left?.n) {
      await this.options.operations.deferRepair(
        claim.operationId,
        claim.key,
        claim.claimId!,
        { retryAt: this.now() },
        this.now(),
      );
      return false;
    }
    return true;
  }

  private moveMemberWrite(
    accountId: string,
    operationId: string,
    step: CapturedStep,
    parentProviderId: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE tasks_tasks SET list_id=?,provider_id=(SELECT target_provider_id FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),provider_parent_id=?,provider_etag=(SELECT json_extract(response_json,'$.etag') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),provider_position=(SELECT json_extract(response_json,'$.position') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),provider_updated_at=(SELECT json_extract(response_json,'$.updated') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),title=(SELECT json_extract(response_json,'$.title') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),title_key=(SELECT title_key FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),notes=COALESCE((SELECT json_extract(response_json,'$.notes') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),''),search_text=(SELECT search_text FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),completed=CASE WHEN (SELECT json_extract(response_json,'$.status') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id)='completed' THEN 1 ELSE 0 END,completed_at=(SELECT json_extract(response_json,'$.completed') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),scheduled_day=(SELECT substr(json_extract(response_json,'$.due'),1,10) FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id),scheduled_time=CASE WHEN (SELECT json_extract(response_json,'$.due') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id) IS NULL THEN NULL ELSE scheduled_time END,time_zone=CASE WHEN (SELECT json_extract(response_json,'$.due') FROM tasks_command_move_members m WHERE m.operation_id=? AND m.task_id=tasks_tasks.id) IS NULL THEN NULL ELSE time_zone END,revision=revision+1,provider_missing_at=NULL WHERE account_id=? AND id IN(SELECT task_id FROM tasks_command_move_members WHERE operation_id=?)`,
      )
      .bind(
        step.destination!.id,
        operationId,
        parentProviderId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId,
        accountId,
        operationId,
      );
  }

  private retireListRelations(accountId: string, listId: string): D1PreparedStatement[] {
    const target = 'SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?';
    const dependants = `SELECT d.task_id FROM tasks_dependencies d WHERE d.account_id=? AND d.blocker_id IN(${target})`;
    return [
      this.db
        .prepare(
          `UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id IN(SELECT list_id FROM tasks_tasks WHERE account_id=? AND id IN(${dependants}))`,
        )
        .bind(accountId, accountId, accountId, accountId, listId),
      this.db
        .prepare(
          `UPDATE tasks_tasks SET revision=revision+1 WHERE account_id=? AND id IN(${dependants})`,
        )
        .bind(accountId, accountId, accountId, listId),
      this.db
        .prepare(
          `UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=? AND EXISTS(SELECT 1 FROM tasks_dependencies WHERE account_id=? AND (task_id IN(${target}) OR blocker_id IN(${target})))`,
        )
        .bind(accountId, accountId, accountId, listId, accountId, listId),
      this.db
        .prepare(`DELETE FROM tasks_schedule_pauses WHERE account_id=? AND task_id IN(${target})`)
        .bind(accountId, accountId, listId),
      this.db
        .prepare(
          `UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE account_id=? AND task_id IN(${target}) AND state IN('captured','pending','admitted')`,
        )
        .bind(accountId, accountId, listId),
    ];
  }

  async commit(
    accountId: string,
    claim: ClaimedStep,
    step: CapturedStep,
    response: unknown,
    client?: GoogleTasksClient,
  ): Promise<void> {
    const bases = await this.projectionBases(accountId, [
      step.list.id,
      ...(step.destination ? [step.destination.id] : []),
    ]);
    const writes: D1PreparedStatement[] = [];
    let result: unknown;
    if (step.action === 'list.create') {
      const list = response as GoogleTaskListDTO;
      const model: TaskList = {
        id: step.targetId!,
        accountId,
        title: list.title ?? step.title!,
        providerId: list.id,
        providerEtag: list.etag ?? null,
        isDefault: false,
        revision: 1,
      };
      writes.push(
        this.db
          .prepare(
            `INSERT INTO tasks_lists(id,account_id,provider_id,provider_etag,title,title_key,revision,last_synced_at,tasks_complete_at,completed_complete_at) VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            model.id,
            accountId,
            model.providerId,
            model.providerEtag,
            model.title,
            normalizeTaskSearchText(model.title),
            this.now(),
            this.now(),
            this.now(),
          ),
        ...this.options.placementWrites!(
          model,
          step.boardId!,
          step.listColor ? { color: step.listColor } : {},
        ),
        ...(this.options.placementSettlementWrites?.(
          accountId,
          model.id,
          step.boardId!,
          claim.operationId,
        ) ?? []),
      );
      result = { listId: model.id };
    } else if (step.action === 'list.rename') {
      const list = response as GoogleTaskListDTO;
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET title=?,title_key=?,provider_etag=?,revision=revision+1,projection_revision=projection_revision+1 WHERE account_id=? AND id=?',
          )
          .bind(
            list.title ?? step.title!,
            normalizeTaskSearchText(list.title ?? step.title!),
            list.etag ?? null,
            accountId,
            step.list.id,
          ),
      );
      result = { listId: step.list.id };
    } else if (step.action === 'list.delete') {
      writes.push(...this.retireListRelations(accountId, step.list.id));
      writes.push(
        this.db
          .prepare(
            `DELETE FROM tasks_task_labels WHERE account_id=? AND task_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?)`,
          )
          .bind(accountId, accountId, step.list.id),
        this.db
          .prepare(
            `DELETE FROM tasks_dependencies WHERE account_id=? AND (task_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?) OR blocker_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?))`,
          )
          .bind(accountId, accountId, step.list.id, accountId, step.list.id),
        this.db
          .prepare(
            "UPDATE tasks_tasks SET deleted_at=?,repeat_rule_json=NULL,scheduled_time=NULL,time_zone=NULL,priority='none',starred=0,revision=revision+1 WHERE account_id=? AND list_id=? AND deleted_at IS NULL",
          )
          .bind(this.now(), accountId, step.list.id),
        this.db
          .prepare(
            'UPDATE tasks_lists SET deleted_at=?,revision=revision+1,projection_revision=projection_revision+1 WHERE account_id=? AND id=?',
          )
          .bind(this.now(), accountId, step.list.id),
        this.db
          .prepare('UPDATE tasks_account_state SET inventory_complete_at=NULL WHERE account_id=?')
          .bind(accountId),
        ...(this.options.listRemovalWrites?.(accountId, step.list.id) ?? []),
      );
      writes.push(
        this.effects.event(accountId, claim.operationId, claim.key, step, 'list_deleted', {
          knownTaskCount: step.taskCount ?? 0,
          coverageComplete: true,
        }),
      );
      result = { listId: step.list.id, deleted: true };
    } else {
      const parsed = GoogleTaskSchema.safeParse(response);
      if (!parsed.success)
        throw new AppError(
          'storage_unavailable',
          'the recorded provider task receipt cannot be projected safely.',
          503,
          true,
        );
      let value = parsed.data;
      if (
        step.action !== 'task.delete' &&
        (value.title === undefined ||
          value.status === undefined ||
          (step.action === 'task.create' &&
            step.parent &&
            value.parent !== step.parent.provider.id) ||
          (step.action === 'task.move' &&
            (value.parent ?? null) !== (step.parent?.provider.id ?? null)))
      ) {
        let reader: GoogleTasksClient;
        try {
          reader = client ?? (await this.options.clientFor(accountId));
          value = await reader.getTask((step.destination ?? step.list).providerId, value.id);
        } catch (error) {
          if ((error instanceof GoogleTasksError || error instanceof AppError) && error.retryable)
            await this.options.operations.deferRepair(
              claim.operationId,
              claim.key,
              claim.claimId!,
              { retryAt: this.now() + 1000, code: error.code },
              this.now(),
            );
          else
            await this.options.operations.pauseRepair(
              claim.operationId,
              claim.key,
              claim.claimId!,
              { code: 'conflict' },
              this.now(),
            );
          return;
        }
        if (
          value.title === undefined ||
          value.status === undefined ||
          value.deleted ||
          (step.action === 'task.create' &&
            step.parent &&
            value.parent !== step.parent.provider.id) ||
          (step.action === 'task.move' &&
            (value.parent ?? null) !== (step.parent?.provider.id ?? null))
        ) {
          await this.options.operations.pauseRepair(
            claim.operationId,
            claim.key,
            claim.claimId!,
            { code: 'conflict' },
            this.now(),
          );
          return;
        }
      }
      if (
        step.action === 'task.move' &&
        step.subtaskCount &&
        step.destination?.id !== step.list.id
      ) {
        if (!(await this.verifyMoveMembers(accountId, claim, step, value, client))) return;
      }
      const list = step.destination ?? step.list,
        id = step.task?.id ?? step.targetId!,
        cleared = new Set<'due' | 'completed' | 'parent'>();
      if ((step.provider as GoogleTaskPatch | undefined)?.dueDay === null) cleared.add('due');
      if ((step.provider as GoogleTaskPatch | undefined)?.completed === null)
        cleared.add('completed');
      if (step.action === 'task.move' && !step.parent) cleared.add('parent');
      if (step.action === 'task.delete') {
        writes.push(
          ...this.options.projection.retireTaskWrites(accountId, id, this.now()),
          this.effects.event(accountId, claim.operationId, claim.key, step, 'task_deleted', {
            parentId: step.task!.parentId,
            knownSubtaskCount: step.subtaskCount ?? 0,
          }),
        );
      } else {
        if (step.action !== 'task.create')
          writes.push(
            ...(await this.effects.metadataWrites(
              accountId,
              claim.operationId,
              claim.key,
              step,
              true,
            )),
          );
        const prepared = await this.options.projection.prepareConfirmedWrites(
          accountId,
          list.id,
          [value],
          {
            knownTaskIds: new Map([[value.id, id]]),
            preserveMissingFields: false,
            clearedFields: new Map([[value.id, cleared]]),
          },
        );
        writes.push(
          ...prepared.writes,
          ...(step.action === 'task.move' &&
          step.subtaskCount &&
          step.destination?.id !== step.list.id
            ? [this.moveMemberWrite(accountId, claim.operationId, step, value.id)]
            : []),
          ...this.effects.scheduleWrites(accountId, claim.operationId, claim.key, step),
        );
        if (step.action === 'task.create')
          writes.push(
            ...(await this.effects.metadataWrites(
              accountId,
              claim.operationId,
              claim.key,
              step,
              true,
            )),
          );
        if (step.action === 'task.create')
          writes.push(
            this.effects.event(
              accountId,
              claim.operationId,
              claim.key,
              step,
              'task_created',
              {
                source: step.source ?? 'direct',
                ...(step.sourceTaskId ? { sourceTaskId: step.sourceTaskId } : {}),
              },
              value.updated ?? null,
            ),
          );
        if (step.event) {
          writes.push(
            this.effects.event(
              accountId,
              claim.operationId,
              claim.key,
              step,
              step.event,
              step.event === 'task_completed'
                ? { completedAt: value.completed ?? null }
                : { previousCompletedAt: step.task!.completedAt },
              value.updated ?? null,
            ),
            ...this.options.projection.prepareCompletionConfirmationWrites(
              accountId,
              id,
              claim.operationId,
            ),
          );
        }
        if (
          step.action === 'task.move' &&
          (step.task!.listId !== list.id || step.task!.parentId !== (step.parent?.id ?? null))
        )
          writes.push(
            this.effects.event(
              accountId,
              claim.operationId,
              claim.key,
              step,
              'task_moved',
              {
                from: { listId: step.task!.listId, parentId: step.task!.parentId },
                to: { listId: list.id, parentId: step.parent?.id ?? null },
              },
              value.updated ?? null,
            ),
          );
      }
      if (step.copyKey) writes.push(this.copyReceiptWrite(claim.operationId, step.copyKey, id));
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id IN (?,?)',
          )
          .bind(accountId, step.list.id, list.id),
      );
      if (step.action === 'task.move')
        writes.push(
          ...(this.options.providerOrderRefreshWrites?.(accountId, [step.list.id, list.id]) ?? []),
        );
      result = {
        taskId: id,
        listId: list.id,
        ...(step.action === 'task.delete' ? { deleted: true } : {}),
      };
    }
    await this.options.operations.commitStep(
      claim.operationId,
      claim.key,
      claim.claimId!,
      result,
      [
        ...(await this.withProjectionDeltas(
          accountId,
          claim.operationId,
          claim.key,
          [step.list.id, ...(step.destination ? [step.destination.id] : [])],
          writes,
          bases,
        )),
        ...(step.action === 'task.delete'
          ? (this.options.confirmedTaskDeletionWrites?.(
              accountId,
              claim.operationId,
              step.task!.id,
            ) ?? [])
          : []),
      ],
      this.now(),
    );
  }
}
