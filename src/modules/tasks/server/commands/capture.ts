import type { TaskDuplicatePlanner } from './duplicate-plan';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import {
  assertLocalWritable,
  assertProviderWritable,
  localWriteGuard,
  providerWriteGuard,
} from '../../../accounts/server/connections/access';
import type { OperationRecord } from '../../../operations/server/journal/context';
import type { PrepareProviderCommand } from '../../contracts/provider-commands';
import { ProviderCommandSchema } from '../../contracts/provider-commands';
import type { GoogleTaskPatch } from '../provider/google-tasks';
import type { Capture, SavedStep } from './capture-records';
import { fields } from './capture-records';
import type { TaskCommandOptions } from './context';
import { CapturedCopyPlanner } from './copy-plan';
import {
  confirmation,
  conflict,
  digest,
  jsonBytes,
  metadataPatch,
  parseSchedule,
  ref,
  schedule,
  stableJson,
} from './input';
import type { TaskCommandResources } from './resources';
import type { CapturedStep } from './state';
type CaptureOptions = Pick<
  TaskCommandOptions,
  | 'metadata'
  | 'operations'
  | 'placementWrites'
  | 'projection'
  | 'validateBoardTarget'
  | 'now'
  | 'id'
>;

/** Captures immutable validated intent and admits its journal receipt. Sends no provider mutation. */
export class TaskCommandCapture {
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(
    private readonly db: D1Database,
    private readonly options: CaptureOptions,
    private readonly resources: TaskCommandResources,
    private readonly copies: CapturedCopyPlanner,
    private readonly duplicates: TaskDuplicatePlanner,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async hasCapturedCommand(accountId: string, operationId: string): Promise<boolean> {
    return !!(await this.db
      .prepare('SELECT 1 FROM tasks_command_plans WHERE operation_id=? AND account_id=?')
      .bind(operationId, accountId)
      .first());
  }

  async captured(id: string): Promise<Capture | null> {
    return this.db
      .prepare(
        'SELECT ' +
          fields +
          ',copy_context_json,request_hash,payload_pruned_at FROM tasks_command_plans WHERE operation_id=?',
      )
      .bind(id)
      .first<Capture>();
  }

  async verifyCapture(
    capture: Capture,
    input: PrepareProviderCommand,
    requestJson: string,
  ): Promise<void> {
    const matches =
      capture.payload_pruned_at !== null && capture.payload_pruned_at !== undefined
        ? capture.request_hash === (await digest(requestJson))
        : capture.request_json === requestJson;
    if (
      capture.account_id !== input.accountId ||
      capture.owner_subject !== input.ownerSubject ||
      !matches
    )
      throw conflict('this operation identity belongs to different command input.');
  }

  async prepare(
    input: PrepareProviderCommand,
    trustedGuardWrites: D1PreparedStatement[] = [],
  ): Promise<OperationRecord> {
    const parsed = ProviderCommandSchema.safeParse(input.command);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'check the task or list command fields.',
        422,
        false,
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      );
    const command = parsed.data,
      requestJson = stableJson(command);
    if (jsonBytes(command) > 60_000)
      throw new AppError('validation_failed', 'this command exceeds the accepted input size.', 413);
    if (
      !/^\d{13}:[A-Za-z0-9_-]{16,64}$/.test(input.operationId) ||
      !input.ownerSubject ||
      input.ownerSubject.length > 255 ||
      !input.accountId ||
      input.accountId.length > 1024
    )
      throw new AppError(
        'validation_failed',
        'provide an operation identity and authorized account context.',
        422,
      );
    let capture = await this.captured(input.operationId);
    if (capture) {
      await this.verifyCapture(capture, input, requestJson);
      return this.admit(capture);
    }
    const issued = Number(input.operationId.slice(0, 13));
    if (issued > this.now() + 300_000 || this.now() - issued > 86_400_000)
      throw conflict(
        'this unrecorded operation identity has expired. inspect existing work before starting a new action.',
      );
    if (command.kind === 'task.duplicate' || command.kind === 'list.duplicate')
      return this.duplicates.prepare({ ...input, command }, trustedGuardWrites);
    const steps: CapturedStep[] = [],
      guards: D1PreparedStatement[] = [],
      extra: D1PreparedStatement[] = [...trustedGuardWrites],
      bulk: D1PreparedStatement[] = [];
    let listSlots = 0,
      positionOffset = 0;
    const local =
      command.kind === 'task.edit' &&
      command.patch.title === undefined &&
      command.patch.notes === undefined &&
      command.patch.scheduledDay === undefined;
    if (local) await assertLocalWritable(this.db, input.accountId);
    else await assertProviderWritable(this.db, input.accountId);
    const accountId = input.accountId;
    let resourceKey: string;
    if (command.kind === 'list.create') {
      if (!this.options.validateBoardTarget || !this.options.placementWrites)
        throw new AppError(
          'validation_failed',
          'list creation needs an explicit board placement owner.',
          422,
        );
      await this.options.validateBoardTarget(
        accountId,
        command.boardId,
        command.boardRevision,
        input.operationId,
      );
      listSlots = 1;
      resourceKey = 'new-list:' + input.operationId;
      const id = 'list-' + (await digest(input.operationId + ':list')).slice(0, 32);
      steps.push({
        action: 'list.create',
        targetId: id,
        title: command.title,
        boardId: command.boardId,
        ...(command.boardRevision === undefined ? {} : { boardRevision: command.boardRevision }),
        list: {
          id,
          accountId,
          title: command.title,
          providerId: 'pending',
          providerEtag: null,
          isDefault: false,
          revision: 0,
          projectionRevision: 0,
          complete: true,
        },
        commandKind: command.kind,
      });
    } else if (command.kind === 'list.rename' || command.kind === 'list.delete') {
      const list = await this.resources.list(accountId, command.listId, command.revision);
      guards.push(this.resources.listGuard(accountId, list));
      resourceKey = 'list:' + list.id;
      if (command.kind === 'list.rename')
        steps.push({
          action: 'list.rename',
          list,
          title: command.title,
          commandKind: command.kind,
        });
      else {
        if (list.isDefault)
          throw new AppError(
            'forbidden',
            'the google default list cannot be deleted through lanes.',
            403,
          );
        this.resources.complete(list);
        const counts = await this.db
          .prepare(
            `SELECT COUNT(*) AS n,SUM(CASE WHEN json_extract(capabilities_json,'$.assignmentSource') IS NOT NULL THEN 1 ELSE 0 END) AS assigned FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL`,
          )
          .bind(accountId, list.id)
          .first<{ n: number; assigned: number }>();
        if (
          command.confirmTaskCount !== counts?.n ||
          (counts.assigned && !command.confirmAssignments)
        )
          throw confirmation('confirm the list and all included tasks before deletion.', {
            taskCount: String(counts?.n ?? 0),
            assignedTasks: String(counts?.assigned ?? 0),
          });
        steps.push({ action: 'list.delete', list, taskCount: counts.n, commandKind: command.kind });
      }
    } else if (command.kind === 'task.create') {
      const list = await this.resources.list(accountId, command.listId, command.listRevision);
      const position = await this.resources.position(
        accountId,
        list,
        command.parentId,
        command.parentRevision,
        command.previousId,
        command.previousRevision,
      );
      guards.push(
        this.resources.listGuard(accountId, list),
        ...[position.parent, position.previous].flatMap((value) =>
          value ? [this.resources.revisionGuard(accountId, value)] : [],
        ),
      );
      resourceKey = 'new-task:' + input.operationId;
      if (command.parentId && command.repeatRule)
        throw new AppError('validation_failed', 'a subtask cannot repeat independently.', 422);
      const metadata = metadataPatch(command);
      if (
        command.labelIds.length ||
        command.blockedBy.length ||
        command.priority !== 'none' ||
        command.starred
      ) {
        if (!this.options.metadata)
          throw new AppError('validation_failed', 'task metadata needs its owning service.', 422);
        await this.options.metadata.validateCreationMetadata(
          accountId,
          metadata,
          command.expectedGraphRevision,
        );
      }
      steps.push({
        action: 'task.create',
        metadata,
        ...(command.expectedGraphRevision === undefined
          ? {}
          : { graphRevision: command.expectedGraphRevision }),
        list,
        ...position,
        targetId: 'task-' + (await digest(input.operationId + ':task')).slice(0, 32),
        provider: { title: command.title, notes: command.notes, dueDay: command.scheduledDay },
        schedule: parseSchedule({
          scheduledDay: command.scheduledDay,
          scheduledTime: command.scheduledTime,
          timeZone: command.timeZone,
          repeatRule: command.repeatRule,
        }),
        commandKind: command.kind,
      });
    } else if (
      command.kind === 'task.edit' ||
      command.kind === 'task.delete' ||
      command.kind === 'task.complete' ||
      command.kind === 'task.reopen' ||
      command.kind === 'task.move'
    ) {
      const selectedTask = await this.resources.task(accountId, command.taskId, command.revision),
        task = ref(selectedTask),
        list = await this.resources.list(accountId, task.listId);
      guards.push(this.resources.revisionGuard(accountId, task));
      resourceKey = 'task:' + task.id;
      if (!task.capabilities.canEdit && command.kind !== 'task.delete')
        throw new AppError(
          'validation_failed',
          'this provider task is currently restricted. refresh or inspect its restriction.',
          422,
        );
      if (command.kind === 'task.edit') {
        if (command.patch.notes !== undefined && !task.capabilities.canEditNotes)
          throw new AppError(
            'validation_failed',
            'google docs assigned tasks cannot have notes.',
            422,
          );
        const metadata = metadataPatch(command.patch);
        if (Object.keys(metadata).length) {
          if (!this.options.metadata)
            throw new AppError('validation_failed', 'task metadata needs its owning service.', 422);
          await this.options.metadata.prepareTaskPatch(
            accountId,
            task.id,
            metadata,
            task.revision,
            {
              operationId: input.operationId,
              stepKey: 'preflight',
              origin: 'owner',
              recordedAt: new Date(this.now()).toISOString(),
            },
            command.expectedGraphRevision,
          );
        }
        const merged = { ...schedule(task), ...command.patch };
        if (command.patch.scheduledDay === null) {
          merged.scheduledTime = null;
          merged.timeZone = null;
          merged.repeatRule = null;
        }
        const next = parseSchedule({
          scheduledDay: merged.scheduledDay,
          scheduledTime: merged.scheduledTime,
          timeZone: merged.timeZone,
          repeatRule: merged.repeatRule,
        });
        if (task.parentId && next.repeatRule)
          throw new AppError(
            'validation_failed',
            'a nested subtask cannot repeat independently.',
            422,
          );
        const provider: GoogleTaskPatch = {
          ...(command.patch.title === undefined ? {} : { title: command.patch.title }),
          ...(command.patch.notes === undefined ? {} : { notes: command.patch.notes }),
          ...(command.patch.scheduledDay === undefined
            ? {}
            : { dueDay: command.patch.scheduledDay }),
        };
        steps.push({
          action: local ? 'task.local' : 'task.patch',
          metadata,
          ...(command.expectedGraphRevision === undefined
            ? {}
            : { graphRevision: command.expectedGraphRevision }),
          task,
          list,
          provider,
          schedule: next,
          beforeSchedule: schedule(task),
          clearSchedulePause: ['scheduledDay', 'scheduledTime', 'timeZone', 'repeatRule'].some(
            (field) => Object.hasOwn(command.patch, field),
          ),
          commandKind: command.kind,
        });
      } else if (command.kind === 'task.delete') {
        this.resources.complete(list);
        const children = await this.resources.childCount(accountId, task.id);
        guards.push(this.resources.listGuard(accountId, list));
        if (
          (children && command.confirmSubtaskCount !== children) ||
          (task.capabilities.assignmentSource && !command.confirmAssignment)
        )
          throw confirmation(
            'confirm all subtasks and any source assignment before deleting this task.',
            {
              subtaskCount: String(children),
              assignment: task.capabilities.assignmentSource ?? '',
            },
          );
        if (!task.capabilities.canDelete)
          throw new AppError(
            'validation_failed',
            'this task cannot be safely deleted in its retained state.',
            422,
          );
        steps.push({
          action: 'task.delete',
          task,
          list,
          subtaskCount: children,
          commandKind: command.kind,
        });
      } else if (command.kind === 'task.complete' || command.kind === 'task.reopen') {
        const completing = command.kind === 'task.complete';
        this.resources.complete(list);
        if (!completing && task.occurrenceId && !trustedGuardWrites.length)
          throw new AppError(
            'validation_failed',
            'inspect the repeating occurrence and choose how to handle its successor before reopening.',
            422,
            false,
            { recurrence: 'preview_required' },
          );
        const blocker = await this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks_dependencies d JOIN tasks_tasks b ON b.account_id=d.account_id AND b.id=d.blocker_id WHERE d.account_id=? AND d.task_id=? AND b.completed=0 AND b.deleted_at IS NULL`,
          )
          .bind(accountId, task.id)
          .first<{ n: number }>();
        const children = completing ? await this.resources.childCount(accountId, task.id, true) : 0;
        const blockedChildren = completing
          ? ((
              await this.db
                .prepare(
                  `SELECT COUNT(DISTINCT c.id) AS n FROM tasks_tasks c JOIN tasks_dependencies d ON d.account_id=c.account_id AND d.task_id=c.id JOIN tasks_tasks b ON b.account_id=d.account_id AND b.id=d.blocker_id WHERE c.account_id=? AND c.parent_id=? AND c.deleted_at IS NULL AND c.completed=0 AND b.deleted_at IS NULL AND b.completed=0`,
                )
                .bind(accountId, task.id)
                .first<{ n: number }>()
            )?.n ?? 0)
          : 0;
        const confirmations: Record<string, string> = {};
        if (
          completing &&
          ((blocker?.n ?? 0) > 0 || blockedChildren > 0) &&
          !command.confirmBlocked
        ) {
          confirmations.openBlockerCount = String(blocker?.n ?? 0);
          confirmations.blockedSubtaskCount = String(blockedChildren);
        }
        if (completing && children && command.confirmOpenSubtaskCount !== children)
          confirmations.openSubtaskCount = String(children);
        if (Object.keys(confirmations).length)
          throw confirmation(
            'confirm the blocked task and all open subtasks that this completion will affect.',
            confirmations,
          );
        guards.push(this.resources.listGuard(accountId, list));
        if (task.completed !== completing)
          extra.push(
            ...this.options.projection.prepareCompletionCapture(
              accountId,
              task.id,
              input.operationId,
              task.revision,
              completing ? 'completed' : 'reopened',
            ),
          );
        if (children) {
          positionOffset = children;
          bulk.push(
            this.resources.childCompletionCapture(
              accountId,
              task.id,
              input.operationId,
              list,
              this.now(),
            ),
          );
        }
        if (!completing && task.parentId) {
          const parent = ref(await this.resources.task(accountId, task.parentId));
          if (parent.completed) {
            if (parent.occurrenceId && !trustedGuardWrites.length)
              throw new AppError(
                'validation_failed',
                'choose the repeating parent occurrence policy before reopening this child.',
                422,
                false,
                { recurrence: 'preview_required', parentId: parent.id },
              );
            guards.push(this.resources.revisionGuard(accountId, parent));
            extra.push(
              ...this.options.projection.prepareCompletionCapture(
                accountId,
                parent.id,
                input.operationId,
                parent.revision,
                'reopened',
              ),
            );
            steps.push({
              action: 'task.patch',
              task: parent,
              list,
              provider: { status: 'needsAction', completed: null },
              event: 'task_reopened',
              commandKind: command.kind,
            });
          }
        }
        steps.push(
          task.completed === completing
            ? { action: 'task.local', task, list, commandKind: command.kind }
            : {
                action: 'task.patch',
                task,
                list,
                provider: completing
                  ? { status: 'completed', completed: new Date(this.now()).toISOString() }
                  : { status: 'needsAction', completed: null },
                event: completing ? 'task_completed' : 'task_reopened',
                commandKind: command.kind,
              },
        );
      } else {
        const relativeOrder =
            command.listId === list.id &&
            command.parentId === task.parentId &&
            command.previousId !== undefined,
          destination = await this.resources.list(
            accountId,
            command.listId,
            relativeOrder ? undefined : command.listRevision,
          ),
          children = relativeOrder ? 0 : await this.resources.childCount(accountId, task.id);
        if (relativeOrder) task.notesDigest = await digest(selectedTask.notes);
        else this.resources.complete(list);
        guards.push(
          relativeOrder
            ? this.resources.listIdentityGuard(accountId, list)
            : this.resources.listGuard(accountId, list),
        );
        if (children && command.parentId)
          throw new AppError(
            'validation_failed',
            'promote or reorganize the children before nesting their parent.',
            422,
          );
        if (children && command.confirmSubtaskCount !== children)
          throw confirmation('confirm the task subtree before moving its parent.', {
            subtaskCount: String(children),
          });
        const position = await this.resources.position(
          accountId,
          destination,
          command.parentId,
          command.parentRevision,
          command.previousId,
          command.previousRevision,
          task.id,
          relativeOrder,
        );
        if (!task.capabilities.canMove)
          throw new AppError(
            'validation_failed',
            'this task cannot be moved in its current provider state.',
            422,
          );
        if (!relativeOrder && position.parent && task.repeatRule)
          throw new AppError(
            'validation_failed',
            'clear this lanes repeat rule before nesting the task.',
            422,
          );
        if (!relativeOrder && position.parent && !task.capabilities.canNest)
          throw new AppError(
            'validation_failed',
            'google does not allow this task to become a subtask.',
            422,
          );
        guards.push(
          relativeOrder
            ? this.resources.listIdentityGuard(accountId, destination)
            : this.resources.listGuard(accountId, destination),
        );
        if (relativeOrder)
          guards.push(
            ...[position.parent, position.previous].flatMap((value) =>
              value ? [this.resources.revisionGuard(accountId, value)] : [],
            ),
          );
        if (children && destination.id !== list.id)
          extra.push(
            this.db
              .prepare(
                `INSERT INTO tasks_command_move_members(operation_id,task_id,source_provider_id) SELECT ?,id,provider_id FROM tasks_tasks WHERE account_id=? AND parent_id=? AND deleted_at IS NULL`,
              )
              .bind(input.operationId, accountId, task.id),
          );
        steps.push({
          action:
            !relativeOrder &&
            (await this.resources.alreadyPositioned(
              accountId,
              task,
              destination,
              position.parent,
              position.previous,
            ))
              ? 'task.local'
              : 'task.move',
          ...(relativeOrder ? { relativeOrder: true as const } : {}),
          task,
          list,
          destination,
          ...position,
          subtaskCount: children,
          commandKind: command.kind,
        });
      }
    } else
      throw new AppError(
        'validation_failed',
        'this copy command needs its complete captured source plan.',
        422,
      );
    if (command.kind === 'task.reopen' && !trustedGuardWrites.length) {
      for (const step of steps)
        if (step.task) {
          step.ordinaryReopenIdentity = {
            seriesId: step.task.seriesId ?? null,
            occurrenceId: step.task.occurrenceId ?? null,
          };
          guards.push(this.resources.ordinaryReopenGuard(accountId, step));
        }
    }
    const nonce = this.id(),
      at = this.now();
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO tasks_command_plans(${fields}) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`,
          )
          .bind(
            input.operationId,
            accountId,
            input.ownerSubject,
            requestJson,
            nonce,
            resourceKey,
            listSlots,
            steps.length + positionOffset,
            at,
          ),
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_command_plans WHERE operation_id=? AND capture_nonce=?)',
          )
          .bind(input.operationId, nonce),
        local ? localWriteGuard(this.db, accountId) : providerWriteGuard(this.db, accountId),
        ...guards,
        ...extra,
        ...bulk,
        ...steps.map((step, position) =>
          this.db
            .prepare(
              'INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json) VALUES(?,?,?,?,?)',
            )
            .bind(
              input.operationId,
              'step-' + (position + positionOffset),
              position + positionOffset,
              step.action,
              JSON.stringify(step),
            ),
        ),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO tasks_command_resources(operation_id,list_id) SELECT operation_id,json_extract(input_json,'$.list.id') FROM tasks_command_steps WHERE operation_id=? UNION SELECT operation_id,json_extract(input_json,'$.destination.id') FROM tasks_command_steps WHERE operation_id=? AND json_extract(input_json,'$.destination.id') IS NOT NULL`,
          )
          .bind(input.operationId, input.operationId),
      ]);
    } catch {
      capture = await this.captured(input.operationId);
      if (!capture) throw conflict();
      await this.verifyCapture(capture, input, requestJson);
    }
    capture = await this.captured(input.operationId);
    if (!capture)
      throw new AppError(
        'storage_unavailable',
        'the immutable command could not be captured.',
        503,
        true,
      );
    return this.admit(capture);
  }

  chunk(rows: SavedStep[]): SavedStep[] {
    const output: SavedStep[] = [];
    for (const row of rows) {
      if (output.length && jsonBytes([...output, row]) > 48_000) break;
      output.push(row);
    }
    return output;
  }

  async admit(capture: Capture): Promise<OperationRecord> {
    if (capture.payload_pruned_at !== null && capture.payload_pruned_at !== undefined) {
      const existing = await this.options.operations.get(capture.operation_id, capture.account_id);
      if (!existing)
        throw conflict(
          'this operation receipt has expired. inspect existing output before starting a new action.',
        );
      return existing;
    }
    if (capture.copy_context_json)
      return this.copies.admit(capture.operation_id, capture.account_id);
    const rows = this.chunk(
      (
        await this.db
          .prepare(
            'SELECT item_key,position,kind,input_json FROM tasks_command_steps WHERE operation_id=? ORDER BY position LIMIT 10',
          )
          .bind(capture.operation_id)
          .all<SavedStep>()
      ).results,
    );
    return this.options.operations.admit(
      {
        id: capture.operation_id,
        accountId: capture.account_id,
        ownerSubject: capture.owner_subject,
        kind: JSON.parse(capture.request_json).kind as string,
        resourceKey: capture.resource_key,
        input: { captureId: capture.operation_id, requestHash: await digest(capture.request_json) },
        steps: rows.map((row) => ({
          key: row.item_key,
          kind: row.kind,
          input: JSON.parse(row.input_json) as unknown,
        })),
        listSlots: capture.list_slots,
        totalSteps: capture.total_steps,
      },
      this.now(),
    );
  }
}
