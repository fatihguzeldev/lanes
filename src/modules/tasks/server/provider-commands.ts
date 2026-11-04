import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../contracts/errors';
import type { ErrorCode } from '../../../contracts/http';
import {
  assertLocalWritable,
  assertProviderWritable,
  localWriteGuard,
  providerWriteGuard,
} from '../../accounts/access';
import type { HistoryService } from '../../history/server';
import type { CreationSource, HistoryEventInput } from '../../history/contracts';
import { TaskScheduleSchema } from '../planning-contract';
import type { TaskSchedule } from '../planning-contract';
import type { Task, TaskList } from '../contracts';
import { ProviderCommandSchema } from '../provider-command-contract';
import type { PrepareProviderCommand, ProviderCommand } from '../provider-command-contract';
import { normalizeTaskSearchText } from '../model';
import { GoogleTasksError, GoogleTaskSchema } from './provider';
import type {
  GoogleTaskDTO,
  GoogleTaskCreate,
  GoogleTaskPatch,
  GoogleTaskListDTO,
  GoogleTasksClient,
} from './provider';
import { OperationStore } from './operations';
import type { ClaimedStep, OperationRecord } from './operations';
import { TaskQueries } from './queries';
import type { TaskMetadataService } from './metadata';
import type { TaskMetadataPatch } from '../metadata-command-contract';
import { TaskProjectionStore } from './sync';
import { CopyEntrySchema } from './provider-copy-contract';
import { CommandRetention } from './provider-command-retention';
import { TaskDuplicatePlanner } from './provider-duplicate-plan';
import { CapturedCopyPlanner, type CopySealResult } from './provider-copy-plan';
import type { CopyEntry, BeginCapturedCopy, CopyListDefinition } from './provider-copy-contract';
import type { CapturedStep, ListRef, TaskRef } from './provider-command-state';
import { TaskOperationResolution } from './provider-resolution';

export interface TaskCommandOptions {
  operations: OperationStore;
  projection: TaskProjectionStore;
  history: HistoryService;
  metadata?: TaskMetadataService;
  queries?: TaskQueries;
  clientFor(accountId: string): Promise<GoogleTasksClient>;
  remainingProviderRequests?(): number;
  providerOrderRefreshWrites?(accountId: string, listIds: readonly string[]): D1PreparedStatement[];
  refreshRejectedToken?(accountId: string, client: GoogleTasksClient): Promise<void>;
  validateBoardTarget?(
    accountId: string,
    boardId: string,
    revision?: number,
    operationId?: string,
  ): Promise<void>;
  placementWrites?(
    list: TaskList,
    boardId: string,
    appearance?: { color?: string },
  ): D1PreparedStatement[];
  copyBeginWrites?(accountId: string, operationId: string): Promise<D1PreparedStatement[]>;
  confirmedTaskDeletionWrites?(
    accountId: string,
    operationId: string,
    taskId: string,
  ): D1PreparedStatement[];
  taskDeletionDispatchGuards?(
    accountId: string,
    operationId: string,
    taskId: string,
  ): D1PreparedStatement[];
  listAppearanceSnapshot?(accountId: string, listId: string): Promise<{ color: string }>;
  listRemovalWrites?(accountId: string, listId: string): D1PreparedStatement[];
  boardTargetGuard?(accountId: string, boardId: string, revision?: number): D1PreparedStatement;
  placementResult?(
    accountId: string,
    listId: string,
    requestedBoardId: string,
  ): Promise<{ boardId: string; fellBack: boolean }>;
  placementSettlementWrites?(
    accountId: string,
    listId: string,
    requestedBoardId: string,
    operationId: string,
  ): D1PreparedStatement[];
  now?: () => number;
  id?: () => string;
}
export { CopyEntrySchema, copyTaskId } from './provider-copy-contract';
export type { CopyEntry, BeginCapturedCopy, CopyListDefinition } from './provider-copy-contract';
export interface CommandAdvance {
  operation: OperationRecord;
  advanced: boolean;
}
interface Capture {
  operation_id: string;
  account_id: string;
  owner_subject: string;
  request_json: string;
  capture_nonce: string;
  resource_key: string;
  list_slots: number;
  total_steps: number;
  created_at: number;
  copy_context_json?: string | null;
  request_hash?: string | null;
  payload_pruned_at?: number | null;
}
interface SavedStep {
  item_key: string;
  position: number;
  kind: string;
  input_json: string;
}
const fields =
  'operation_id,account_id,owner_subject,request_json,capture_nonce,resource_key,list_slots,total_steps,created_at';
const ref = (task: Task): TaskRef => ({
  id: task.id,
  listId: task.listId,
  parentId: task.parentId,
  title: task.title,
  completed: task.completed,
  completedAt: task.completedAt,
  scheduledDay: task.scheduledDay,
  scheduledTime: task.scheduledTime,
  timeZone: task.timeZone,
  repeatRule: task.repeatRule,
  occurrenceId: task.occurrenceId,
  seriesId: task.seriesId,
  revision: task.revision,
  provider: task.provider,
  capabilities: task.capabilities,
});
const schedule = (task: TaskRef): TaskSchedule => ({
  scheduledDay: task.scheduledDay,
  scheduledTime: task.scheduledTime,
  timeZone: task.timeZone,
  repeatRule: task.repeatRule,
});
function conflict(
  message = 'this resource changed. refresh its confirmed values before reapplying the draft.',
): AppError {
  return new AppError('conflict', message, 409);
}
function confirmation(message: string, fields: Record<string, string>): AppError {
  return new AppError('validation_failed', message, 422, false, {
    confirmation: 'required',
    ...fields,
  });
}
function parseSchedule(value: unknown): TaskSchedule {
  const checked = TaskScheduleSchema.safeParse(value);
  if (!checked.success)
    throw new AppError(
      'validation_failed',
      'check the scheduled day, time, zone and repeat rule.',
      422,
    );
  return checked.data;
}
async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function metadataPatch(value: TaskMetadataPatch): TaskMetadataPatch {
  return {
    ...(value.labelIds === undefined ? {} : { labelIds: value.labelIds }),
    ...(value.priority === undefined ? {} : { priority: value.priority }),
    ...(value.starred === undefined ? {} : { starred: value.starred }),
    ...(value.blockedBy === undefined ? {} : { blockedBy: value.blockedBy }),
  };
}
function taskReferenceSql(task: string, list: string): string {
  return `json_object('id',${task}.id,'listId',${task}.list_id,'parentId',${task}.parent_id,'title',${task}.title,'completed',json(CASE WHEN ${task}.completed=1 THEN 'true' ELSE 'false' END),'completedAt',${task}.completed_at,'scheduledDay',${task}.scheduled_day,'scheduledTime',${task}.scheduled_time,'timeZone',${task}.time_zone,'repeatRule',json(COALESCE(${task}.repeat_rule_json,'null')),'revision',${task}.revision,'provider',json_object('id',${task}.provider_id,'listId',${list}.provider_id,'etag',${task}.provider_etag,'position',${task}.provider_position,'updatedAt',${task}.provider_updated_at),'capabilities',json(${task}.capabilities_json))`;
}
function stableJson(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : input;
  return JSON.stringify(canonical(value));
}
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Owns provider intent and projection settlement. No browser retry sends an unrecorded provider mutation. */
export class TaskCommandService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly queries: TaskQueries;
  private readonly copies: CapturedCopyPlanner;
  private readonly duplicates: TaskDuplicatePlanner;
  readonly resolutions: TaskOperationResolution;
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskCommandOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.queries = options.queries ?? new TaskQueries(db);
    this.copies = new CapturedCopyPlanner(db, {
      operations: options.operations,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.validateBoardTarget ? { validateBoardTarget: options.validateBoardTarget } : {}),
      now: this.now,
    });
    this.duplicates = new TaskDuplicatePlanner(db, {
      copies: this.copies,
      queries: this.queries,
      now: this.now,
      list: this.list.bind(this),
      position: this.position.bind(this),
      ...(options.listAppearanceSnapshot
        ? { listAppearanceSnapshot: options.listAppearanceSnapshot }
        : {}),
    });
    this.resolutions = new TaskOperationResolution(db, {
      operations: options.operations,
      projection: options.projection,
      clientFor: options.clientFor,
      resolveStep: (account, operation, step) => this.resolveCopyStep(account, operation, step),
      now: () => this.now(),
    });
  }
  private async list(accountId: string, listId: string, revision?: number): Promise<ListRef> {
    const row = await this.db
      .prepare(
        `SELECT id,account_id,title,provider_id,provider_etag,is_default,revision,projection_revision,tasks_complete_at,completed_complete_at,sync_cursor FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(accountId, listId)
      .first<{
        id: string;
        account_id: string;
        title: string;
        provider_id: string;
        provider_etag: string | null;
        is_default: number;
        revision: number;
        projection_revision: number;
        tasks_complete_at: number | null;
        completed_complete_at: number | null;
        sync_cursor: string | null;
      }>();
    if (!row)
      throw new AppError('not_found', 'the selected list is not available in this account.', 404);
    if (revision !== undefined && row.revision !== revision) throw conflict();
    return {
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      providerId: row.provider_id,
      providerEtag: row.provider_etag,
      isDefault: row.is_default === 1,
      revision: row.revision,
      projectionRevision: row.projection_revision,
      complete:
        row.tasks_complete_at !== null &&
        row.completed_complete_at !== null &&
        row.sync_cursor === null,
    };
  }
  private complete(list: ListRef): void {
    if (!list.complete)
      throw conflict(
        'refresh complete task coverage for this list before capturing hierarchy or manual sibling order.',
      );
  }
  private async task(accountId: string, id: string, revision?: number): Promise<Task> {
    const task = await this.queries.getTask(accountId, id);
    if (revision !== undefined && task.revision !== revision) throw conflict();
    return task;
  }
  private async childCount(accountId: string, taskId: string, openOnly = false): Promise<number> {
    const unsupported = await this.db
      .prepare(
        `SELECT 1 FROM tasks_tasks c WHERE c.account_id=? AND c.parent_id=? AND c.deleted_at IS NULL AND (c.unsupported_hierarchy=1 OR c.provider_missing_at IS NOT NULL OR EXISTS(SELECT 1 FROM tasks_tasks g WHERE g.account_id=c.account_id AND g.parent_id=c.id AND g.deleted_at IS NULL)) LIMIT 1`,
      )
      .bind(accountId, taskId)
      .first();
    if (unsupported)
      throw new AppError(
        'validation_failed',
        'this subtree contains an unresolved identity or unsupported deeper hierarchy. reconcile it before applying a grouped action.',
        422,
      );
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND parent_id=? AND deleted_at IS NULL ${openOnly ? 'AND completed=0' : ''}`,
      )
      .bind(accountId, taskId)
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 2000)
      throw new AppError(
        'validation_failed',
        'this task exceeds the supported 2,000-subtask bound.',
        422,
      );
    return row?.n ?? 0;
  }
  private childCompletionCapture(
    accountId: string,
    taskId: string,
    operationId: string,
    list: ListRef,
    at: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json)
   SELECT ?,'child-'||t.id,ROW_NUMBER() OVER(ORDER BY t.provider_position,t.id)-1,'task.patch',json_object('action','task.patch','list',json(?),'task',${taskReferenceSql('t', 'l')},'provider',json(?),'event','task_completed','commandKind','task.complete')
   FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.parent_id=? AND t.deleted_at IS NULL AND t.completed=0`,
      )
      .bind(
        operationId,
        JSON.stringify(list),
        JSON.stringify({ status: 'completed', completed: new Date(at).toISOString() }),
        accountId,
        taskId,
      );
  }
  private async position(
    accountId: string,
    list: ListRef,
    parentId: string | null,
    parentRevision: number | undefined,
    previousId: string | null | undefined,
    previousRevision: number | undefined,
    movingId?: string,
  ): Promise<{ parent: TaskRef | null; previous: TaskRef | null }> {
    this.complete(list);
    let parent: TaskRef | null = null,
      previous: TaskRef | null = null;
    if (parentId) {
      const value = await this.task(accountId, parentId, parentRevision);
      const hidden = await this.db
        .prepare('SELECT provider_hidden FROM tasks_tasks WHERE account_id=? AND id=?')
        .bind(accountId, parentId)
        .first<{ provider_hidden: number }>();
      if (
        hidden?.provider_hidden ||
        value.listId !== list.id ||
        value.parentId ||
        !value.capabilities.canHaveChildren ||
        value.id === movingId
      )
        throw new AppError(
          'validation_failed',
          'choose an eligible top-level parent in the destination list.',
          422,
        );
      parent = ref(value);
    }
    if (previousId !== null) {
      let id = previousId;
      if (id === undefined) {
        const last = await this.db
          .prepare(
            `SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=? AND parent_id IS ? AND deleted_at IS NULL AND provider_hidden=0 AND id IS NOT ? ORDER BY provider_position DESC,id DESC LIMIT 1`,
          )
          .bind(accountId, list.id, parentId, movingId ?? null)
          .first<{ id: string }>();
        id = last?.id;
      }
      if (id) {
        const value = await this.task(
          accountId,
          id,
          previousId === undefined ? undefined : previousRevision,
        );
        const hidden = await this.db
          .prepare('SELECT provider_hidden FROM tasks_tasks WHERE id=? AND account_id=?')
          .bind(id, accountId)
          .first<{ provider_hidden: number }>();
        if (
          value.listId !== list.id ||
          value.parentId !== parentId ||
          value.id === movingId ||
          hidden?.provider_hidden
        )
          throw new AppError(
            'validation_failed',
            'choose a visible previous sibling in the destination group.',
            422,
          );
        previous = ref(value);
      }
    }
    return { parent, previous };
  }
  private async alreadyPositioned(
    accountId: string,
    task: TaskRef,
    destination: ListRef,
    parent: TaskRef | null,
    previous: TaskRef | null,
  ): Promise<boolean> {
    if (task.listId !== destination.id || task.parentId !== (parent?.id ?? null)) return false;
    const current = await this.db
      .prepare(
        `SELECT previous_id FROM (
      SELECT id,LAG(id) OVER(ORDER BY provider_position IS NULL,provider_position,id) AS previous_id
      FROM tasks_tasks WHERE account_id=? AND list_id=? AND parent_id IS ? AND deleted_at IS NULL AND provider_hidden=0
      ) WHERE id=?`,
      )
      .bind(accountId, task.listId, task.parentId, task.id)
      .first<{ previous_id: string | null }>();
    return current !== null && current.previous_id === (previous?.id ?? null);
  }
  private revisionGuard(accountId: string, task: TaskRef): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND list_id=? AND provider_id=? AND deleted_at IS NULL)',
      )
      .bind(accountId, task.id, task.revision, task.listId, task.provider.id);
  }
  private listGuard(accountId: string, list: ListRef): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND revision=? AND projection_revision=? AND deleted_at IS NULL)',
      )
      .bind(accountId, list.id, list.revision, list.projectionRevision);
  }
  private ordinaryReopenGuard(accountId: string, step: CapturedStep): D1PreparedStatement {
    const identity = step.ordinaryReopenIdentity!;
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND deleted_at IS NULL AND series_id IS ? AND occurrence_id IS ?)',
      )
      .bind(accountId, step.task!.id, identity.seriesId, identity.occurrenceId);
  }
  async hasCapturedCommand(accountId: string, operationId: string): Promise<boolean> {
    return !!(await this.db
      .prepare('SELECT 1 FROM tasks_command_plans WHERE operation_id=? AND account_id=?')
      .bind(operationId, accountId)
      .first());
  }
  private async captured(id: string): Promise<Capture | null> {
    return this.db
      .prepare(
        'SELECT ' +
          fields +
          ',copy_context_json,request_hash,payload_pruned_at FROM tasks_command_plans WHERE operation_id=?',
      )
      .bind(id)
      .first<Capture>();
  }
  private async verifyCapture(
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
      const list = await this.list(accountId, command.listId, command.revision);
      guards.push(this.listGuard(accountId, list));
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
        this.complete(list);
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
      const list = await this.list(accountId, command.listId, command.listRevision);
      const position = await this.position(
        accountId,
        list,
        command.parentId,
        command.parentRevision,
        command.previousId,
        command.previousRevision,
      );
      guards.push(
        this.listGuard(accountId, list),
        ...[position.parent, position.previous].flatMap((value) =>
          value ? [this.revisionGuard(accountId, value)] : [],
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
      const task = ref(await this.task(accountId, command.taskId, command.revision)),
        list = await this.list(accountId, task.listId);
      guards.push(this.revisionGuard(accountId, task));
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
        this.complete(list);
        const children = await this.childCount(accountId, task.id);
        guards.push(this.listGuard(accountId, list));
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
        this.complete(list);
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
        const children = completing ? await this.childCount(accountId, task.id, true) : 0;
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
        guards.push(this.listGuard(accountId, list));
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
            this.childCompletionCapture(accountId, task.id, input.operationId, list, this.now()),
          );
        }
        if (!completing && task.parentId) {
          const parent = ref(await this.task(accountId, task.parentId));
          if (parent.completed) {
            if (parent.occurrenceId && !trustedGuardWrites.length)
              throw new AppError(
                'validation_failed',
                'choose the repeating parent occurrence policy before reopening this child.',
                422,
                false,
                { recurrence: 'preview_required', parentId: parent.id },
              );
            guards.push(this.revisionGuard(accountId, parent));
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
        const destination = await this.list(accountId, command.listId, command.listRevision),
          children = await this.childCount(accountId, task.id);
        this.complete(list);
        guards.push(this.listGuard(accountId, list));
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
        const position = await this.position(
          accountId,
          destination,
          command.parentId,
          command.parentRevision,
          command.previousId,
          command.previousRevision,
          task.id,
        );
        if (!task.capabilities.canMove)
          throw new AppError(
            'validation_failed',
            'this task cannot be moved in its current provider state.',
            422,
          );
        if (position.parent && task.repeatRule)
          throw new AppError(
            'validation_failed',
            'clear this lanes repeat rule before nesting the task.',
            422,
          );
        if (position.parent && !task.capabilities.canNest)
          throw new AppError(
            'validation_failed',
            'google does not allow this task to become a subtask.',
            422,
          );
        guards.push(this.listGuard(accountId, destination));
        if (children && destination.id !== list.id)
          extra.push(
            this.db
              .prepare(
                `INSERT INTO tasks_command_move_members(operation_id,task_id,source_provider_id) SELECT ?,id,provider_id FROM tasks_tasks WHERE account_id=? AND parent_id=? AND deleted_at IS NULL`,
              )
              .bind(input.operationId, accountId, task.id),
          );
        steps.push({
          action: (await this.alreadyPositioned(
            accountId,
            task,
            destination,
            position.parent,
            position.previous,
          ))
            ? 'task.local'
            : 'task.move',
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
          guards.push(this.ordinaryReopenGuard(accountId, step));
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
  private chunk(rows: SavedStep[]): SavedStep[] {
    const output: SavedStep[] = [];
    for (const row of rows) {
      if (output.length && jsonBytes([...output, row]) > 48_000) break;
      output.push(row);
    }
    return output;
  }
  private async admit(capture: Capture): Promise<OperationRecord> {
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
  }> {
    const task = await this.task(accountId, taskId),
      list = await this.list(accountId, task.listId);
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
    const list = await this.list(accountId, listId);
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
    const capture = await this.captured(input.operationId);
    if (capture?.payload_pruned_at !== null && capture?.payload_pruned_at !== undefined) {
      const { guardWrites: _, request: original, ...header } = input;
      await this.verifyCapture(
        capture,
        { ...input, command: {} as never },
        stableJson(original ?? { kind: 'copy.' + input.source, ...header }),
      );
      return this.admit(capture);
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
    const currentList = await this.list(accountId, step.list.id);
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
      return ref(await this.task(accountId, value.task_id));
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
        const capture = await this.captured(operationId);
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
          if (last) previous = ref(await this.task(accountId, last.id));
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
    await this.list(
      accountId,
      step.list.id,
      step.action === 'list.rename' || step.action === 'list.delete'
        ? step.list.revision
        : undefined,
    );
    if (step.task) {
      const current = await this.task(accountId, step.task.id, step.task.revision);
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
      if (value) await this.task(accountId, value.id, value.revision);
  }
  private async rebaseMove(
    accountId: string,
    step: CapturedStep,
    current: GoogleTaskDTO,
  ): Promise<CapturedStep | null> {
    if (
      step.action !== 'task.move' ||
      !step.task ||
      !current.etag ||
      current.position === undefined ||
      current.position === step.task.provider.position ||
      current.deleted ||
      current.assignmentInfo ||
      step.task.capabilities.assignmentSource
    )
      return null;
    const cached = await this.task(accountId, step.task.id, step.task.revision);
    const address = await this.db
      .prepare(
        'SELECT provider_parent_id,provider_hidden FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL',
      )
      .bind(accountId, cached.id, cached.revision)
      .first<{ provider_parent_id: string | null; provider_hidden: number }>();
    if (
      !address ||
      current.id !== cached.provider.id ||
      current.title !== cached.title ||
      (current.notes ?? '') !== cached.notes ||
      current.status !== (cached.completed ? 'completed' : 'needsAction') ||
      (current.completed ?? null) !== cached.completedAt ||
      (current.due?.slice(0, 10) ?? null) !== cached.scheduledDay ||
      (current.parent ?? null) !== address.provider_parent_id ||
      Boolean(current.hidden) !== Boolean(address.provider_hidden)
    )
      return null;
    return {
      ...step,
      task: {
        ...step.task,
        provider: {
          ...step.task.provider,
          etag: current.etag,
          position: current.position,
          updatedAt: current.updated ?? null,
        },
      },
    };
  }
  private async preflight(
    accountId: string,
    client: GoogleTasksClient,
    step: CapturedStep,
  ): Promise<CapturedStep> {
    if (step.task) {
      const current = await client.getTask(step.list.providerId, step.task.provider.id);
      if (
        step.action === 'task.move' &&
        current.hidden &&
        current.status === 'completed' &&
        (step.parent || step.previous)
      )
        throw new AppError(
          'validation_failed',
          'google only permits a hidden completed task at the first top-level position.',
          422,
        );
      if (
        current.id !== step.task.provider.id ||
        (step.task.provider.etag !== null && current.etag !== step.task.provider.etag)
      ) {
        const rebased = await this.rebaseMove(accountId, step, current);
        if (rebased) return rebased;
        throw conflict(
          'google changed this task after the editor captured it. refresh before reapplying.',
        );
      }
    }
    if (step.action === 'list.rename' || step.action === 'list.delete') {
      const current = await client.getTaskList(step.list.providerId);
      if (
        current.id !== step.list.providerId ||
        (step.list.providerEtag !== null && current.etag !== step.list.providerEtag)
      )
        throw conflict(
          'google changed this list after the editor captured it. refresh before reapplying.',
        );
    }
    return step;
  }
  async advance(accountId: string, operationId: string): Promise<CommandAdvance> {
    const operation = await this.options.operations.get(operationId, accountId);
    if (!operation)
      throw new AppError(
        'not_found',
        'this operation is not available in the selected account.',
        404,
      );
    const capture = await this.captured(operationId);
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
      const rows = this.chunk(
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
      await this.commit(accountId, claim, step, claim.response);
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
        await this.commitCopyDependencies(accountId, claim, step);
      } else if (step.action === 'task.local') {
        await assertLocalWritable(this.db, accountId);
        await this.assertCapturedCurrent(accountId, step, operationId);
        await this.options.operations.commitLocalStep(
          operationId,
          claim.key,
          claimId,
          { taskId: step.task!.id },
          await this.withProjectionDeltas(
            accountId,
            operationId,
            claim.key,
            [step.list.id],
            [
              this.revisionGuard(accountId, step.task!),
              ...(step.commandKind === 'task.move'
                ? [this.projectionFence(accountId, operationId, step.list)]
                : []),
              ...(step.ordinaryReopenIdentity ? [this.ordinaryReopenGuard(accountId, step)] : []),
              ...(await this.metadataWrites(accountId, operationId, claim.key, step, false)),
              ...this.scheduleWrites(accountId, operationId, claim.key, step),
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
        if (step.action !== 'list.create')
          await this.assertCapturedCurrent(accountId, step, operationId);
        client = await this.options.clientFor(accountId);
        const beforePreflight = step;
        step = await this.preflight(accountId, client, step);
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
              ...(step.task ? [this.revisionGuard(accountId, step.task)] : []),
              ...(step.ordinaryReopenIdentity ? [this.ordinaryReopenGuard(accountId, step)] : []),
              ...[step.parent, step.previous].flatMap((value) =>
                value ? [this.revisionGuard(accountId, value)] : [],
              ),
            ],
            step === beforePreflight ? undefined : step,
          );
        } catch (error) {
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
        await this.commit(accountId, claim, step, response, client);
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
  private event(
    accountId: string,
    operationId: string,
    key: string,
    step: CapturedStep,
    kind: HistoryEventInput['kind'],
    summary: Record<string, unknown>,
    providerAt: string | null = null,
  ): D1PreparedStatement {
    return this.options.history.eventWrite({
      id: 'event:' + operationId + ':' + key + ':' + kind,
      accountId,
      taskId: step.task?.id ?? step.targetId ?? null,
      listId: step.destination?.id ?? step.list.id,
      kind,
      origin: step.origin ?? 'owner',
      dedupKey: operationId + ':' + key + ':' + kind,
      recordedAt: new Date(this.now()).toISOString(),
      providerAt,
      taskTitle: step.task?.title ?? step.provider?.title ?? null,
      listTitle: step.destination?.title ?? step.list.title,
      summary: {
        operationId,
        stepKey: key,
        ...(step.scheduleId ? { scheduleId: step.scheduleId } : {}),
        ...(step.runId ? { runId: step.runId } : {}),
        ...summary,
      },
    } as HistoryEventInput);
  }
  private scheduleWrites(
    accountId: string,
    operationId: string,
    key: string,
    step: CapturedStep,
  ): D1PreparedStatement[] {
    if (!step.schedule) return [];
    const id = step.task?.id ?? step.targetId!,
      value = step.schedule,
      before = step.beforeSchedule ?? {
        scheduledDay: null,
        scheduledTime: null,
        timeZone: null,
        repeatRule: null,
      },
      writes: D1PreparedStatement[] = [];
    if (step.clearSchedulePause)
      writes.push(
        this.db
          .prepare('DELETE FROM tasks_schedule_pauses WHERE account_id=? AND task_id=?')
          .bind(accountId, id),
      );
    writes.push(
      this.db
        .prepare(
          `UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id=(SELECT list_id FROM tasks_tasks WHERE account_id=? AND id=? AND (scheduled_time IS NOT ? OR time_zone IS NOT ? OR repeat_rule_json IS NOT ?))`,
        )
        .bind(
          accountId,
          accountId,
          id,
          value.scheduledTime,
          value.timeZone,
          value.repeatRule ? JSON.stringify(value.repeatRule) : null,
        ),
    );
    writes.push(
      this.db
        .prepare(
          `UPDATE tasks_tasks SET scheduled_time=?,time_zone=?,repeat_rule_json=?,revision=revision+1 WHERE account_id=? AND id=? AND (scheduled_time IS NOT ? OR time_zone IS NOT ? OR repeat_rule_json IS NOT ?)`,
        )
        .bind(
          value.scheduledTime,
          value.timeZone,
          value.repeatRule ? JSON.stringify(value.repeatRule) : null,
          accountId,
          id,
          value.scheduledTime,
          value.timeZone,
          value.repeatRule ? JSON.stringify(value.repeatRule) : null,
        ),
    );
    if (step.action !== 'task.create') {
      if (before.scheduledDay !== value.scheduledDay)
        writes.push(
          this.event(accountId, operationId, key, step, 'scheduled_day_changed', {
            before: before.scheduledDay,
            after: value.scheduledDay,
          }),
        );
      if (before.scheduledTime !== value.scheduledTime || before.timeZone !== value.timeZone)
        writes.push(
          this.event(accountId, operationId, key, step, 'scheduled_time_changed', {
            before: { time: before.scheduledTime, zone: before.timeZone },
            after: { time: value.scheduledTime, zone: value.timeZone },
          }),
        );
      if (JSON.stringify(before.repeatRule) !== JSON.stringify(value.repeatRule))
        writes.push(
          this.event(accountId, operationId, key, step, 'repeat_rule_changed', {
            before: before.repeatRule,
            after: value.repeatRule,
          }),
        );
    }
    return writes;
  }
  private async metadataWrites(
    accountId: string,
    operationId: string,
    key: string,
    step: CapturedStep,
    confirmed: boolean,
  ): Promise<D1PreparedStatement[]> {
    if (
      ((!step.metadata || !Object.keys(step.metadata).length) && !step.labelDefinitions?.length) ||
      !this.options.metadata
    )
      return [];
    const context = {
      operationId,
      stepKey: key,
      origin: step.origin ?? 'owner',
      recordedAt: new Date(this.now()).toISOString(),
    };
    if (step.action === 'task.create') {
      const value = step.metadata ?? {},
        hasFields = Boolean(
          step.labelDefinitions?.length ||
          value.labelIds?.length ||
          value.blockedBy?.length ||
          (value.priority && value.priority !== 'none') ||
          value.starred,
        );
      if (!hasFields) return [];
      const graph =
        step.graphRevision ??
        (
          await this.db
            .prepare('SELECT graph_revision FROM tasks_account_state WHERE account_id=?')
            .bind(accountId)
            .first<{ graph_revision: number }>()
        )?.graph_revision ??
        0;
      const resolved = step.labelDefinitions?.length
        ? await this.options.metadata.prepareResolveLabelDefinitions(
            accountId,
            step.labelDefinitions,
            context,
          )
        : { writes: [], labelIds: [] };
      return [
        ...resolved.writes,
        ...(await this.options.metadata.prepareCreatedMetadata(
          accountId,
          [
            {
              taskId: step.targetId!,
              expectedTaskRevision:
                1 +
                (step.schedule &&
                (step.schedule.scheduledTime || step.schedule.timeZone || step.schedule.repeatRule)
                  ? 1
                  : 0),
              labelIds: [...(value.labelIds ?? []), ...resolved.labelIds],
              priority: value.priority ?? 'none',
              starred: value.starred ?? false,
              blockedBy: value.blockedBy ?? [],
            },
          ],
          context,
          graph,
        )),
      ];
    }
    const prepared = await (confirmed
      ? this.options.metadata.prepareConfirmedTaskPatch(
          accountId,
          step.task!.id,
          step.metadata!,
          step.task!.revision,
          context,
          step.graphRevision,
        )
      : this.options.metadata.prepareTaskPatch(
          accountId,
          step.task!.id,
          step.metadata!,
          step.task!.revision,
          context,
          step.graphRevision,
        ));
    return prepared.writes;
  }
  private copyReceiptWrite(operationId: string, key: string, taskId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_command_copy_receipts(operation_id,item_key,task_id,revision,provider_etag) SELECT ?,?,id,revision,provider_etag FROM tasks_tasks WHERE id=? ON CONFLICT(operation_id,item_key) DO UPDATE SET revision=excluded.revision,provider_etag=excluded.provider_etag`,
      )
      .bind(operationId, key, taskId);
  }
  private async commitCopyDependencies(
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
  private async withProjectionDeltas(
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
      this.event(
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
          this.event(
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
  private async commit(
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
        this.event(accountId, claim.operationId, claim.key, step, 'list_deleted', {
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
          this.event(accountId, claim.operationId, claim.key, step, 'task_deleted', {
            parentId: step.task!.parentId,
            knownSubtaskCount: step.subtaskCount ?? 0,
          }),
        );
      } else {
        if (step.action !== 'task.create')
          writes.push(
            ...(await this.metadataWrites(accountId, claim.operationId, claim.key, step, true)),
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
          ...this.scheduleWrites(accountId, claim.operationId, claim.key, step),
        );
        if (step.action === 'task.create')
          writes.push(
            ...(await this.metadataWrites(accountId, claim.operationId, claim.key, step, true)),
          );
        if (step.action === 'task.create')
          writes.push(
            this.event(
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
            this.event(
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
            this.event(
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
