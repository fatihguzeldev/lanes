import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import {
  assertLocalWritable,
  assertProviderWritable,
  localWriteGuard,
  providerWriteGuard,
} from '../../../accounts/server/connections/access';

import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { TemplateScheduleSchema, type TemplateSchedule } from '../../../tasks/contracts/planning';
import {
  accountToday,
  addCalendarDays,
  latestTemplateSlot,
  nextTemplateSlot,
  wallClockInstant,
} from '../../../tasks/model/planning';
import {
  TemplatePageOptionsSchema,
  type TemplatePageOptions,
} from '../../../tasks/contracts/template';
import type { MetadataContext } from '../../../tasks/server/metadata/context';
import {
  CreateTemplateScheduleSchema,
  TemplateReferenceSchema,
  TemplateSchedulePatchSchema,
  TemplateScheduleSummarySchema,
  type TemplateReference,
  type TemplateScheduleSummary,
} from '../../contracts/template';
import type { BoardService } from '../boards/service';
import { TemplateApplicationService } from './runs';
const id = ResourceIdSchema.max(1024),
  revision = z.number().int().nonnegative().safe();
interface ScheduleRow {
  id: string;
  account_id: string;
  template_kind: 'list' | 'board';
  template_id: string;
  template_revision: number;
  board_id: string;
  timing_json: string;
  use_relative_dates: number;
  list_prefix: string;
  state: 'active' | 'paused' | 'deleted';
  pause_reason: string | null;
  revision: number;
  next_run_at: number | null;
  next_attempt_at: number;
  last_claimed_day: string | null;
  last_resolved_day: string | null;
  resume_slot_day: string | null;
  catch_up_required: number;
  active_run_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface TemplateScheduleOptions {
  applications: TemplateApplicationService;
  boards: Pick<BoardService, 'getBoard'>;
  ownerSubjectFor(accountId: string): Promise<string>;
  commitWrites(writes: D1PreparedStatement[]): Promise<unknown>;
  now?: () => number;
}
export interface TemplateScheduleAdvance {
  kind: 'idle' | 'run' | 'claimed' | 'paused' | 'deferred' | 'contended';
  scheduleId?: string;
  runId?: string;
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const value = schema.safeParse(input);
  if (!value.success)
    throw new AppError('validation_failed', 'check the template schedule fields', 422);
  return value.data;
}
function guard(db: D1Database, condition: string, bindings: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
    .bind(...bindings);
}
const reference = (row: ScheduleRow): TemplateReference => ({
  kind: row.template_kind,
  id: row.template_id,
  contentRevision: row.template_revision,
});
function scheduleModel(row: ScheduleRow): TemplateScheduleSummary {
  return TemplateScheduleSummarySchema.parse({
    id: row.id,
    accountId: row.account_id,
    template: reference(row),
    boardId: row.board_id,
    timing: JSON.parse(row.timing_json),
    useRelativeDates: row.use_relative_dates === 1,
    listPrefix: row.list_prefix,
    state: row.state,
    pauseReason: row.pause_reason,
    revision: row.revision,
    nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
    lastClaimedDay: row.last_claimed_day,
    lastResolvedDay: row.last_resolved_day,
    catchUpRequired: row.catch_up_required === 1,
    activeRunId: row.active_run_id,
  });
}
async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
/** Schedule/local-day claims are durable; cron supplies an opportunity, never an exact alarm. */
export class TemplateScheduleService {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: TemplateScheduleOptions,
  ) {
    this.now = options.now ?? Date.now;
  }
  private async row(accountId: string, scheduleId: string): Promise<ScheduleRow> {
    parse(id, accountId);
    parse(id, scheduleId);
    const row = await this.db
      .prepare(
        "SELECT * FROM boards_template_schedules WHERE account_id=? AND id=? AND state<>'deleted'",
      )
      .bind(accountId, scheduleId)
      .first<ScheduleRow>();
    if (!row) throw new AppError('not_found', 'this template schedule is no longer available', 404);
    return row;
  }
  async get(accountId: string, scheduleId: string): Promise<TemplateScheduleSummary> {
    return scheduleModel(await this.row(accountId, scheduleId));
  }
  private timing(row: ScheduleRow): TemplateSchedule {
    return parse(TemplateScheduleSchema, JSON.parse(row.timing_json));
  }
  private today(timing: TemplateSchedule): string {
    return accountToday(timing.zone, new Date(this.now()).toISOString());
  }
  private eligible(timing: TemplateSchedule, after: string | null): string | null {
    return latestTemplateSlot(timing, {
      notAfter: this.today(timing),
      ...(after ? { after } : {}),
    });
  }
  private next(timing: TemplateSchedule, after: string | null, latest = true): number {
    const today = this.today(timing),
      day = latest ? this.eligible(timing, after) : null;
    return Date.parse(
      wallClockInstant(
        day ?? nextTemplateSlot(timing, { after: after && after > today ? after : today }),
        '00:00',
        timing.zone,
      ),
    );
  }
  private async writable(
    accountId: string,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<ScheduleRow> {
    parse(revision, expectedRevision);
    await assertLocalWritable(this.db, accountId);
    const row = await this.row(accountId, scheduleId);
    if (row.revision !== expectedRevision)
      throw new AppError(
        'conflict',
        'this schedule changed; refresh before reapplying the edit',
        409,
      );
    return row;
  }
  private cas(
    accountId: string,
    scheduleId: string,
    expectedRevision: number,
  ): D1PreparedStatement {
    return guard(
      this.db,
      "EXISTS (SELECT 1 FROM boards_template_schedules WHERE account_id=? AND id=? AND revision=? AND state<>'deleted')",
      [accountId, scheduleId, expectedRevision],
    );
  }
  private boardGuard(
    accountId: string,
    boardId: string,
    expectedRevision?: number,
  ): D1PreparedStatement {
    return guard(
      this.db,
      'EXISTS (SELECT 1 FROM boards_boards WHERE account_id=? AND id=? AND (? IS NULL OR revision=?))',
      [accountId, boardId, expectedRevision ?? null, expectedRevision ?? null],
    );
  }
  private async commit(
    writes: D1PreparedStatement[],
    explain: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.options.commitWrites(writes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      await explain();
      throw new AppError(
        'storage_unavailable',
        'the schedule and its operation receipt could not be saved',
        503,
        true,
      );
    }
  }
  async create(
    accountId: string,
    input: unknown,
    context: MetadataContext,
    admittedId: string = crypto.randomUUID(),
  ): Promise<TemplateScheduleSummary> {
    return this.createDefinition(accountId, input, context, admittedId, false);
  }
  /** Archive restoration never exposes a briefly active imported schedule. */
  async createPaused(
    accountId: string,
    input: unknown,
    context: MetadataContext,
    admittedId: string = crypto.randomUUID(),
  ): Promise<TemplateScheduleSummary> {
    return this.createDefinition(accountId, input, context, admittedId, true);
  }
  private async createDefinition(
    accountId: string,
    input: unknown,
    context: MetadataContext,
    admittedId: string,
    importPaused: boolean,
  ): Promise<TemplateScheduleSummary> {
    const value = parse(CreateTemplateScheduleSchema, input);
    parse(id, admittedId);
    await assertLocalWritable(this.db, accountId);
    const source = await this.options.applications.reference(accountId, value.template),
      board = await this.options.boards.getBoard(accountId, value.boardId);
    if (board.revision !== value.boardRevision)
      throw new AppError('conflict', 'the schedule destination changed', 409);
    const account = await this.db
        .prepare('SELECT state FROM accounts_connections WHERE id=?')
        .bind(accountId)
        .first<{
          state: string;
        }>(),
      active = !importPaused && account?.state === 'connected',
      next = active ? this.next(value.timing, null) : null;
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.boardGuard(accountId, board.id, value.boardRevision),
        this.options.applications.referenceGuardWrite(
          accountId,
          value.template,
          source.snapshot.id,
        ),
        this.db
          .prepare(
            'INSERT INTO boards_template_schedules(id,account_id,template_kind,template_id,template_revision,board_id,timing_json,use_relative_dates,list_prefix,state,pause_reason,next_run_at,next_attempt_at,catch_up_required,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            admittedId,
            accountId,
            value.template.kind,
            value.template.id,
            value.template.contentRevision,
            board.id,
            JSON.stringify(value.timing),
            Number(value.useRelativeDates),
            value.listPrefix,
            active ? 'active' : 'paused',
            active ? null : importPaused ? 'imported' : 'reconnect_required',
            next,
            next === null ? this.now() : Math.min(next, this.now()),
            Number(!active),
            Date.parse(context.recordedAt),
            Date.parse(context.recordedAt),
          ),
      ],
      () => assertLocalWritable(this.db, accountId),
    );
    return this.get(accountId, admittedId);
  }
  async update(
    accountId: string,
    scheduleId: string,
    input: unknown,
    expectedRevision: number,
    context: MetadataContext,
  ): Promise<TemplateScheduleSummary> {
    const value = parse(TemplateSchedulePatchSchema, input),
      row = await this.writable(accountId, scheduleId, expectedRevision);
    if (value.boardId !== undefined && value.boardRevision === undefined)
      throw new AppError('validation_failed', 'choose the destination board revision', 422);
    const target = value.boardId ?? row.board_id,
      board = await this.options.boards.getBoard(accountId, target);
    if (value.boardRevision !== undefined && board.revision !== value.boardRevision)
      throw new AppError('conflict', 'the destination board changed', 409);
    const template = value.template ?? reference(row),
      source = await this.options.applications.reference(accountId, template),
      timing = value.timing ?? this.timing(row),
      next =
        row.state === 'active' && !row.active_run_id
          ? this.next(timing, row.last_resolved_day)
          : null;
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, scheduleId, expectedRevision),
        this.boardGuard(accountId, target, value.boardRevision),
        this.options.applications.referenceGuardWrite(accountId, template, source.snapshot.id),
        this.db
          .prepare(
            'UPDATE boards_template_schedules SET template_kind=?,template_id=?,template_revision=?,board_id=?,timing_json=?,use_relative_dates=?,list_prefix=?,resume_slot_day=NULL,next_run_at=?,next_attempt_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(
            template.kind,
            template.id,
            template.contentRevision,
            target,
            JSON.stringify(timing),
            value.useRelativeDates === undefined
              ? row.use_relative_dates
              : Number(value.useRelativeDates),
            value.listPrefix ?? row.list_prefix,
            next,
            next === null ? this.now() : Math.min(next, this.now()),
            Date.parse(context.recordedAt),
            accountId,
            scheduleId,
          ),
      ],
      () => this.writable(accountId, scheduleId, expectedRevision),
    );
    return this.get(accountId, scheduleId);
  }
  async pause(
    accountId: string,
    scheduleId: string,
    expectedRevision: number,
    context: MetadataContext,
  ): Promise<TemplateScheduleSummary> {
    await this.writable(accountId, scheduleId, expectedRevision);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, scheduleId, expectedRevision),
        this.db
          .prepare(
            "UPDATE boards_template_schedules SET state='paused',pause_reason='owner',catch_up_required=1,next_run_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND id=?",
          )
          .bind(Date.parse(context.recordedAt), accountId, scheduleId),
      ],
      () => this.writable(accountId, scheduleId, expectedRevision),
    );
    return this.get(accountId, scheduleId);
  }
  async resume(
    accountId: string,
    scheduleId: string,
    expectedRevision: number,
    catchUp: 'latest' | 'skip',
    context: MetadataContext,
  ): Promise<TemplateScheduleSummary> {
    parse(z.enum(['latest', 'skip']), catchUp);
    await assertProviderWritable(this.db, accountId);
    const row = await this.writable(accountId, scheduleId, expectedRevision);
    if (row.active_run_id) {
      const run = await this.options.applications.get(accountId, row.active_run_id);
      if (!['succeeded', 'cancelled'].includes(run.state))
        throw new AppError(
          'conflict',
          'resolve the captured run before changing future checklist slots',
          409,
          false,
          { activeRunId: run.id },
        );
    }
    const template = reference(row),
      source = await this.options.applications.reference(accountId, template),
      board = await this.options.boards.getBoard(accountId, row.board_id),
      timing = this.timing(row),
      latest = this.eligible(timing, row.last_resolved_day);
    const skippedThrough =
      catchUp === 'skip'
        ? latest
        : latest
          ? latestTemplateSlot(timing, {
              notAfter: addCalendarDays(latest, -1),
              ...(row.last_resolved_day ? { after: row.last_resolved_day } : {}),
            })
          : null;
    const resolved = skippedThrough ?? row.last_resolved_day,
      next =
        catchUp === 'latest' && latest
          ? Date.parse(wallClockInstant(latest, '00:00', timing.zone))
          : this.next(timing, resolved, false);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        providerWriteGuard(this.db, accountId),
        this.cas(accountId, scheduleId, expectedRevision),
        this.boardGuard(accountId, board.id),
        this.options.applications.referenceGuardWrite(accountId, template, source.snapshot.id),
        ...(skippedThrough
          ? [
              this.db
                .prepare(
                  'INSERT OR IGNORE INTO boards_template_skips(schedule_id,after_day,through_day,reason,recorded_at) VALUES (?,?,?,?,?)',
                )
                .bind(
                  scheduleId,
                  row.last_resolved_day ?? addCalendarDays(timing.startsOn, -1),
                  skippedThrough,
                  catchUp === 'skip' ? 'owner_skip' : 'older_catch_up_slots',
                  Date.parse(context.recordedAt),
                ),
            ]
          : []),
        this.db
          .prepare(
            "UPDATE boards_template_schedules SET state='active',pause_reason=NULL,catch_up_required=0,active_run_id=NULL,last_resolved_day=?,resume_slot_day=?,next_run_at=?,next_attempt_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=?",
          )
          .bind(
            resolved,
            catchUp === 'latest' ? latest : null,
            next,
            Math.min(next, this.now()),
            Date.parse(context.recordedAt),
            accountId,
            scheduleId,
          ),
      ],
      () => this.writable(accountId, scheduleId, expectedRevision),
    );
    return this.get(accountId, scheduleId);
  }
  async delete(
    accountId: string,
    scheduleId: string,
    expectedRevision: number,
    context: MetadataContext,
  ): Promise<void> {
    await this.writable(accountId, scheduleId, expectedRevision);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, scheduleId, expectedRevision),
        this.db
          .prepare(
            "UPDATE boards_template_schedules SET state='deleted',pause_reason='owner_deleted',next_run_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND id=?",
          )
          .bind(Date.parse(context.recordedAt), accountId, scheduleId),
      ],
      () => this.writable(accountId, scheduleId, expectedRevision),
    );
  }
  pauseBoardWrites(accountId: string, boardId: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          "UPDATE boards_template_schedules SET state='paused',pause_reason='destination_deleted',catch_up_required=1,next_run_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND board_id=? AND state<>'deleted'",
        )
        .bind(this.now(), accountId, boardId),
      this.db
        .prepare(
          "UPDATE boards_template_runs SET state='paused',error_code='destination_deleted',updated_at=? WHERE account_id=? AND json_extract(captured_json,'$.destinationBoardId')=? AND state IN ('capturing','running','partial')",
        )
        .bind(this.now(), accountId, boardId),
    ];
  }
  pauseTemplateWrites(
    accountId: string,
    kind: 'list' | 'board',
    templateId: string,
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          "UPDATE boards_template_schedules SET state='paused',pause_reason='template_deleted',catch_up_required=1,next_run_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND template_kind=? AND template_id=? AND state<>'deleted'",
        )
        .bind(this.now(), accountId, kind, templateId),
    ];
  }
  async advanceOne(): Promise<TemplateScheduleAdvance> {
    // Continue admitted work before considering another scheduled slot.
    const run = await this.db
      .prepare(
        "SELECT id,account_id,schedule_id FROM boards_template_runs WHERE state IN ('capturing','running','partial') AND next_attempt_at<=? ORDER BY next_attempt_at,work_order,id LIMIT 1",
      )
      .bind(this.now())
      .first<{
        id: string;
        account_id: string;
        schedule_id: string | null;
      }>();
    if (run) {
      const advanced = await this.options.applications.advance(run.account_id, run.id);
      if (run.schedule_id && advanced.state === 'paused')
        await this.db
          .prepare(
            "UPDATE boards_template_schedules SET state='paused',pause_reason=?,catch_up_required=1,next_run_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND state='active'",
          )
          .bind(advanced.errorCode ?? 'run_paused', this.now(), run.schedule_id)
          .run();
      return {
        kind: 'run',
        runId: advanced.id,
        ...(run.schedule_id ? { scheduleId: run.schedule_id } : {}),
      };
    }
    // Terminal runs release their schedule without changing a paused/deleted definition.
    const settled = await this.db
      .prepare(
        "SELECT schedule.* FROM boards_template_schedules schedule JOIN boards_template_runs run ON run.id=schedule.active_run_id WHERE run.state IN ('succeeded','cancelled') ORDER BY schedule.updated_at,schedule.id LIMIT 1",
      )
      .first<ScheduleRow>();
    if (settled) {
      const next =
        settled.state === 'active'
          ? this.next(this.timing(settled), settled.last_resolved_day)
          : null;
      await this.db
        .prepare(
          'UPDATE boards_template_schedules SET active_run_id=NULL,next_run_at=?,next_attempt_at=?,updated_at=? WHERE id=? AND active_run_id=?',
        )
        .bind(
          next,
          next === null ? this.now() : Math.min(next, this.now()),
          this.now(),
          settled.id,
          settled.active_run_id,
        )
        .run();
      return { kind: 'deferred', scheduleId: settled.id };
    }
    const row = await this.db
      .prepare(
        "SELECT * FROM boards_template_schedules WHERE state='active' AND active_run_id IS NULL AND next_run_at<=? AND next_attempt_at<=? ORDER BY next_attempt_at,next_run_at,id LIMIT 1",
      )
      .bind(this.now(), this.now())
      .first<ScheduleRow>();
    if (!row) return { kind: 'idle' };
    const account = await this.db
      .prepare('SELECT state FROM accounts_connections WHERE id=?')
      .bind(row.account_id)
      .first<{
        state: string;
      }>();
    if (
      !account ||
      ['reconnect_required', 'disconnecting', 'disconnected'].includes(account.state)
    ) {
      await this.db
        .prepare(
          "UPDATE boards_template_schedules SET state='paused',pause_reason='reconnect_required',catch_up_required=1,next_run_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND state='active'",
        )
        .bind(this.now(), row.id)
        .run();
      return { kind: 'paused', scheduleId: row.id };
    }
    if (account.state !== 'connected') {
      await this.db
        .prepare('UPDATE boards_template_schedules SET next_attempt_at=? WHERE id=?')
        .bind(this.now() + 15 * 60000, row.id)
        .run();
      return { kind: 'deferred', scheduleId: row.id };
    }
    const timing = this.timing(row),
      slot = row.resume_slot_day ?? this.eligible(timing, row.last_resolved_day);
    if (!slot) {
      const next = this.next(timing, row.last_resolved_day, false);
      await this.db
        .prepare('UPDATE boards_template_schedules SET next_run_at=?,next_attempt_at=? WHERE id=?')
        .bind(next, next, row.id)
        .run();
      return { kind: 'deferred', scheduleId: row.id };
    }
    const runId = 'scheduled-' + (await digest(JSON.stringify([row.id, slot]))).slice(0, 32),
      operationId = `${this.now()}:${(await digest(runId)).slice(0, 32)}`;
    const older = latestTemplateSlot(timing, {
      notAfter: addCalendarDays(slot, -1),
      ...(row.last_resolved_day ? { after: row.last_resolved_day } : {}),
    });
    try {
      const board = await this.options.boards.getBoard(row.account_id, row.board_id);
      const result = await this.options.applications.begin(
        row.account_id,
        {
          template: reference(row),
          destination: { kind: 'existing', boardId: board.id, boardRevision: board.revision },
          applicationDay: slot,
          useRelativeDates: row.use_relative_dates === 1,
          listPrefix: row.list_prefix,
          confirmed: true,
        },
        {
          operationId,
          ownerSubject: await this.options.ownerSubjectFor(row.account_id),
          origin: 'scheduled',
          scheduleId: row.id,
          runId,
          skippedBefore: older,
          admissionWrites: [
            providerWriteGuard(this.db, row.account_id),
            guard(
              this.db,
              "EXISTS (SELECT 1 FROM boards_template_schedules WHERE id=? AND account_id=? AND revision=? AND state='active' AND active_run_id IS NULL AND last_resolved_day IS ?)",
              [row.id, row.account_id, row.revision, row.last_resolved_day],
            ),
            ...(older
              ? [
                  this.db
                    .prepare(
                      "INSERT OR IGNORE INTO boards_template_skips(schedule_id,after_day,through_day,reason,recorded_at) VALUES (?,?,?,'older_missed_slots',?)",
                    )
                    .bind(
                      row.id,
                      row.last_resolved_day ?? addCalendarDays(timing.startsOn, -1),
                      older,
                      this.now(),
                    ),
                ]
              : []),
            this.db
              .prepare(
                'UPDATE boards_template_schedules SET last_claimed_day=?,last_resolved_day=?,resume_slot_day=NULL,active_run_id=?,next_run_at=NULL,updated_at=? WHERE id=?',
              )
              .bind(slot, slot, runId, this.now(), row.id),
          ],
        },
      );
      return { kind: 'claimed', scheduleId: row.id, runId: result.id };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const current = await this.row(row.account_id, row.id);
      if (current.active_run_id && current.active_run_id !== runId)
        return { kind: 'contended', scheduleId: row.id };
      if (current.revision !== row.revision) return { kind: 'contended', scheduleId: row.id };
      if (error.code === 'conflict' && current.active_run_id) {
        const claimed = await this.options.applications.get(row.account_id, current.active_run_id);
        if (claimed.operationId !== operationId) return { kind: 'contended', scheduleId: row.id };
      }
      await this.db
        .prepare(
          "UPDATE boards_template_schedules SET state='paused',pause_reason=?,catch_up_required=1,next_run_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND id=?",
        )
        .bind(error.code, this.now(), row.account_id, row.id)
        .run();
      return {
        kind: 'paused',
        scheduleId: row.id,
        ...(current.active_run_id ? { runId: current.active_run_id } : {}),
      };
    }
  }
  async list(
    accountId: string,
    input: TemplatePageOptions = {},
  ): Promise<Page<TemplateScheduleSummary>> {
    parse(id, accountId);
    const options = parse(TemplatePageOptionsSchema, input);
    let after = '';
    if (options.cursor) {
      try {
        const cursor = z
          .object({ accountId: id, id })
          .strict()
          .parse(JSON.parse(atob(options.cursor)));
        if (cursor.accountId !== accountId) throw new Error();
        after = cursor.id;
      } catch {
        throw new AppError(
          'validation_failed',
          'this schedule page belongs to another account',
          422,
        );
      }
    }
    const rows = (
        await this.db
          .prepare(
            "SELECT * FROM boards_template_schedules WHERE account_id=? AND state<>'deleted' AND id>? ORDER BY id LIMIT ?",
          )
          .bind(accountId, after, options.limit + 1)
          .all<ScheduleRow>()
      ).results,
      selected = rows.slice(0, options.limit),
      last = selected.at(-1);
    return {
      items: selected.map(scheduleModel),
      nextCursor:
        rows.length > options.limit && last
          ? btoa(JSON.stringify({ accountId, id: last.id }))
          : null,
      coverage: { complete: true, lastSyncedAt: null, stale: false },
    };
  }
}
