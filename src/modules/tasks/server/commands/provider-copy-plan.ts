import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import {
  assertLocalWritable,
  assertProviderWritable,
  localWriteGuard,
  providerWriteGuard,
} from '../../../accounts/server/connections/access';
import { OperationIdSchema } from '../../operation-contract';
import { ResourceIdSchema } from '../../contracts';
import { CreationSourceSchema } from '../../../history/contracts/events';
import {
  CopyEntrySchema,
  CopyListDefinitionSchema,
  copyTaskId,
  type BeginCapturedCopy,
  type CopyEntry,
  type CopyListDefinition,
} from './provider-copy-contract';
import type { ListRef, TaskRef } from './provider-command-state';
import { OperationStore, type OperationRecord } from '../operations';
import { TaskQueries } from '../queries/tasks';
import type { TaskMetadataService } from '../metadata';
import { CopyDependencyValidator, type CopyValidationProgress } from './provider-copy-validation';
export interface CopySealResult extends OperationRecord {
  captureSealed: boolean;
  validation: CopyValidationProgress;
}
export interface CopyPlannerOptions {
  operations: OperationStore;
  metadata?: TaskMetadataService | undefined;
  validateBoardTarget?(
    accountId: string,
    boardId: string,
    revision?: number,
    operationId?: string,
  ): Promise<void>;
  now?: (() => number) | undefined;
}
export interface CopyContext {
  version: 2;
  source: z.infer<typeof CreationSourceSchema>;
  origin: 'owner' | 'scheduled';
  totalTasks: number;
  totalLists: number;
  newListCount: number;
  sealed: boolean;
  list: ListRef;
  previous: TaskRef | null;
  parent?: TaskRef | null;
  newList: boolean;
  scheduleId?: string;
  runId?: string;
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
  copy_context_json: string;
  request_hash?: string | null;
  payload_pruned_at?: number | null;
}
interface ListRow {
  item_key: string;
  position: number;
  list_id: string;
  is_new: number;
  input_json: string;
  list_json: string;
}

const identity = ResourceIdSchema.max(1024);
const count = z.number().int().nonnegative().safe();
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError('validation_failed', 'check the captured copy fields', 422);
  return result.data;
}
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : value;
}
const encode = (value: unknown) => JSON.stringify(canonical(value));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function bounded(input: unknown): void {
  if (bytes(input) > 65536)
    throw new AppError('validation_failed', 'one captured chunk may contain at most 64 kib', 422);
}
function conflict(
  message = 'the captured copy changed; refresh its operation before continuing',
): AppError {
  return new AppError('conflict', message, 409);
}
async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function copyListId(operationId: string, key: string): Promise<string> {
  return 'list-' + (await digest(operationId + ':list:' + key)).slice(0, 32);
}
/** Captures and validates complete multi-list input before the journal can dispatch it. */
export class CapturedCopyPlanner {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: CopyPlannerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }
  private guard(condition: string, bindings: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
      .bind(...bindings);
  }
  private async capture(operationId: string, accountId: string): Promise<Capture> {
    parse(OperationIdSchema, operationId);
    parse(identity, accountId);
    const row = await this.db
      .prepare(
        'SELECT * FROM tasks_command_plans WHERE operation_id=? AND account_id=? AND copy_context_json IS NOT NULL',
      )
      .bind(operationId, accountId)
      .first<Capture>();
    if (!row)
      throw new AppError('not_found', 'this captured copy is not available in this account', 404);
    return row;
  }
  async context(operationId: string, accountId: string): Promise<CopyContext> {
    return JSON.parse(
      (await this.capture(operationId, accountId)).copy_context_json,
    ) as CopyContext;
  }
  private async list(
    accountId: string,
    listId: string,
    expectedRevision: number,
  ): Promise<ListRef> {
    const row = await this.db
      .prepare(
        `SELECT id,title,provider_id,provider_etag,is_default,revision,projection_revision,tasks_complete_at,completed_complete_at,sync_cursor FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(accountId, listId)
      .first<{
        id: string;
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
      throw new AppError(
        'not_found',
        'the existing destination list is not available in this account',
        404,
      );
    if (row.revision !== expectedRevision)
      throw conflict('the destination list changed; refresh before capturing a copy');
    if (
      row.tasks_complete_at === null ||
      row.completed_complete_at === null ||
      row.sync_cursor !== null
    )
      throw conflict('refresh complete destination list coverage before capturing manual order');
    return {
      id: row.id,
      accountId,
      title: row.title,
      providerId: row.provider_id,
      providerEtag: row.provider_etag,
      isDefault: row.is_default === 1,
      revision: row.revision,
      projectionRevision: row.projection_revision,
      complete: true,
    };
  }
  private fixedAdmission(
    capture: Capture,
    marker: {
      kind: string;
      input_json: string;
    },
  ) {
    return digest(capture.request_json).then((requestHash) =>
      this.options.operations.admit(
        {
          id: capture.operation_id,
          accountId: capture.account_id,
          ownerSubject: capture.owner_subject,
          kind: (
            JSON.parse(capture.request_json) as {
              kind: string;
            }
          ).kind,
          resourceKey: capture.resource_key,
          input: { captureId: capture.operation_id, requestHash },
          steps: [
            {
              key: 'copy.begin',
              kind: marker.kind,
              input: JSON.parse(marker.input_json) as unknown,
            },
          ],
          listSlots: capture.list_slots,
          totalSteps: capture.total_steps,
        },
        this.now(),
      ),
    );
  }
  async admit(operationId: string, accountId: string): Promise<OperationRecord> {
    const capture = await this.capture(operationId, accountId);
    if (capture.payload_pruned_at !== null && capture.payload_pruned_at !== undefined) {
      const prior = await this.options.operations.get(operationId, accountId);
      if (!prior) throw new AppError('not_found', 'this copy receipt is no longer retained', 404);
      return prior;
    }
    const marker = await this.db
      .prepare(
        "SELECT kind,input_json FROM tasks_command_steps WHERE operation_id=? AND item_key='copy.begin' AND position=0",
      )
      .bind(operationId)
      .first<{
        kind: string;
        input_json: string;
      }>();
    if (!marker) throw conflict('this captured copy has no stable admission marker');
    if (!(await this.options.operations.get(operationId, accountId)))
      await assertProviderWritable(this.db, accountId);
    return this.fixedAdmission(capture, marker);
  }
  async begin(input: BeginCapturedCopy): Promise<OperationRecord> {
    parse(OperationIdSchema, input.operationId);
    parse(identity, input.accountId);
    parse(identity, input.ownerSubject);
    parse(CreationSourceSchema, input.source);
    parse(z.enum(['owner', 'scheduled']), input.origin);
    parse(ResourceIdSchema.max(1024), input.requestKey);
    const totalTasks = parse(
      count.max(input.source === 'repetition' ? 2001 : 2000),
      input.totalTasks,
    );
    const legacy = input.listId !== undefined;
    const totalLists = parse(count.max(100), input.totalLists ?? (legacy ? 1 : 0));
    const newListCount = parse(
      count.max(totalLists),
      input.newListCount ?? (input.newList ? 1 : 0),
    );
    if (totalTasks && !totalLists)
      throw new AppError(
        'validation_failed',
        'a task copy needs at least one destination list',
        422,
      );
    if (input.lists && input.lists.length > 10)
      throw new AppError('validation_failed', 'capture at most ten initial list definitions', 422);
    const { guardWrites: _guards, request: original, ...header } = input;
    const requestJson = encode(original ?? { kind: 'copy.' + input.source, ...header });
    bounded(JSON.parse(requestJson));
    const prior = await this.db
      .prepare('SELECT * FROM tasks_command_plans WHERE operation_id=?')
      .bind(input.operationId)
      .first<Capture>();
    if (prior) {
      if (
        prior.account_id !== input.accountId ||
        prior.owner_subject !== input.ownerSubject ||
        (prior.request_json === '{}' && prior.request_hash
          ? prior.request_hash !== (await digest(requestJson))
          : prior.request_json !== requestJson) ||
        !prior.copy_context_json
      )
        throw conflict('this operation identity already belongs to different captured input');
      return this.admit(input.operationId, input.accountId);
    }
    const issued = Number(input.operationId.slice(0, 13));
    if (issued > this.now() + 300000 || this.now() - issued > 86400000)
      throw conflict('this unrecorded operation identity has expired');
    await assertProviderWritable(this.db, input.accountId);
    let firstList: ListRef = {
      id: await copyListId(input.operationId, 'admission-marker'),
      accountId: input.accountId,
      title: '',
      providerId: 'pending',
      providerEtag: null,
      isDefault: false,
      revision: 0,
      projectionRevision: 0,
      complete: true,
    };
    let previous: TaskRef | null = null,
      parent: TaskRef | null = null;
    if (input.parentTaskId && (!legacy || input.newList || totalLists !== 1))
      throw new AppError(
        'validation_failed',
        'an existing parent requires one existing destination list',
        422,
      );
    if (legacy && !input.newList) {
      firstList = await this.list(input.accountId, input.listId!, parse(count, input.listRevision));
      if (input.parentTaskId) {
        const item = await new TaskQueries(this.db).getTask(input.accountId, input.parentTaskId);
        if (
          item.listId !== firstList.id ||
          item.parentId ||
          item.provider.missing ||
          item.unsupportedHierarchy ||
          !item.capabilities.canHaveChildren
        )
          throw new AppError(
            'validation_failed',
            'choose an eligible top-level parent in the destination list',
            422,
          );
        parent = item;
      }
      if (input.previousTaskId) {
        const item = await new TaskQueries(this.db).getTask(input.accountId, input.previousTaskId);
        if (item.listId !== firstList.id || item.parentId !== (parent?.id ?? null))
          throw new AppError(
            'validation_failed',
            'the insertion anchor must be a sibling in the destination list',
            422,
          );
        previous = {
          id: item.id,
          listId: item.listId,
          parentId: item.parentId,
          title: item.title,
          completed: item.completed,
          completedAt: item.completedAt,
          scheduledDay: item.scheduledDay,
          scheduledTime: item.scheduledTime,
          timeZone: item.timeZone,
          repeatRule: item.repeatRule,
          revision: item.revision,
          provider: item.provider,
          capabilities: item.capabilities,
        };
      }
    }
    const context: CopyContext = {
      version: 2,
      source: input.source,
      origin: input.origin,
      totalTasks,
      totalLists,
      newListCount,
      sealed: false,
      list: firstList,
      previous,
      parent,
      newList: !!input.newList,
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    };
    const nonce = crypto.randomUUID(),
      at = this.now(),
      total = 2 + newListCount + totalTasks + Math.ceil(totalTasks / 10);
    // A marker is plan data, never a fabricated persisted list. Its list reference is
    // ignored by the local marker executor; actual lists are captured separately.
    const marker = encode({
      action: 'copy.begin',
      list: firstList,
      source: input.source,
      origin: input.origin,
      commandKind: 'task.duplicate',
    });
    try {
      await this.db.batch([
        providerWriteGuard(this.db, input.accountId),
        this.db
          .prepare(
            'INSERT INTO tasks_command_plans(operation_id,account_id,owner_subject,request_json,capture_nonce,resource_key,list_slots,total_steps,created_at,copy_context_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING',
          )
          .bind(
            input.operationId,
            input.accountId,
            input.ownerSubject,
            requestJson,
            nonce,
            'copy:' + input.operationId,
            newListCount,
            total,
            at,
            encode(context),
          ),
        this.guard(
          'EXISTS (SELECT 1 FROM tasks_command_plans WHERE operation_id=? AND capture_nonce=?)',
          [input.operationId, nonce],
        ),
        ...(input.guardWrites ?? []),
        this.db
          .prepare(
            "INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json) VALUES (?,'copy.begin',0,'copy.begin',?)",
          )
          .bind(input.operationId, marker),
      ]);
    } catch {
      const captured = await this.db
        .prepare(
          'SELECT account_id,owner_subject,request_json FROM tasks_command_plans WHERE operation_id=?',
        )
        .bind(input.operationId)
        .first<{
          account_id: string;
          owner_subject: string;
          request_json: string;
        }>();
      if (
        !captured ||
        captured.account_id !== input.accountId ||
        captured.owner_subject !== input.ownerSubject ||
        captured.request_json !== requestJson
      )
        throw conflict();
    }
    const admitted = await this.admit(input.operationId, input.accountId);
    if (legacy)
      await this.appendLists(input.operationId, input.accountId, [
        input.newList
          ? {
              key: 'list',
              position: 0,
              title: input.newList.title,
              boardId: input.newList.boardId,
              ...(input.newList.boardRevision === undefined
                ? {}
                : { boardRevision: input.newList.boardRevision }),
              targetListId: input.listId!,
            }
          : {
              key: 'list',
              position: 0,
              existingListId: input.listId!,
              revision: input.listRevision!,
            },
      ]);
    if (input.lists?.length)
      await this.appendLists(input.operationId, input.accountId, input.lists);
    return admitted;
  }
  private unsealedGuard(operationId: string, accountId: string): D1PreparedStatement {
    return this.guard(
      `EXISTS (SELECT 1 FROM tasks_command_plans plan JOIN tasks_operations operation ON operation.id=plan.operation_id WHERE plan.operation_id=? AND plan.account_id=? AND json_extract(plan.copy_context_json,'$.sealed')=0 AND operation.state='accepted' AND operation.cancel_requested=0 AND operation.input_sealed=0)`,
      [operationId, accountId],
    );
  }
  async appendLists(
    operationId: string,
    accountId: string,
    input: readonly CopyListDefinition[],
  ): Promise<void> {
    const context = await this.context(operationId, accountId);
    await assertLocalWritable(this.db, accountId);
    if (!input.length || input.length > 10)
      throw new AppError('validation_failed', 'append one to ten list definitions', 422);
    bounded(input);
    const definitions = input.map((value) => parse(CopyListDefinitionSchema, value));
    bounded(definitions);
    if (
      new Set(definitions.map((value) => value.key)).size !== definitions.length ||
      new Set(definitions.map((value) => value.position)).size !== definitions.length
    )
      throw new AppError('validation_failed', 'use each list key and position once per chunk', 422);
    const validatedBoards = new Set<string>();
    const captured: {
      definition: z.output<typeof CopyListDefinitionSchema>;
      list: ListRef;
    }[] = [];
    for (const definition of definitions) {
      if (definition.position >= context.totalLists)
        throw new AppError(
          'validation_failed',
          'this list position is outside the captured plan',
          422,
        );
      const previous = await this.db
        .prepare('SELECT * FROM tasks_command_copy_lists WHERE operation_id=? AND item_key=?')
        .bind(operationId, definition.key)
        .first<{
          input_json: string;
          input_hash?: string | null;
        }>();
      if (previous) {
        if (
          previous.input_json === '{}' && previous.input_hash
            ? previous.input_hash !== (await digest(encode(definition)))
            : previous.input_json !== encode(definition)
        )
          throw conflict('this list source key already has different input');
        continue;
      }
      if (context.sealed) throw conflict('this copy is already sealed');
      let list: ListRef;
      if (definition.existingListId)
        list = await this.list(accountId, definition.existingListId, definition.revision!);
      else {
        if (!this.options.validateBoardTarget)
          throw new AppError(
            'installation_unavailable',
            'board destination validation is not configured',
            503,
          );
        try {
          const key = JSON.stringify([definition.boardId, definition.boardRevision]);
          if (!validatedBoards.has(key)) {
            await this.options.validateBoardTarget(
              accountId,
              definition.boardId!,
              definition.boardRevision,
              operationId,
            );
            validatedBoards.add(key);
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            'validation_failed',
            'choose an existing destination board from this account',
            422,
          );
        }
        list = {
          id: definition.targetListId ?? (await copyListId(operationId, definition.key)),
          accountId,
          title: definition.title!,
          providerId: 'pending',
          providerEtag: null,
          isDefault: false,
          revision: 0,
          projectionRevision: 0,
          complete: true,
        };
      }
      captured.push({ definition, list });
    }
    if (!captured.length) return;
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.unsealedGuard(operationId, accountId),
        this.guard('NOT EXISTS(SELECT 1 FROM tasks_command_copy_validation WHERE operation_id=?)', [
          operationId,
        ]),
        ...captured.flatMap(({ definition, list }) => [
          this.guard(
            'NOT EXISTS (SELECT 1 FROM tasks_command_copy_lists WHERE operation_id=? AND (item_key=? OR position=? OR list_id=?))',
            [operationId, definition.key, definition.position, list.id],
          ),
          this.db
            .prepare(
              'INSERT INTO tasks_command_copy_lists(operation_id,item_key,position,list_id,board_id,board_revision,is_new,input_json,list_json) VALUES (?,?,?,?,?,?,?,?,?)',
            )
            .bind(
              operationId,
              definition.key,
              definition.position,
              list.id,
              definition.boardId ?? null,
              definition.boardRevision ?? null,
              Number(!definition.existingListId),
              encode(definition),
              encode(list),
            ),
          this.db
            .prepare('INSERT INTO tasks_command_resources(operation_id,list_id) VALUES (?,?)')
            .bind(operationId, list.id),
        ]),
        this.guard(
          '(SELECT COUNT(*) FROM tasks_command_copy_lists WHERE operation_id=? AND is_new=1)<=?',
          [operationId, context.newListCount],
        ),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      await assertLocalWritable(this.db, accountId);
      const replays = await this.db
        .prepare(
          "SELECT item_key,input_json FROM tasks_command_copy_lists WHERE operation_id=? AND item_key IN (SELECT json_extract(value,'$.definition.key') FROM json_each(?))",
        )
        .bind(operationId, JSON.stringify(captured))
        .all<{
          item_key: string;
          input_json: string;
        }>();
      if (
        captured.every(({ definition }) =>
          replays.results.some(
            (row) => row.item_key === definition.key && row.input_json === encode(definition),
          ),
        )
      )
        return;
      throw conflict('a list definition collided with another key, position or capture revision');
    }
  }
  async appendTasks(
    operationId: string,
    accountId: string,
    input: readonly CopyEntry[],
  ): Promise<void> {
    const context = await this.context(operationId, accountId);
    await assertLocalWritable(this.db, accountId);
    if (!input.length || input.length > 10)
      throw new AppError('validation_failed', 'append one to ten task records', 422);
    bounded(input);
    const entries = input.map((value) => {
      const parsed = parse(CopyEntrySchema, value);
      return { ...parsed, listKey: parsed.listKey ?? (context.totalLists === 1 ? 'list' : '') };
    });
    bounded(entries);
    if (
      new Set(entries.map((value) => value.key)).size !== entries.length ||
      new Set(entries.map((value) => value.position)).size !== entries.length
    )
      throw new AppError('validation_failed', 'use each task key and position once per chunk', 422);
    if (
      entries.some(
        (entry) =>
          !entry.listKey ||
          entry.position >= context.totalTasks ||
          new Set(entry.dependencyKeys).size !== entry.dependencyKeys.length ||
          entry.dependencyKeys.length + entry.existingBlockerIds.length > 50,
      )
    )
      throw new AppError(
        'validation_failed',
        'choose a captured list key, unique dependencies and a position within the plan',
        422,
      );
    const captured: {
      entry: (typeof entries)[number];
      taskId: string;
    }[] = [];
    for (const entry of entries) {
      const previous = await this.db
        .prepare('SELECT * FROM tasks_command_copy_entries WHERE operation_id=? AND item_key=?')
        .bind(operationId, entry.key)
        .first<{
          input_json: string;
          input_hash?: string | null;
        }>();
      if (previous) {
        if (
          previous.input_json === '{}' && previous.input_hash
            ? previous.input_hash !== (await digest(encode(entry)))
            : previous.input_json !== encode(entry)
        )
          throw conflict('this task source key already has different captured input');
        continue;
      }
      if (context.sealed) throw conflict('this copy is already sealed');
      captured.push({ entry, taskId: await copyTaskId(operationId, entry.key) });
    }
    if (!captured.length) return;
    if (captured.some(({ entry }) => entry.labelIds.length || entry.existingBlockerIds.length)) {
      if (!this.options.metadata)
        throw new AppError(
          'installation_unavailable',
          'copy metadata validation is not configured',
          503,
        );
      await this.options.metadata.validateCreationMetadataBatch(
        accountId,
        captured.map(({ entry }) => ({
          labelIds: entry.labelIds,
          blockedBy: entry.existingBlockerIds,
        })),
        await this.options.metadata.getGraphRevision(accountId),
      );
    }
    try {
      await this.db.batch([
        localWriteGuard(this.db, accountId),
        this.unsealedGuard(operationId, accountId),
        this.guard('NOT EXISTS(SELECT 1 FROM tasks_command_copy_validation WHERE operation_id=?)', [
          operationId,
        ]),
        ...captured.flatMap(({ entry, taskId }) => [
          this.guard(
            'NOT EXISTS (SELECT 1 FROM tasks_command_copy_entries WHERE operation_id=? AND (item_key=? OR position=?))',
            [operationId, entry.key, entry.position],
          ),
          this.db
            .prepare(
              'INSERT INTO tasks_command_copy_entries(operation_id,item_key,position,task_id,parent_key,previous_key,previous_explicit,input_json,list_key) VALUES (?,?,?,?,?,?,?,?,?)',
            )
            .bind(
              operationId,
              entry.key,
              entry.position,
              taskId,
              entry.parentKey,
              entry.previousKey ?? null,
              Number(entry.previousKey !== undefined),
              encode(entry),
              entry.listKey,
            ),
        ]),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      await assertLocalWritable(this.db, accountId);
      const replays = await this.db
        .prepare(
          "SELECT item_key,input_json FROM tasks_command_copy_entries WHERE operation_id=? AND item_key IN (SELECT json_extract(value,'$.entry.key') FROM json_each(?))",
        )
        .bind(operationId, JSON.stringify(captured))
        .all<{
          item_key: string;
          input_json: string;
        }>();
      if (
        captured.every(({ entry }) =>
          replays.results.some(
            (row) => row.item_key === entry.key && row.input_json === encode(entry),
          ),
        )
      )
        return;
      throw conflict('a captured task collided with another key, position or seal');
    }
  }
  private validationSql(operationId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT 1 AS invalid FROM tasks_command_copy_entries entry
      LEFT JOIN tasks_command_copy_lists list ON list.operation_id=entry.operation_id AND list.item_key=entry.list_key
      LEFT JOIN tasks_command_copy_entries parent ON parent.operation_id=entry.operation_id AND parent.item_key=entry.parent_key
      LEFT JOIN tasks_command_copy_entries previous ON previous.operation_id=entry.operation_id AND previous.item_key=entry.previous_key
      WHERE entry.operation_id=? AND (list.item_key IS NULL OR (entry.parent_key IS NOT NULL AND (parent.item_key IS NULL OR parent.parent_key IS NOT NULL OR parent.list_key<>entry.list_key OR parent.position>=entry.position))
      OR (entry.previous_key IS NOT NULL AND (previous.item_key IS NULL OR previous.position>=entry.position OR previous.list_key<>entry.list_key OR previous.parent_key IS NOT entry.parent_key))
      OR EXISTS (SELECT 1 FROM json_each(entry.input_json,'$.dependencyKeys') selected LEFT JOIN tasks_command_copy_entries blocker ON blocker.operation_id=entry.operation_id AND blocker.item_key=selected.value WHERE blocker.item_key IS NULL OR blocker.item_key=entry.item_key))
      LIMIT 1`,
      )
      .bind(operationId);
  }
  async seal(operationId: string, accountId: string): Promise<CopySealResult> {
    const capture = await this.capture(operationId, accountId),
      context = JSON.parse(capture.copy_context_json) as CopyContext;
    if (context.sealed)
      return {
        ...(await this.options.operations.get(operationId, accountId))!,
        captureSealed: true,
        validation: {
          stage: 'ready',
          checkedTasks: context.totalTasks,
          totalTasks: context.totalTasks,
          remainingTasks: 0,
        },
      };
    await assertProviderWritable(this.db, accountId);
    const validator = new CopyDependencyValidator(this.db);
    const existingCondition = `NOT EXISTS (SELECT 1 FROM tasks_command_copy_lists selected LEFT JOIN tasks_lists list ON list.account_id=? AND list.id=selected.list_id WHERE selected.operation_id=? AND selected.is_new=0 AND (list.id IS NULL OR list.deleted_at IS NOT NULL OR list.revision<>json_extract(selected.list_json,'$.revision') OR list.projection_revision<>json_extract(selected.list_json,'$.projectionRevision') OR list.tasks_complete_at IS NULL OR list.completed_complete_at IS NULL OR list.sync_cursor IS NOT NULL))`;
    const listGuards = [this.guard(existingCondition, [accountId, operationId])];
    if (!(await validator.started(operationId, accountId))) {
      const lists = (
        await this.db
          .prepare('SELECT * FROM tasks_command_copy_lists WHERE operation_id=? ORDER BY position')
          .bind(operationId)
          .all<ListRow>()
      ).results;
      const taskCounts = await this.db
        .prepare(
          'SELECT COUNT(*) AS n,MIN(position) AS first,MAX(position) AS last FROM tasks_command_copy_entries WHERE operation_id=?',
        )
        .bind(operationId)
        .first<{
          n: number;
          first: number | null;
          last: number | null;
        }>();
      if (
        lists.length !== context.totalLists ||
        lists.some((row, index) => row.position !== index) ||
        lists.filter((row) => row.is_new).length !== context.newListCount ||
        taskCounts?.n !== context.totalTasks ||
        (context.totalTasks > 0 &&
          (taskCounts.first !== 0 || taskCounts.last !== context.totalTasks - 1))
      )
        throw conflict('capture every selected list and task before sealing this copy');
      if (
        context.parent &&
        (await this.db
          .prepare(
            "SELECT 1 FROM tasks_command_copy_entries WHERE operation_id=? AND (parent_key IS NOT NULL OR json_extract(input_json,'$.repeatRule') IS NOT NULL) LIMIT 1",
          )
          .bind(operationId)
          .first())
      )
        throw new AppError(
          'validation_failed',
          'a copy under an existing parent cannot have subtasks or active repetition',
          422,
        );
      if (await this.validationSql(operationId).first())
        throw new AppError(
          'validation_failed',
          'the copy has a missing, cyclic, cross-list or deeper reference',
          422,
        );
      // Existing destinations are checked with one SQL selection, including all 100
      // definitions. New board targets were checked in bounded append calls and the
      // executor fences each unsent provider dispatch through the board owner.
      if (
        await this.db
          .prepare(`SELECT 1 WHERE NOT (${existingCondition})`)
          .bind(accountId, operationId)
          .first()
      )
        throw conflict('an existing destination changed while this copy was captured');
      await validator.initialize(operationId, accountId, context.totalTasks, [
        this.unsealedGuard(operationId, accountId),
        ...listGuards,
        this.guard(
          `(SELECT COUNT(*) FROM tasks_command_copy_lists WHERE operation_id=?)=? AND (SELECT COUNT(*) FROM tasks_command_copy_entries WHERE operation_id=?)=?`,
          [operationId, context.totalLists, operationId, context.totalTasks],
        ),
      ]);
    }
    const validation = await validator.advance(operationId, accountId);
    if (validation.stage !== 'ready')
      return {
        ...(await this.options.operations.get(operationId, accountId))!,
        captureSealed: false,
        validation,
      };
    const sourceContext = encode({
      source: context.source,
      origin: context.origin,
      ...(context.scheduleId ? { scheduleId: context.scheduleId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
    });
    try {
      await this.db.batch([
        providerWriteGuard(this.db, accountId),
        this.unsealedGuard(operationId, accountId),
        this.guard(
          "EXISTS(SELECT 1 FROM tasks_command_copy_validation WHERE operation_id=? AND account_id=? AND stage='ready' AND checked_tasks=total_tasks)",
          [operationId, accountId],
        ),
        ...listGuards,
        // Seal and materialization share a SQL transaction; appenders cannot alter the validated set.
        this.guard(
          `(SELECT COUNT(*) FROM tasks_command_copy_lists WHERE operation_id=?)=? AND (SELECT COUNT(*) FROM tasks_command_copy_entries WHERE operation_id=?)=?`,
          [operationId, context.totalLists, operationId, context.totalTasks],
        ),
        this.db
          .prepare(
            `UPDATE tasks_command_copy_entries SET previous_key=(SELECT sibling.item_key FROM tasks_command_copy_entries sibling WHERE sibling.operation_id=tasks_command_copy_entries.operation_id AND sibling.list_key=tasks_command_copy_entries.list_key AND sibling.parent_key IS tasks_command_copy_entries.parent_key AND sibling.position<tasks_command_copy_entries.position ORDER BY sibling.position DESC LIMIT 1) WHERE operation_id=? AND previous_explicit=0`,
          )
          .bind(operationId),
        this.db
          .prepare(
            `INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json)
        SELECT operation_id,'copy.list:'||item_key,ROW_NUMBER() OVER(ORDER BY position),'list.create',json_patch(json_object('action','list.create','list',json(list_json),'targetId',list_id,'title',json_extract(input_json,'$.title'),'boardId',board_id,'boardRevision',board_revision,'listColor',json_extract(input_json,'$.color'),'copyListKey',item_key,'commandKind','list.create'),json(?)) FROM tasks_command_copy_lists WHERE operation_id=? AND is_new=1`,
          )
          .bind(sourceContext, operationId),
        this.db
          .prepare(
            `INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json)
        SELECT entry.operation_id,'copy.task:'||entry.item_key,?+ROW_NUMBER() OVER(ORDER BY entry.parent_key IS NOT NULL,entry.position),'task.create',json_patch(json_object(
          'action','task.create','list',json(list.list_json),'targetId',entry.task_id,'copyKey',entry.item_key,'copyListKey',entry.list_key,'copyParentKey',entry.parent_key,'copyPreviousKey',entry.previous_key,'copyPosition',entry.position,
          'provider',json_object('title',json_extract(entry.input_json,'$.title'),'notes',json_extract(entry.input_json,'$.notes'),'dueDay',json_extract(entry.input_json,'$.scheduledDay'),'status',CASE WHEN json_extract(entry.input_json,'$.completed')=1 THEN 'completed' ELSE 'needsAction' END),
          'schedule',json_object('scheduledDay',json_extract(entry.input_json,'$.scheduledDay'),'scheduledTime',json_extract(entry.input_json,'$.scheduledTime'),'timeZone',json_extract(entry.input_json,'$.timeZone'),'repeatRule',json_extract(entry.input_json,'$.repeatRule')),
          'metadata',json_object('labelIds',json_extract(entry.input_json,'$.labelIds'),'priority',json_extract(entry.input_json,'$.priority'),'starred',json_extract(entry.input_json,'$.starred'),'blockedBy',json('[]')),'commandKind','task.duplicate'),json(?))
        FROM tasks_command_copy_entries entry JOIN tasks_command_copy_lists list ON list.operation_id=entry.operation_id AND list.item_key=entry.list_key WHERE entry.operation_id=?`,
          )
          .bind(context.newListCount, sourceContext, operationId),
        this.db
          .prepare(
            `INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json)
        WITH RECURSIVE chunks(n) AS (SELECT 0 WHERE ?>0 UNION ALL SELECT n+1 FROM chunks WHERE n+1<?)
        SELECT ?,'copy.metadata:'||n,?+n,'copy.metadata',json_patch(json_object('action','copy.metadata','list',json(?),'copyPosition',n*10,'commandKind','task.duplicate'),json(?)) FROM chunks`,
          )
          .bind(
            context.totalTasks,
            Math.ceil(context.totalTasks / 10),
            operationId,
            1 + context.newListCount + context.totalTasks,
            encode(context.list),
            sourceContext,
          ),
        this.db
          .prepare(
            "INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json) VALUES (?,'copy.finish',?,'copy.begin',?)",
          )
          .bind(
            operationId,
            capture.total_steps - 1,
            encode({
              action: 'copy.begin',
              list: context.list,
              commandKind: 'task.duplicate',
              source: context.source,
              origin: context.origin,
            }),
          ),
        this.db
          .prepare(
            "UPDATE tasks_command_plans SET copy_context_json=json_set(copy_context_json,'$.sealed',json('true')) WHERE operation_id=? AND account_id=?",
          )
          .bind(operationId, accountId),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((await this.context(operationId, accountId)).sealed)
        return {
          ...(await this.options.operations.get(operationId, accountId))!,
          captureSealed: true,
          validation,
        };
      await assertProviderWritable(this.db, accountId);
      throw conflict('the destination or captured input changed while sealing this copy');
    }
    return {
      ...(await this.options.operations.get(operationId, accountId))!,
      captureSealed: true,
      validation,
    };
  }
  /** One bounded journal promotion; no HTTP dispatch is allowed until this finishes. */
  async promote(operationId: string, accountId: string): Promise<OperationRecord> {
    const capture = await this.capture(operationId, accountId),
      context = JSON.parse(capture.copy_context_json) as CopyContext;
    let operation = (await this.options.operations.get(operationId, accountId))!;
    if (operation.finished) return operation;
    if (!context.sealed)
      throw conflict('capture and validate the complete copy before promoting provider steps');
    if (operation.inputSealed) return operation;
    const rows = (
      await this.db
        .prepare(
          `SELECT item_key,position,kind,input_json FROM tasks_command_steps WHERE operation_id=? AND item_key NOT IN(SELECT item_key FROM tasks_operation_steps WHERE operation_id=?) ORDER BY position LIMIT 10`,
        )
        .bind(operationId, operationId)
        .all<{
          item_key: string;
          position: number;
          kind: string;
          input_json: string;
        }>()
    ).results;
    const selected: typeof rows = [];
    for (const row of rows) {
      if (selected.length && bytes([...selected, row]) > 48000) break;
      selected.push(row);
    }
    if (selected.length)
      await this.options.operations.appendSteps(
        operationId,
        accountId,
        selected.map((row) => ({
          key: row.item_key,
          position: row.position,
          kind: row.kind,
          input: JSON.parse(row.input_json) as unknown,
        })),
      );
    const count = await this.db
      .prepare('SELECT COUNT(*) AS n FROM tasks_operation_steps WHERE operation_id=?')
      .bind(operationId)
      .first<{
        n: number;
      }>();
    if (count?.n === capture.total_steps)
      await this.options.operations.seal(operationId, accountId);
    operation = (await this.options.operations.get(operationId, accountId))!;
    return operation;
  }
  async readProgress(
    operationId: string,
    accountId: string,
    input: {
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{
    items: {
      key: string;
      taskId: string;
      revision: number;
      providerEtag: string | null;
    }[];
    nextCursor: string | null;
  }> {
    await this.capture(operationId, accountId);
    const limit = parse(z.number().int().min(1).max(100), input.limit ?? 50);
    let position = -1;
    if (input.cursor) {
      try {
        const cursor = z
          .object({ operationId: OperationIdSchema, accountId: identity, position: count })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (cursor.operationId !== operationId || cursor.accountId !== accountId) throw new Error();
        position = cursor.position;
      } catch {
        throw new AppError(
          'validation_failed',
          'this copy progress cursor belongs to another selection',
          422,
        );
      }
    }
    const rows = (
      await this.db
        .prepare(
          `SELECT entry.position,receipt.item_key,receipt.task_id,receipt.revision,receipt.provider_etag FROM tasks_command_copy_receipts receipt JOIN tasks_command_copy_entries entry ON entry.operation_id=receipt.operation_id AND entry.item_key=receipt.item_key WHERE receipt.operation_id=? AND entry.position>? ORDER BY entry.position LIMIT ?`,
        )
        .bind(operationId, position, limit + 1)
        .all<{
          position: number;
          item_key: string;
          task_id: string;
          revision: number;
          provider_etag: string | null;
        }>()
    ).results;
    const selected = rows.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map((row) => ({
        key: row.item_key,
        taskId: row.task_id,
        revision: row.revision,
        providerEtag: row.provider_etag,
      })),
      nextCursor:
        rows.length > limit && last
          ? btoa(JSON.stringify({ operationId, accountId, position: last.position }))
          : null,
    };
  }
}
