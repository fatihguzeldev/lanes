import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import {
  assertLocalWritable,
  assertProviderWritable,
} from '../../../accounts/server/connections/access';

import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { OperationIdSchema } from '../../../operations/contracts/receipt';
import type { OperationStore } from '../../../operations/server/journal/store';
import type { OperationRecord } from '../../../operations/server/journal/records';
import type { TaskCommandService } from '../../../tasks/server/commands/service';
import type { BeginCapturedCopy } from '../../../tasks/server/commands/copy-contract';
import {
  ListSnapshotStore,
  ListTemplateService,
  materializeTemplateTask,
} from '../../../tasks/server/templates/lists';
import {
  TemplatePageOptionsSchema,
  type SnapshotSummary,
  type TemplateApplicationOptions as ApplicationSettings,
  type TemplatePreview,
  type TemplatePageOptions,
} from '../../../tasks/contracts/template';
import {
  ApplyTemplateSchema,
  TemplateReferenceSchema,
  TemplateRunSummarySchema,
  type TemplateReference,
  type TemplateRunSummary,
} from '../../contracts/template';
import type { BoardService } from '../boards/service';
import { BoardTemplateService } from './definitions';
const id = ResourceIdSchema.max(1024);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const settings = (input: ApplicationSettings): ApplicationSettings => ({
  applicationDay: input.applicationDay,
  useRelativeDates: input.useRelativeDates,
  listPrefix: input.listPrefix,
});
interface CapturedApplication {
  input: z.output<typeof ApplyTemplateSchema>;
  snapshot: SnapshotSummary;
  sourceName: string;
  appearance: {
    title: string;
    emoji: string | null;
    color: string;
    backgroundUrl: string | null;
  } | null;
  destinationBoardId: string;
  destinationRevision: number;
  admission: Omit<BeginCapturedCopy, 'guardWrites'>;
}
interface RunRow {
  id: string;
  account_id: string;
  schedule_id: string | null;
  slot_day: string;
  snapshot_id: string;
  operation_id: string;
  state: TemplateRunSummary['state'];
  error_code: string | null;
  captured_json: string;
  list_cursor: string | null;
  task_cursor: string | null;
  lists_captured: number;
  tasks_captured: number;
  skipped_before: string | null;
  next_attempt_at: number;
  work_order: number;
  created_at: number;
  updated_at: number;
}
export interface TemplateRunContext {
  operationId: string;
  ownerSubject: string;
  origin?: 'owner' | 'scheduled';
  scheduleId?: string;
  runId?: string;
  admissionWrites?: D1PreparedStatement[];
  skippedBefore?: string | null;
}
export interface TemplateApplicationDependencies {
  snapshots: ListSnapshotStore;
  listTemplates: ListTemplateService;
  boardTemplates: BoardTemplateService;
  boards: Pick<BoardService, 'getBoard' | 'prepareCreateBoard'>;
  commands: Pick<
    TaskCommandService,
    | 'beginCapturedCopy'
    | 'appendCapturedCopyLists'
    | 'appendCapturedCopy'
    | 'sealCapturedCopy'
    | 'advance'
  >;
  operations: Pick<OperationStore, 'get' | 'cancel' | 'resume'>;
  now?: () => number;
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AppError('validation_failed', 'check the template application fields', 422);
  return parsed.data;
}
function guard(db: D1Database, condition: string, bindings: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
    .bind(...bindings);
}
async function stableId(prefix: string, value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return (
    prefix +
    Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)
  );
}
function model(row: RunRow): TemplateRunSummary {
  return TemplateRunSummarySchema.parse({
    id: row.id,
    accountId: row.account_id,
    scheduleId: row.schedule_id,
    slotDay: row.slot_day,
    snapshotId: row.snapshot_id,
    operationId: row.operation_id,
    state: row.state,
    errorCode: row.error_code,
    skippedBefore: row.skipped_before,
  });
}
/** Application captures a revision once. Source/template edits never change an admitted run. */
export class TemplateApplicationService {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: TemplateApplicationDependencies,
  ) {
    this.now = options.now ?? Date.now;
  }
  private async row(accountId: string, runId: string): Promise<RunRow> {
    parse(id, accountId);
    parse(id, runId);
    const row = await this.db
      .prepare('SELECT * FROM boards_template_runs WHERE account_id=? AND id=?')
      .bind(accountId, runId)
      .first<RunRow>();
    if (!row) throw new AppError('not_found', 'this template run is no longer available', 404);
    return row;
  }
  private async settle(row: RunRow, operation: OperationRecord | null): Promise<RunRow> {
    if (!operation || (!operation.finished && !terminal.has(operation.state))) return row;
    const state =
      operation.state === 'succeeded'
        ? 'succeeded'
        : operation.state === 'cancelled'
          ? 'cancelled'
          : 'paused';
    if (row.state === 'cancelled' || row.state === 'succeeded') return row;
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE boards_template_runs SET state=?,error_code=?,updated_at=? WHERE account_id=? AND id=?',
        )
        .bind(
          state,
          state === 'paused' ? operation.state : null,
          this.now(),
          row.account_id,
          row.id,
        ),
      ...(state !== 'paused'
        ? [this.options.snapshots.releasePinWrite(row.account_id, row.snapshot_id, `run:${row.id}`)]
        : []),
    ]);
    return this.row(row.account_id, row.id);
  }
  async get(accountId: string, runId: string): Promise<TemplateRunSummary> {
    const row = await this.row(accountId, runId);
    return model(
      await this.settle(row, await this.options.operations.get(row.operation_id, accountId)),
    );
  }
  /** Generic operation progress may finish a repaired copy while its template
   * run still shows the previous pause. Composition reports that outcome here;
   * this observes the journal and never dispatches or resumes unsent work. */
  async reconcileOperation(
    accountId: string,
    operationId: string,
  ): Promise<TemplateRunSummary | null> {
    parse(id, accountId);
    parse(OperationIdSchema, operationId);
    const run = await this.db
      .prepare('SELECT id FROM boards_template_runs WHERE account_id=? AND operation_id=?')
      .bind(accountId, operationId)
      .first<{ id: string }>();
    return run ? this.get(accountId, run.id) : null;
  }
  async reference(accountId: string, input: TemplateReference) {
    const ref = parse(TemplateReferenceSchema, input);
    return ref.kind === 'list'
      ? this.options.listTemplates.getVersion(accountId, ref.id, ref.contentRevision)
      : this.options.boardTemplates.getVersion(accountId, ref.id, ref.contentRevision);
  }
  referenceGuardWrite(
    accountId: string,
    reference: TemplateReference,
    snapshotId: string,
  ): D1PreparedStatement {
    return reference.kind === 'list'
      ? this.options.listTemplates.versionGuardWrite(
          accountId,
          reference.id,
          reference.contentRevision,
          snapshotId,
        )
      : this.options.boardTemplates.versionGuardWrite(
          accountId,
          reference.id,
          reference.contentRevision,
          snapshotId,
        );
  }
  async preview(
    accountId: string,
    reference: TemplateReference,
    options: ApplicationSettings,
  ): Promise<TemplatePreview> {
    const source = await this.reference(accountId, reference);
    return this.options.snapshots.previewApplication(accountId, source.snapshot.id, options);
  }
  async labelColorConflicts(
    accountId: string,
    reference: TemplateReference,
    input: TemplatePageOptions = {},
  ) {
    const source = await this.reference(accountId, reference);
    return this.options.snapshots.listLabelColorConflicts(accountId, source.snapshot.id, input);
  }
  async begin(
    accountId: string,
    rawInput: unknown,
    context: TemplateRunContext,
  ): Promise<TemplateRunSummary> {
    parse(id, accountId);
    parse(OperationIdSchema, context.operationId);
    parse(id, context.ownerSubject);
    const input = parse(ApplyTemplateSchema, rawInput),
      runId = parse(id, context.runId ?? (await stableId('run-', context.operationId)));
    const prior = await this.db
      .prepare('SELECT * FROM boards_template_runs WHERE operation_id=?')
      .bind(context.operationId)
      .first<RunRow>();
    if (prior) {
      if (
        prior.account_id !== accountId ||
        JSON.stringify((JSON.parse(prior.captured_json) as CapturedApplication).input) !==
          JSON.stringify(input)
      )
        throw new AppError(
          'conflict',
          'this run identity already belongs to different captured input',
          409,
        );
      const operation = await this.options.operations.get(context.operationId, accountId),
        settled = await this.settle(prior, operation);
      if (!operation?.finished && !['succeeded', 'cancelled'].includes(settled.state))
        await this.ensureAdmission(settled);
      return this.get(accountId, prior.id);
    }
    await assertProviderWritable(this.db, accountId);
    const source = await this.reference(accountId, input.template),
      snapshot = source.snapshot;
    if (input.destination.kind === 'new' && source.kind !== 'board')
      throw new AppError(
        'validation_failed',
        'a list template adds a list to an existing board',
        422,
      );
    await this.options.snapshots.previewApplication(accountId, snapshot.id, settings(input));
    let destinationBoardId: string, destinationRevision: number;
    if (input.destination.kind === 'existing') {
      const board = await this.options.boards.getBoard(accountId, input.destination.boardId);
      if (board.revision !== input.destination.boardRevision)
        throw new AppError(
          'conflict',
          'the destination board changed; refresh the application preview',
          409,
        );
      destinationBoardId = board.id;
      destinationRevision = board.revision;
    } else {
      destinationBoardId = await stableId('board-', context.operationId);
      destinationRevision = 0;
    }
    const admission: Omit<BeginCapturedCopy, 'guardWrites'> = {
      operationId: context.operationId,
      ownerSubject: context.ownerSubject,
      accountId,
      source: 'template',
      origin: context.origin ?? 'owner',
      totalTasks: snapshot.taskCount,
      totalLists: snapshot.listCount,
      newListCount: snapshot.listCount,
      requestKey: JSON.stringify({
        template: input.template,
        snapshotId: snapshot.id,
        applicationDay: input.applicationDay,
        destination: input.destination,
      }),
      ...(context.scheduleId ? { scheduleId: context.scheduleId } : {}),
      runId,
    };
    const captured: CapturedApplication = {
      input,
      snapshot,
      sourceName: source.name,
      appearance: source.kind === 'board' ? source.appearance : null,
      destinationBoardId,
      destinationRevision,
      admission,
    };
    const sourceGuard =
      input.template.kind === 'list'
        ? this.options.listTemplates.versionGuardWrite(
            accountId,
            input.template.id,
            input.template.contentRevision,
            snapshot.id,
          )
        : this.options.boardTemplates.versionGuardWrite(
            accountId,
            input.template.id,
            input.template.contentRevision,
            snapshot.id,
          );
    try {
      await this.options.commands.beginCapturedCopy({
        ...admission,
        guardWrites: [
          sourceGuard,
          ...(context.admissionWrites ?? []),
          this.options.snapshots.pinWrite(accountId, snapshot.id, `run:${runId}`),
          this.db
            .prepare(
              "INSERT INTO boards_template_runs(id,account_id,schedule_id,slot_day,snapshot_id,operation_id,state,captured_json,skipped_before,next_attempt_at,created_at,updated_at,work_order) VALUES (?,?,?,?,?,?,'capturing',?,?,?,?,?,(SELECT COALESCE(MAX(work_order),0)+1 FROM boards_template_runs))",
            )
            .bind(
              runId,
              accountId,
              context.scheduleId ?? null,
              input.applicationDay,
              snapshot.id,
              context.operationId,
              JSON.stringify(captured),
              context.skippedBefore ?? null,
              this.now(),
              this.now(),
              this.now(),
            ),
        ],
      });
    } catch (error) {
      const row = await this.db
        .prepare(
          'SELECT id FROM boards_template_runs WHERE account_id=? AND id=? AND operation_id=?',
        )
        .bind(accountId, runId, context.operationId)
        .first();
      if (row && error instanceof AppError)
        await this.db
          .prepare(
            "UPDATE boards_template_runs SET state='paused',error_code=?,updated_at=? WHERE account_id=? AND id=? AND operation_id=?",
          )
          .bind(error.code, this.now(), accountId, runId, context.operationId)
          .run();
      throw error;
    }
    return this.get(accountId, runId);
  }
  private async ensureAdmission(row: RunRow): Promise<OperationRecord> {
    const captured = JSON.parse(row.captured_json) as CapturedApplication;
    return this.options.commands.beginCapturedCopy(captured.admission);
  }
  /** Only an admitted run may name a board that its initial local marker has yet to create. */
  async validatePendingBoardTarget(
    accountId: string,
    boardId: string,
    expectedRevision: number | undefined,
    operationId: string,
  ): Promise<void> {
    const row = await this.db
      .prepare(
        "SELECT * FROM boards_template_runs WHERE account_id=? AND operation_id=? AND state IN ('capturing','running')",
      )
      .bind(accountId, operationId)
      .first<RunRow>();
    if (!row)
      throw new AppError(
        'not_found',
        'the pending board does not belong to this admitted template run',
        404,
      );
    const captured = JSON.parse(row.captured_json) as CapturedApplication,
      operation = await this.options.operations.get(operationId, accountId);
    if (
      captured.input.destination.kind !== 'new' ||
      captured.destinationBoardId !== boardId ||
      (expectedRevision !== undefined && expectedRevision !== 0) ||
      !operation ||
      operation.finished ||
      terminal.has(operation.state) ||
      operation.cancelRequested
    )
      throw new AppError(
        'conflict',
        'this template run cannot create the requested board target',
        409,
      );
  }
  /** Called only for copy.begin in its claimed, sealed local journal transaction. */
  async prepareBeginWrites(accountId: string, operationId: string): Promise<D1PreparedStatement[]> {
    const row = await this.db
      .prepare('SELECT * FROM boards_template_runs WHERE account_id=? AND operation_id=?')
      .bind(accountId, operationId)
      .first<RunRow>();
    if (!row) return [];
    const captured = JSON.parse(row.captured_json) as CapturedApplication;
    if (captured.input.destination.kind !== 'new') return [];
    const operation = await this.options.operations.get(operationId, accountId);
    if (!operation?.inputSealed || operation.cancelRequested)
      throw new AppError(
        'conflict',
        'capture and admit the whole checklist before creating its board',
        409,
      );
    const appearance = captured.appearance;
    if (!appearance)
      throw new AppError(
        'storage_unavailable',
        'this captured board template has no appearance',
        503,
      );
    const board = await this.options.boards.prepareCreateBoard(
      accountId,
      {
        title: captured.input.destination.title,
        emoji: appearance.emoji,
        color: appearance.color,
        backgroundUrl: appearance.backgroundUrl,
      },
      captured.destinationBoardId,
    );
    return [
      guard(
        this.db,
        "EXISTS (SELECT 1 FROM boards_template_runs WHERE account_id=? AND operation_id=? AND state IN ('capturing','running'))",
        [accountId, operationId],
      ),
      ...board.writes,
    ];
  }
  async advance(accountId: string, runId: string): Promise<TemplateRunSummary> {
    const current = await this.row(accountId, runId),
      row = await this.settle(
        current,
        await this.options.operations.get(current.operation_id, accountId),
      );
    if (['succeeded', 'cancelled', 'paused'].includes(row.state)) return model(row);
    const captured = JSON.parse(row.captured_json) as CapturedApplication;
    try {
      let operation = await this.options.operations.get(row.operation_id, accountId);
      if (!operation) operation = await this.ensureAdmission(row);
      if (row.lists_captured < captured.snapshot.listCount) {
        const page = await this.options.snapshots.listLists(accountId, row.snapshot_id, {
          limit: 10,
          ...(row.list_cursor ? { cursor: row.list_cursor } : {}),
        });
        const prefix = captured.input.listPrefix ? captured.input.listPrefix + ' ' : '';
        await this.options.commands.appendCapturedCopyLists(
          row.operation_id,
          accountId,
          page.items.map((list) => ({
            key: list.key,
            position: list.position,
            title: prefix + list.title,
            color: list.color,
            boardId: captured.destinationBoardId,
            boardRevision: captured.destinationRevision,
          })),
        );
        await this.db
          .prepare(
            'UPDATE boards_template_runs SET list_cursor=?,lists_captured=lists_captured+?,updated_at=?,next_attempt_at=?,work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM boards_template_runs) WHERE account_id=? AND id=? AND lists_captured=?',
          )
          .bind(
            page.nextCursor,
            page.items.length,
            this.now(),
            this.now(),
            accountId,
            runId,
            row.lists_captured,
          )
          .run();
      } else if (row.tasks_captured < captured.snapshot.taskCount) {
        const page = await this.options.snapshots.listTasks(accountId, row.snapshot_id, {
          limit: 10,
          ...(row.task_cursor ? { cursor: row.task_cursor } : {}),
        });
        await this.options.commands.appendCapturedCopy(
          row.operation_id,
          accountId,
          page.items.map((task) => materializeTemplateTask(task, settings(captured.input)).entry),
        );
        await this.db
          .prepare(
            'UPDATE boards_template_runs SET task_cursor=?,tasks_captured=tasks_captured+?,updated_at=?,next_attempt_at=?,work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM boards_template_runs) WHERE account_id=? AND id=? AND tasks_captured=?',
          )
          .bind(
            page.nextCursor,
            page.items.length,
            this.now(),
            this.now(),
            accountId,
            runId,
            row.tasks_captured,
          )
          .run();
      } else {
        const sealed = await this.options.commands.sealCapturedCopy(row.operation_id, accountId);
        if (!sealed.captureSealed) {
          await this.db
            .prepare(
              `UPDATE boards_template_runs SET updated_at=?,work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM boards_template_runs)
            WHERE account_id=? AND id=? AND state='capturing'`,
            )
            .bind(this.now(), accountId, runId)
            .run();
          return this.get(accountId, runId);
        }
        await this.db
          .prepare(
            "UPDATE boards_template_runs SET state='running',error_code=NULL,updated_at=? WHERE account_id=? AND id=? AND state='capturing'",
          )
          .bind(this.now(), accountId, runId)
          .run();
        const result = await this.options.commands.advance(accountId, row.operation_id);
        operation = result.operation;
        const state =
          operation.state === 'succeeded'
            ? 'succeeded'
            : operation.state === 'cancelled'
              ? 'cancelled'
              : operation.finished ||
                  ['reconnect_required', 'blocked_by_limit', 'uncertain', 'failed'].includes(
                    operation.state,
                  )
                ? 'paused'
                : operation.state === 'partial'
                  ? 'partial'
                  : 'running';
        await this.db
          .prepare(
            'UPDATE boards_template_runs SET state=?,error_code=?,updated_at=?,next_attempt_at=?,work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM boards_template_runs) WHERE account_id=? AND id=?',
          )
          .bind(
            state,
            ['paused', 'partial'].includes(state) ? operation.state : null,
            this.now(),
            this.now() + (state === 'partial' ? 15000 : 0),
            accountId,
            runId,
          )
          .run();
        if (state === 'succeeded' || state === 'cancelled')
          await this.db.batch([
            this.options.snapshots.releasePinWrite(accountId, row.snapshot_id, `run:${runId}`),
          ]);
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const state = [
        'reconnect_required',
        'list_limit_reached',
        'not_found',
        'conflict',
        'validation_failed',
      ].includes(error.code)
        ? 'paused'
        : 'partial';
      await this.db
        .prepare(
          'UPDATE boards_template_runs SET state=?,error_code=?,updated_at=?,next_attempt_at=?,work_order=(SELECT COALESCE(MAX(work_order),0)+1 FROM boards_template_runs) WHERE account_id=? AND id=?',
        )
        .bind(state, error.code, this.now(), this.now() + 60000, accountId, runId)
        .run();
    }
    return this.get(accountId, runId);
  }
  async resume(accountId: string, runId: string): Promise<TemplateRunSummary> {
    await assertProviderWritable(this.db, accountId);
    const row = await this.row(accountId, runId),
      captured = JSON.parse(row.captured_json) as CapturedApplication;
    if (row.state === 'cancelled' || row.state === 'succeeded') return model(row);
    const operation = await this.options.operations.get(row.operation_id, accountId);
    if (captured.input.destination.kind === 'existing' || (operation?.confirmedSteps ?? 0) > 0) {
      const board = await this.options.boards.getBoard(accountId, captured.destinationBoardId);
      if (board.revision !== captured.destinationRevision)
        throw new AppError(
          'conflict',
          'the original destination changed; resolve or cancel this captured run before starting another copy',
          409,
        );
    }
    if (operation && ['reconnect_required', 'blocked_by_limit'].includes(operation.state))
      await this.options.operations.resume(operation.id, accountId, this.now());
    else if (operation && (operation.finished || terminal.has(operation.state)))
      throw new AppError(
        'conflict',
        'this operation has a terminal outcome; inspect its confirmed output before a new copy',
        409,
      );
    if (!operation) await this.ensureAdmission(row);
    await this.db
      .prepare(
        "UPDATE boards_template_runs SET state=CASE WHEN lists_captured<? OR tasks_captured<? OR ?=0 THEN 'capturing' ELSE 'running' END,error_code=NULL,next_attempt_at=?,updated_at=? WHERE account_id=? AND id=?",
      )
      .bind(
        captured.snapshot.listCount,
        captured.snapshot.taskCount,
        Number(operation?.inputSealed ?? false),
        this.now(),
        this.now(),
        accountId,
        runId,
      )
      .run();
    return this.get(accountId, runId);
  }
  async cancel(accountId: string, runId: string): Promise<TemplateRunSummary> {
    await assertLocalWritable(this.db, accountId);
    const row = await this.row(accountId, runId);
    const before = await this.options.operations.get(row.operation_id, accountId);
    if (before) await this.options.operations.cancel(row.operation_id, accountId, this.now());
    const operation = await this.options.operations.get(row.operation_id, accountId);
    if (operation && !operation.finished && !terminal.has(operation.state))
      throw new AppError(
        'conflict',
        'already dispatched work is still settling; inspect this run again before resolving it',
        409,
      );
    await this.db
      .prepare(
        "UPDATE boards_template_runs SET state='cancelled',updated_at=? WHERE account_id=? AND id=?",
      )
      .bind(this.now(), accountId, runId)
      .run();
    await this.db.batch([
      this.options.snapshots.releasePinWrite(accountId, row.snapshot_id, `run:${runId}`),
    ]);
    return this.get(accountId, runId);
  }
  async list(
    accountId: string,
    input: TemplatePageOptions = {},
  ): Promise<Page<TemplateRunSummary>> {
    parse(id, accountId);
    const options = parse(TemplatePageOptionsSchema, input);
    let after: {
      createdAt: number;
      id: string;
    } | null = null;
    if (options.cursor) {
      try {
        const cursor = z
          .object({ accountId: id, createdAt: z.number().int(), id })
          .strict()
          .parse(JSON.parse(atob(options.cursor)));
        if (cursor.accountId !== accountId) throw new Error();
        after = { createdAt: cursor.createdAt, id: cursor.id };
      } catch {
        throw new AppError('validation_failed', 'this run cursor belongs to another account', 422);
      }
    }
    const rows = (
        await this.db
          .prepare(
            `SELECT * FROM boards_template_runs WHERE account_id=? ${after === null ? '' : 'AND (created_at,id)<(?,?)'} ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .bind(
            accountId,
            ...(after === null ? [] : [after.createdAt, after.id]),
            options.limit + 1,
          )
          .all<RunRow>()
      ).results,
      selected = rows.slice(0, options.limit),
      last = selected.at(-1);
    return {
      items: selected.map(model),
      nextCursor:
        rows.length > options.limit && last
          ? btoa(JSON.stringify({ accountId, createdAt: last.created_at, id: last.id }))
          : null,
      coverage: { complete: true, lastSyncedAt: null, stale: false },
    };
  }
}
