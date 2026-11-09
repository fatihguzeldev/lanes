import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { ErrorCode } from '../../../../shared/contracts/http';
import {
  assertLocalWritable,
  assertProviderWritable,
} from '../../../accounts/server/connections/access';
import type { OperationRecord } from '../../../operations/server/journal/context';
import { ProviderCommandSchema } from '../../contracts/provider-commands';
import type { Task } from '../../contracts/task';
import type {
  GoogleTaskCreate,
  GoogleTaskPatch,
  GoogleTasksClient,
} from '../provider/google-tasks';
import { GoogleTasksError } from '../provider/google-tasks';
import { TaskQueries } from '../queries/tasks';
import { TaskCommandCapture } from './capture';
import type { SavedStep } from './capture-records';
import type { CommandAdvance, TaskCommandOptions } from './context';
import type { BeginCapturedCopy, CopyEntry, CopyListDefinition } from './copy-contract';
import { CopyEntrySchema } from './copy-contract';
import { CapturedCopyPlanner, type CopySealResult } from './copy-plan';
import { TaskDuplicatePlanner } from './duplicate-plan';
import { TaskCommandEffects } from './effects';
import { conflict, digest, isLeafCompletion, parseSchedule, ref, stableJson } from './input';
import { verifyProviderPreconditions } from './preconditions';
import { TaskOperationResolution } from './resolution';
import { TaskCommandResources } from './resources';
import { CommandRetention } from './retention';
import { TaskCommandSettlement } from './settlement';
import type { CapturedStep, ListRef, TaskRef } from './state';

/** Dispatches and reconciles one claimed provider step; capture and settlement have distinct owners. */
export class TaskCommandService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly queries: TaskQueries;
  private readonly copies: CapturedCopyPlanner;
  private readonly duplicates: TaskDuplicatePlanner;
  readonly resolutions: TaskOperationResolution;
  private readonly resources: TaskCommandResources;
  readonly capture: TaskCommandCapture;
  private readonly settlement: TaskCommandSettlement;
  private readonly effects: TaskCommandEffects;

  constructor(
    private readonly db: D1Database,
    private readonly options: TaskCommandOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.queries = options.queries ?? new TaskQueries(db);
    this.effects = new TaskCommandEffects(db, {
      history: options.history,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      now: this.now,
    });
    this.copies = new CapturedCopyPlanner(db, {
      operations: options.operations,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.validateBoardTarget ? { validateBoardTarget: options.validateBoardTarget } : {}),
      now: this.now,
    });
    this.resources = new TaskCommandResources(db, this.queries);

    this.settlement = new TaskCommandSettlement(db, options, this.effects);
    this.duplicates = new TaskDuplicatePlanner(db, {
      operations: options.operations,
      copies: this.copies,
      queries: this.queries,
      now: this.now,
      list: this.resources.list.bind(this.resources),
      position: this.resources.position.bind(this.resources),
      ...(options.listAppearanceSnapshot
        ? { listAppearanceSnapshot: options.listAppearanceSnapshot }
        : {}),
    });
    this.capture = new TaskCommandCapture(
      db,
      options,
      this.resources,
      this.copies,
      this.duplicates,
    );
    this.resolutions = new TaskOperationResolution(db, {
      operations: options.operations,
      projection: options.projection,
      clientFor: options.clientFor,
      resolveStep: (account, operation, step) => this.resolveCopyStep(account, operation, step),
      now: () => this.now(),
    });
  }

  async inspectTask(
    accountId: string,
    taskId: string,
  ): Promise<{
    taskId: string;
    revision: number;
    title: string;
    openSubtaskCount: number;
    subtaskCount: number;
    openBlockerCount: number;
    unknownBlockerCount: number;
    openBlockedSubtaskCount: number;
    assignmentSource: Task['capabilities']['assignmentSource'];
    coverageComplete: boolean;
    completionCoverageComplete: boolean;
  }> {
    const task = await this.resources.task(accountId, taskId),
      list = await this.resources.list(accountId, task.listId);
    const children = await this.db
      .prepare(
        'SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN completed=0 THEN 1 ELSE 0 END),0) AS open FROM tasks_tasks WHERE account_id=? AND parent_id=? AND deleted_at IS NULL',
      )
      .bind(accountId, taskId)
      .first<{ total: number; open: number }>();
    const blockers = await this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN b.id IS NOT NULL AND b.deleted_at IS NULL AND b.completed=0 THEN 1 ELSE 0 END),0) AS open,COALESCE(SUM(CASE WHEN b.id IS NULL THEN 1 ELSE 0 END),0) AS unknown FROM tasks_dependencies d LEFT JOIN tasks_tasks b ON b.account_id=d.account_id AND b.id=d.blocker_id WHERE d.account_id=? AND d.task_id=?`,
      )
      .bind(accountId, taskId)
      .first<{ open: number; unknown: number }>();
    const blockedChildren = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT c.id) AS n FROM tasks_tasks c JOIN tasks_dependencies d ON d.account_id=c.account_id AND d.task_id=c.id JOIN tasks_tasks b ON b.account_id=d.account_id AND b.id=d.blocker_id WHERE c.account_id=? AND c.parent_id=? AND c.deleted_at IS NULL AND c.completed=0 AND b.deleted_at IS NULL AND b.completed=0`,
      )
      .bind(accountId, taskId)
      .first<{ n: number }>();
    return {
      taskId,
      revision: task.revision,
      title: task.title,
      subtaskCount: children?.total ?? 0,
      openSubtaskCount: children?.open ?? 0,
      openBlockerCount: blockers?.open ?? 0,
      unknownBlockerCount: blockers?.unknown ?? 0,
      openBlockedSubtaskCount: blockedChildren?.n ?? 0,
      assignmentSource: task.capabilities.assignmentSource,
      coverageComplete: list.complete,
      completionCoverageComplete: list.complete || isLeafCompletion(task, children?.total ?? 0),
    };
  }

  async inspectList(
    accountId: string,
    listId: string,
  ): Promise<{
    listId: string;
    revision: number;
    title: string;
    taskCount: number;
    assignedTaskCount: number;
    coverageComplete: boolean;
    isDefault: boolean;
  }> {
    const list = await this.resources.list(accountId, listId);
    const count = await this.db
      .prepare(
        `SELECT COUNT(*) AS n,COALESCE(SUM(CASE WHEN json_extract(capabilities_json,'$.assignmentSource') IS NOT NULL THEN 1 ELSE 0 END),0) AS assigned FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL`,
      )
      .bind(accountId, listId)
      .first<{ n: number; assigned: number }>();
    return {
      listId,
      revision: list.revision,
      title: list.title,
      taskCount: count?.n ?? 0,
      assignedTaskCount: count?.assigned ?? 0,
      coverageComplete: list.complete,
      isDefault: list.isDefault,
    };
  }

  private async acquireLists(
    accountId: string,
    operationId: string,
    knownPatch = false,
  ): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `DELETE FROM tasks_command_locks WHERE account_id=? AND list_id IN(SELECT list_id FROM tasks_command_resources WHERE operation_id=?) AND EXISTS(SELECT 1 FROM tasks_operations WHERE id=tasks_command_locks.operation_id AND terminal_at IS NOT NULL)`,
          )
          .bind(accountId, operationId),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO tasks_command_locks(account_id,list_id,operation_id) SELECT ?,list_id,operation_id FROM tasks_command_resources WHERE operation_id=? ORDER BY list_id`,
          )
          .bind(accountId, operationId),
        this.lockGuard(accountId, operationId),
      ]);
      return true;
    } catch {
      if (!knownPatch) return false;
      const allowed = await this.db
        .prepare(this.allowedLocksSql())
        .bind(accountId, operationId)
        .first();
      return Boolean(allowed);
    }
  }

  private allowedLocksSql(): string {
    return `SELECT 1 AS allowed WHERE NOT EXISTS(SELECT 1 FROM tasks_command_resources r LEFT JOIN tasks_command_locks l ON l.account_id=? AND l.list_id=r.list_id LEFT JOIN tasks_operations o ON o.id=l.operation_id WHERE r.operation_id=? AND (l.operation_id IS NULL OR (l.operation_id<>r.operation_id AND NOT(o.state='uncertain' AND o.cancel_requested=1 AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id AND s.state IN('dispatched','uncertain') AND s.kind<>'task.create')))))`;
  }

  private lockGuard(
    accountId: string,
    operationId: string,
    knownPatch = false,
  ): D1PreparedStatement {
    if (knownPatch)
      return this.db
        .prepare(
          'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(' +
            this.allowedLocksSql() +
            ')',
        )
        .bind(accountId, operationId);
    return this.db
      .prepare(
        `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE EXISTS(SELECT 1 FROM tasks_command_resources r LEFT JOIN tasks_command_locks l ON l.account_id=? AND l.list_id=r.list_id AND l.operation_id=r.operation_id WHERE r.operation_id=? AND l.operation_id IS NULL)`,
      )
      .bind(accountId, operationId);
  }

  async inspectDuplicate(accountId: string, input: unknown) {
    const result = ProviderCommandSchema.safeParse(input);
    if (
      !result.success ||
      (result.data.kind !== 'task.duplicate' && result.data.kind !== 'list.duplicate')
    )
      throw new AppError('validation_failed', 'choose a task or list copy preview.', 422);
    return this.duplicates.inspect(accountId, result.data);
  }

  async beginCapturedCopy(input: BeginCapturedCopy): Promise<OperationRecord> {
    const capture = await this.capture.captured(input.operationId);
    if (capture?.payload_pruned_at !== null && capture?.payload_pruned_at !== undefined) {
      const { guardWrites: _, request: original, ...header } = input;
      await this.capture.verifyCapture(
        capture,
        { ...input, command: {} as never },
        stableJson(original ?? { kind: 'copy.' + input.source, ...header }),
      );
      return this.capture.admit(capture);
    }
    return this.copies.begin(input);
  }

  async appendCapturedCopyLists(
    operationId: string,
    accountId: string,
    input: readonly CopyListDefinition[],
  ): Promise<void> {
    return this.copies.appendLists(operationId, accountId, input);
  }

  async appendCapturedCopy(
    operationId: string,
    accountId: string,
    input: readonly CopyEntry[],
  ): Promise<void> {
    return this.copies.appendTasks(operationId, accountId, input);
  }

  async sealCapturedCopy(operationId: string, accountId: string): Promise<CopySealResult> {
    return this.copies.seal(operationId, accountId);
  }

  async readCopyProgress(
    operationId: string,
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<{
    items: { key: string; taskId: string; revision: number; providerEtag: string | null }[];
    nextCursor: string | null;
  }> {
    return this.copies.readProgress(operationId, accountId, input);
  }

  private async resolveCopyStep(
    accountId: string,
    operationId: string,
    step: CapturedStep,
  ): Promise<CapturedStep> {
    if (!step.copyKey) return step;
    const row = await this.db
      .prepare(
        'SELECT input_json FROM tasks_command_copy_entries WHERE operation_id=? AND item_key=?',
      )
      .bind(operationId, step.copyKey)
      .first<{ input_json: string }>();
    if (!row) throw conflict('the captured copy item is missing.');
    const entry = CopyEntrySchema.parse(JSON.parse(row.input_json));
    const currentList = await this.resources.list(accountId, step.list.id);
    const list = { ...currentList, projectionRevision: step.list.projectionRevision };
    let parent: TaskRef | null = null,
      previous: TaskRef | null = null;
    const mapped = async (key: string): Promise<TaskRef> => {
      const value = await this.db
        .prepare(
          'SELECT task_id FROM tasks_command_copy_receipts WHERE operation_id=? AND item_key=?',
        )
        .bind(operationId, key)
        .first<{ task_id: string }>();
      if (!value) throw conflict('a copied parent or previous sibling has not been confirmed.');
      return ref(await this.resources.task(accountId, value.task_id));
    };
    if (step.copyParentKey) parent = await mapped(step.copyParentKey);
    else parent = (await this.copies.context(operationId, accountId)).parent ?? null;
    if (step.copyPreviousKey) previous = await mapped(step.copyPreviousKey);
    else {
      const context = await this.copies.context(operationId, accountId);
      if (
        context.previous &&
        context.previous.listId === list.id &&
        context.previous.parentId === (parent?.id ?? null)
      )
        previous = context.previous;
      else if (currentList.providerId !== 'pending') {
        const capture = await this.capture.captured(operationId);
        const request = JSON.parse(capture!.request_json) as {
          previousTaskId?: string | null;
          previousId?: string | null;
        };
        if (request.previousTaskId !== null && request.previousId !== null) {
          const last = await this.db
            .prepare(
              `SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=? AND parent_id IS ? AND provider_hidden=0 AND deleted_at IS NULL AND id NOT IN(SELECT task_id FROM tasks_command_copy_entries WHERE operation_id=?) ORDER BY provider_position DESC,id DESC LIMIT 1`,
            )
            .bind(accountId, list.id, parent?.id ?? null, operationId)
            .first<{ id: string }>();
          if (last) previous = ref(await this.resources.task(accountId, last.id));
        }
      }
    }
    return {
      ...step,
      list,
      parent,
      previous,
      labelDefinitions: entry.labelDefinitions ?? [],
      schedule: parseSchedule({
        scheduledDay: entry.scheduledDay ?? null,
        scheduledTime: entry.scheduledTime ?? null,
        timeZone: entry.timeZone ?? null,
        repeatRule: entry.repeatRule ?? null,
      }),
      metadata: {
        labelIds: entry.labelIds ?? [],
        priority: entry.priority ?? 'none',
        starred: entry.starred ?? false,
        blockedBy: [],
      },
      provider: {
        ...(step.provider as GoogleTaskCreate),
        ...(entry.completed && entry.completedAt ? { completed: entry.completedAt } : {}),
      },
      ...(entry.sourceTaskId ? { sourceTaskId: entry.sourceTaskId } : {}),
    };
  }

  private projectionFence(
    accountId: string,
    operationId: string,
    list: ListRef,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists l WHERE l.account_id=? AND l.id=? AND l.deleted_at IS NULL AND l.projection_revision=?+(SELECT COALESCE(SUM(d.delta),0) FROM tasks_command_projection_deltas d WHERE d.operation_id=? AND d.list_id=?))`,
      )
      .bind(accountId, list.id, list.projectionRevision, operationId, list.id);
  }

  private hierarchySensitive(step: CapturedStep): boolean {
    if (this.targetedContext(step)) return false;
    return (
      step.action === 'task.create' ||
      step.action === 'task.move' ||
      step.action === 'task.delete' ||
      step.action === 'list.delete' ||
      step.commandKind === 'task.move' ||
      step.commandKind === 'task.complete' ||
      step.commandKind === 'task.reopen'
    );
  }

  private relativePosition(step: CapturedStep): boolean {
    return Boolean(
      (step.relativeOrder && step.action === 'task.move') ||
      (step.relativeCreate && step.action === 'task.create'),
    );
  }

  private targetedContext(step: CapturedStep): boolean {
    return Boolean(
      this.relativePosition(step) ||
      (step.leafCompletion && step.commandKind === 'task.complete') ||
      (step.ordinaryReopenIdentity && step.commandKind === 'task.reopen'),
    );
  }

  private async assertProjectionCurrent(
    accountId: string,
    operationId: string,
    list: ListRef,
  ): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS current FROM tasks_lists l WHERE l.account_id=? AND l.id=? AND l.deleted_at IS NULL AND l.projection_revision=?+(SELECT COALESCE(SUM(d.delta),0) FROM tasks_command_projection_deltas d WHERE d.operation_id=? AND d.list_id=?)`,
      )
      .bind(accountId, list.id, list.projectionRevision, operationId, list.id)
      .first();
    if (!row)
      throw conflict(
        'the captured list contents or metadata changed. refresh before reapplying this grouped or positioning command.',
      );
  }

  private async refreshRelativeReferences(
    accountId: string,
    step: CapturedStep,
  ): Promise<CapturedStep> {
    if (!this.relativePosition(step)) return step;
    const list = await this.resources.list(accountId, step.list.id);
    if (list.providerId !== step.list.providerId) throw conflict();
    const refresh = async (captured: TaskRef | null | undefined) => {
      if (!captured) return captured;
      const current = await this.resources.task(accountId, captured.id);
      if (current.revision === captured.revision) return captured;
      const fresh = { ...ref(current), notesDigest: await digest(current.notes) };
      const semantic = (value: TaskRef) => ({
        ...value,
        revision: undefined,
        provider: { ...value.provider, etag: undefined, position: undefined, updatedAt: undefined },
      });
      if (
        captured.notesDigest === undefined ||
        stableJson(semantic(fresh)) !== stableJson(semantic(captured))
      )
        throw conflict();
      return fresh;
    };
    const [task, parent, previous] = await Promise.all([
      refresh(step.task),
      refresh(step.parent),
      refresh(step.previous),
    ]);
    if (task === step.task && parent === step.parent && previous === step.previous) return step;
    return {
      ...step,
      ...(task ? { task } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(previous !== undefined ? { previous } : {}),
    };
  }

  private async assertCapturedCurrent(
    accountId: string,
    step: CapturedStep,
    operationId?: string,
  ): Promise<void> {
    if (operationId && this.hierarchySensitive(step)) {
      await this.assertProjectionCurrent(accountId, operationId, step.list);
      if (step.destination && step.destination.id !== step.list.id)
        await this.assertProjectionCurrent(accountId, operationId, step.destination);
    }
    await this.resources.list(
      accountId,
      step.list.id,
      step.action === 'list.rename' || step.action === 'list.delete'
        ? step.list.revision
        : undefined,
    );
    if (step.task) {
      const current = await this.resources.task(accountId, step.task.id, step.task.revision);
      if (
        step.leafCompletion &&
        !isLeafCompletion(current, await this.resources.childCount(accountId, current.id))
      )
        throw conflict(
          'this task’s checklist or blockers changed. review it before completing it.',
        );
      if (
        step.ordinaryReopenIdentity &&
        (current.seriesId !== step.ordinaryReopenIdentity.seriesId ||
          current.occurrenceId !== step.ordinaryReopenIdentity.occurrenceId)
      )
        throw new AppError(
          'validation_failed',
          'a recurring occurrence was admitted after this ordinary reopen was captured. inspect its successor policy before reopening.',
          422,
          false,
          { recurrence: 'preview_required' },
        );
    }
    for (const value of [step.parent, step.previous])
      if (value) await this.resources.task(accountId, value.id, value.revision);
  }

  async advance(accountId: string, operationId: string): Promise<CommandAdvance> {
    const operation = await this.options.operations.get(operationId, accountId);
    if (!operation)
      throw new AppError(
        'not_found',
        'this operation is not available in the selected account.',
        404,
      );
    const capture = await this.capture.captured(operationId);
    if (!capture || capture.account_id !== accountId)
      throw new AppError('not_found', 'this is not a captured provider command.', 404);
    if (operation.finished) return { operation, advanced: false };
    if (!operation.inputSealed && capture.copy_context_json) {
      const context = await this.copies.context(operationId, accountId);
      if (!context.sealed) {
        if ((context as { autoSource?: boolean }).autoSource) {
          try {
            return {
              operation: await this.duplicates.advance(operationId, accountId),
              advanced: true,
            };
          } catch (error) {
            const current = (await this.options.operations.get(operationId, accountId))!;
            if (current.finished) return { operation: current, advanced: false };
            if (error instanceof AppError && !error.retryable) {
              await this.options.operations.failUnsealed(
                operationId,
                accountId,
                { code: error.code },
                this.now(),
              );
              return {
                operation: (await this.options.operations.get(operationId, accountId))!,
                advanced: true,
              };
            }
            throw error;
          }
        }
        return { operation, advanced: false };
      }
      return { operation: await this.copies.promote(operationId, accountId), advanced: true };
    }
    if (!operation.inputSealed) {
      const rows = this.capture.chunk(
        (
          await this.db
            .prepare(
              `SELECT item_key,position,kind,input_json FROM tasks_command_steps WHERE operation_id=? AND item_key NOT IN(SELECT item_key FROM tasks_operation_steps WHERE operation_id=?) ORDER BY position LIMIT 10`,
            )
            .bind(operationId, operationId)
            .all<SavedStep>()
        ).results,
      );
      if (rows.length)
        await this.options.operations.appendSteps(
          operationId,
          accountId,
          rows.map((row) => ({
            key: row.item_key,
            kind: row.kind,
            position: row.position,
            input: JSON.parse(row.input_json) as unknown,
          })),
        );
      const remaining = await this.db
        .prepare('SELECT COUNT(*) AS n FROM tasks_operation_steps WHERE operation_id=?')
        .bind(operationId)
        .first<{ n: number }>();
      if (remaining?.n === capture.total_steps)
        await this.options.operations.seal(operationId, accountId);
      return {
        operation: (await this.options.operations.get(operationId, accountId))!,
        advanced: true,
      };
    }
    const claimId = this.id(),
      claim = await this.options.operations.claimNext(operationId, claimId, this.now());
    if (!claim)
      return {
        operation: (await this.options.operations.get(operationId, accountId))!,
        advanced: false,
      };
    let step = claim.input as CapturedStep;
    let client: GoogleTasksClient | undefined,
      dispatched = false,
      responseReceived = false;
    if (claim.mode === 'repair') {
      if (step.copyKey) step = await this.resolveCopyStep(accountId, operationId, step);
      await this.settlement.commit(accountId, claim, step, claim.response);
      return {
        operation: (await this.options.operations.get(operationId, accountId))!,
        advanced: true,
      };
    }
    try {
      if (step.copyKey) step = await this.resolveCopyStep(accountId, operationId, step);
      if (step.action === 'copy.begin') {
        await this.options.operations.commitLocalStep(
          operationId,
          claim.key,
          claimId,
          { captured: true },
          claim.key === 'copy.begin'
            ? ((await this.options.copyBeginWrites?.(accountId, operationId)) ?? [])
            : [],
          this.now(),
        );
      } else if (step.action === 'copy.metadata') {
        await this.settlement.commitCopyDependencies(accountId, claim, step);
      } else if (step.action === 'task.local') {
        await assertLocalWritable(this.db, accountId);
        await this.assertCapturedCurrent(accountId, step, operationId);
        await this.options.operations.commitLocalStep(
          operationId,
          claim.key,
          claimId,
          { taskId: step.task!.id },
          await this.settlement.withProjectionDeltas(
            accountId,
            operationId,
            claim.key,
            [step.list.id],
            [
              this.resources.revisionGuard(accountId, step.task!),
              ...(step.commandKind === 'task.move'
                ? [this.projectionFence(accountId, operationId, step.list)]
                : []),
              ...(step.ordinaryReopenIdentity
                ? [this.resources.ordinaryReopenGuard(accountId, step)]
                : []),
              ...(this.targetedContext(step)
                ? [this.resources.listIdentityGuard(accountId, step.list)]
                : []),
              ...(step.leafCompletion
                ? [this.resources.leafCompletionGuard(accountId, step.task!)]
                : []),
              ...(await this.effects.metadataWrites(
                accountId,
                operationId,
                claim.key,
                step,
                false,
              )),
              ...this.effects.scheduleWrites(accountId, operationId, claim.key, step),
            ],
          ),
          this.now(),
        );
      } else {
        await assertProviderWritable(this.db, accountId);
        if (!(await this.acquireLists(accountId, operationId, step.action === 'task.patch')))
          throw new AppError(
            'provider_unavailable',
            'another provider command is settling in this list.',
            503,
            true,
          );
        const beforePreflight = step;
        client = await this.options.clientFor(accountId);
        for (let retry = 0; ; retry++) {
          try {
            if (step.action !== 'list.create')
              step = await this.refreshRelativeReferences(accountId, step);
            if (step.action !== 'list.create')
              await this.assertCapturedCurrent(accountId, step, operationId);
            step = await verifyProviderPreconditions(
              this.db,
              this.queries,
              accountId,
              client,
              step,
            );
            break;
          } catch (error) {
            if (
              retry ||
              !this.relativePosition(step) ||
              !(error instanceof AppError) ||
              error.code !== 'conflict'
            )
              throw error;
            const fresh = await this.refreshRelativeReferences(accountId, step);
            if (fresh === step) throw error;
            step = fresh;
          }
        }
        if (step.action === 'list.create')
          await this.options.validateBoardTarget?.(
            accountId,
            step.boardId!,
            step.boardRevision,
            operationId,
          );
        try {
          await this.options.operations.markDispatched(
            operationId,
            claim.key,
            claimId,
            this.now(),
            [
              this.lockGuard(accountId, operationId, step.action === 'task.patch'),
              ...(step.action === 'task.delete'
                ? (this.options.taskDeletionDispatchGuards?.(
                    accountId,
                    operationId,
                    step.task!.id,
                  ) ?? [])
                : []),
              ...(this.hierarchySensitive(step)
                ? [
                    this.projectionFence(accountId, operationId, step.list),
                    ...(step.destination && step.destination.id !== step.list.id
                      ? [this.projectionFence(accountId, operationId, step.destination)]
                      : []),
                  ]
                : []),
              ...(step.action === 'list.create' && this.options.boardTargetGuard
                ? [this.options.boardTargetGuard(accountId, step.boardId!, step.boardRevision)]
                : []),
              ...(this.targetedContext(step)
                ? [this.resources.listIdentityGuard(accountId, step.list)]
                : []),
              ...(step.leafCompletion
                ? [this.resources.leafCompletionGuard(accountId, step.task!)]
                : []),
              ...(step.task ? [this.resources.revisionGuard(accountId, step.task)] : []),
              ...(step.ordinaryReopenIdentity
                ? [this.resources.ordinaryReopenGuard(accountId, step)]
                : []),
              ...[step.parent, step.previous].flatMap((value) =>
                value ? [this.resources.revisionGuard(accountId, value)] : [],
              ),
            ],
            step === beforePreflight ? undefined : step,
          );
        } catch (error) {
          if (this.relativePosition(step)) {
            const fresh = await this.refreshRelativeReferences(accountId, step);
            const recorded =
              fresh === step ? null : await this.options.operations.getStep(operationId, claim.key);
            if (recorded?.state === 'claimed' && recorded.claimId === claimId)
              throw new AppError(
                'provider_unavailable',
                'the position reference changed during its check. the queued action will retry.',
                503,
                true,
              );
          }
          if (step.action !== 'list.create')
            await this.assertCapturedCurrent(accountId, step, operationId);
          else
            await this.options.validateBoardTarget?.(
              accountId,
              step.boardId!,
              step.boardRevision,
              operationId,
            );
          throw error;
        }
        dispatched = true;
        let response: unknown;
        const mutation = {
          ...(step.task?.provider.etag
            ? { etag: step.task.provider.etag }
            : step.list.providerEtag && step.action.startsWith('list.')
              ? { etag: step.list.providerEtag }
              : {}),
          ...(step.task
            ? {
                knownTask: {
                  id: step.task.provider.id,
                  ...(step.task.capabilities.assignmentSource
                    ? {
                        assignmentInfo: {
                          surfaceType:
                            step.task.capabilities.assignmentSource === 'docs'
                              ? 'DOCUMENT'
                              : 'SPACE',
                        },
                      }
                    : {}),
                },
              }
            : {}),
        };
        if (step.action === 'task.create')
          response = await client.createTask(
            step.list.providerId,
            step.provider as GoogleTaskCreate,
            {
              parent: step.parent?.provider.id ?? null,
              previous: step.previous?.provider.id ?? null,
            },
          );
        else if (step.action === 'task.patch')
          response = await client.patchTask(
            step.list.providerId,
            step.task!.provider.id,
            step.provider as GoogleTaskPatch,
            mutation,
          );
        else if (step.action === 'task.delete') {
          await client.deleteTask(step.list.providerId, step.task!.provider.id, mutation);
          response = { id: step.task!.provider.id, deleted: true };
        } else if (step.action === 'task.move')
          response = await client.moveTask(
            step.list.providerId,
            step.task!.provider.id,
            {
              destinationTasklist: step.destination!.providerId,
              parent: step.parent?.provider.id ?? null,
              previous: step.previous?.provider.id ?? null,
            },
            mutation,
          );
        else if (step.action === 'list.create')
          response = await client.createTaskList({ title: step.title! });
        else if (step.action === 'list.rename')
          response = await client.patchTaskList(
            step.list.providerId,
            { title: step.title! },
            mutation,
          );
        else if (step.action === 'list.delete') {
          await client.deleteTaskList(step.list.providerId, mutation);
          response = { id: step.list.providerId, deleted: true };
        } else
          throw new AppError(
            'validation_failed',
            'this captured action is not a provider mutation.',
            422,
          );
        responseReceived = true;
        await this.options.operations.recordResponse(
          operationId,
          claim.key,
          claimId,
          response,
          this.now(),
        );
        await this.settlement.commit(accountId, claim, step, response, client);
      }
    } catch (error) {
      if ((await this.options.operations.getStep(operationId, claim.key))?.response !== null)
        throw error;
      let code: ErrorCode =
        error instanceof AppError || error instanceof GoogleTasksError
          ? error.code
          : 'provider_unavailable';
      let retryable =
        error instanceof AppError || error instanceof GoogleTasksError ? error.retryable : true;
      if (code === 'reconnect_required' && client && this.options.refreshRejectedToken) {
        try {
          await this.options.refreshRejectedToken(accountId, client);
          code = 'provider_unavailable';
          retryable = true;
        } catch (refreshError) {
          code = refreshError instanceof AppError ? refreshError.code : 'provider_unavailable';
          retryable = refreshError instanceof AppError ? refreshError.retryable : true;
        }
      }
      const uncertain =
        dispatched &&
        (responseReceived ||
          (error instanceof GoogleTasksError
            ? error.outcome === 'uncertain'
            : !(error instanceof AppError)));
      const state =
        code === 'reconnect_required'
          ? 'reconnect_required'
          : code === 'list_limit_reached' ||
              (error instanceof GoogleTasksError && error.limitKind === 'storage')
            ? 'blocked_by_limit'
            : undefined;
      const retryAt = retryable
        ? this.now() +
          Math.max(
            1000,
            (error instanceof GoogleTasksError ? (error.retryAfterSeconds ?? 1) : 1) * 1000,
          )
        : undefined;
      if (dispatched)
        await this.options.operations.rejectStep(
          operationId,
          claim.key,
          claimId,
          {
            code,
            definitelyRejected: !uncertain,
            ...(state ? { operationState: state } : {}),
            ...(retryAt === undefined ? {} : { retryAt }),
          },
          this.now(),
        );
      else
        await this.options.operations.releaseUndispatched(
          operationId,
          claim.key,
          claimId,
          {
            code,
            ...(state ? { state } : retryAt === undefined ? { state: 'failed' as const } : {}),
            ...(retryAt === undefined ? {} : { retryAt }),
          },
          this.now(),
        );
    }
    return {
      operation: (await this.options.operations.get(operationId, accountId))!,
      advanced: true,
    };
  }

  async cleanupCaptures(limit = 100, now = this.now()): Promise<number> {
    return new CommandRetention(this.db).cleanup(limit, now);
  }

  async advanceNext(): Promise<CommandAdvance | null> {
    const now = this.now();
    const row = await this.db
      .prepare(
        `SELECT o.id,o.account_id FROM tasks_operations o JOIN tasks_command_plans p ON p.operation_id=o.id
   WHERE o.state IN('accepted','running','partial') AND o.terminal_at IS NULL AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?)
    AND (p.copy_context_json IS NULL OR json_extract(p.copy_context_json,'$.sealed')=1 OR json_extract(p.copy_context_json,'$.autoSource')=1)
    AND NOT EXISTS(SELECT 1 FROM tasks_operation_steps s WHERE s.operation_id=o.id AND s.state IN('claimed','dispatched') AND s.claim_until>?)
   ORDER BY o.updated_at,o.created_at,o.id LIMIT 1`,
      )
      .bind(now, now)
      .first<{ id: string; account_id: string }>();
    return row ? this.advance(row.account_id, row.id) : null;
  }
}
