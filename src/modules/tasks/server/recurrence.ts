import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import { assertProviderWritable, providerWriteGuard } from '../../accounts/access';
import { ResourceIdSchema } from '../contracts';
import { RepeatRuleSchema, type RepeatRule } from '../planning-contract';
import { accountToday, nextOccurrence } from '../planning';
import {
  ReopenRequestSchema,
  type RecurrenceStatus,
  type ReopenPreview,
  type ReopenRequest,
  type RecurrenceAdvance,
} from '../recurrence-contract';
export type { RecurrenceAdvance } from '../recurrence-contract';
import { copyTaskId, type TaskCommandService, type CopyEntry } from './commands/provider-commands';
import type { OperationStore, OperationRecord } from './operations';
import type { TaskRecurrenceSnapshot } from './projection';
export interface RecurrenceOptions {
  commands: TaskCommandService;
  operations: OperationStore;
  ownerSubjectFor(accountId: string): Promise<string>;
  requestTaskCheck?(accountId: string, taskId: string): Promise<void>;
  now?: () => number;
  id?: () => string;
}
interface TaskRow {
  id: string;
  account_id: string;
  list_id: string;
  parent_id: string | null;
  title: string;
  completed: number;
  repeat_rule_json: string | null;
  scheduled_day: string | null;
  series_id: string | null;
  occurrence_id: string | null;
  revision: number;
  provider_etag: string | null;
  provider_missing_at: number | null;
  deleted_at: number | null;
}
interface Transition {
  id: string;
  account_id: string;
  task_id: string;
  kind: 'completed' | 'reopened';
  snapshot_json: string;
  children_complete: number;
}
interface Series {
  id: string;
  account_id: string;
  active_task_id: string;
  state: RecurrenceStatus['state'];
  created_count: number;
  revision: number;
}
interface Occurrence {
  id: string;
  account_id: string;
  series_id: string;
  predecessor_occurrence_id: string;
  source_task_id: string;
  transition_id: string;
  state: string;
  phase: string;
  rule_json: string;
  scheduled_day: string | null;
  target_task_id: string | null;
  operation_id: string;
  owner_subject: string;
  list_id: string;
  list_revision: number;
  total_tasks: number;
  append_position: number;
  baseline_cursor: string | null;
  copy_confirmed_at: number | null;
  parent_counted: number;
  plan_captured: number;
  source_revision: number;
  attempt: number;
  checklist_complete: number;
  next_at: number | null;
  claim_id: string | null;
  claim_until: number | null;
  error_code: string | null;
  undo_choice: 'cancel_pending' | 'remove_untouched' | 'one_off' | null;
  undo_operation_id: string | null;
  undo_task_revision: number | null;
  verify_position: number;
  verify_requested_at: number | null;
}
interface CopyRow {
  item_key: string;
  source_task_id: string;
  position: number;
  parent_key: string | null;
  snapshot_json: string;
}
const idle: RecurrenceAdvance = {
  accountId: null,
  taskId: null,
  advanced: false,
  pending: false,
  state: 'idle',
};
const leaseMs = 45_000;
function identity(value: string): void {
  if (!ResourceIdSchema.max(1_024).safeParse(value).success)
    throw new AppError('validation_failed', 'provide an explicit account and task identity', 422);
}
async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function parseRule(value: string): RepeatRule {
  try {
    const result = RepeatRuleSchema.safeParse(JSON.parse(value));
    if (result.success) return result.data;
  } catch {
    /* A corrupt retained rule must not become a fresh provider request. */
  }
  throw new AppError(
    'validation_failed',
    'the retained repeat rule needs attention before a successor can be created',
    422,
  );
}
export class RecurrenceService {
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(
    private readonly db: D1Database,
    private readonly options: RecurrenceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
  }
  private async task(accountId: string, taskId: string): Promise<TaskRow | null> {
    return this.db
      .prepare(
        'SELECT id,account_id,list_id,parent_id,title,completed,repeat_rule_json,scheduled_day,series_id,occurrence_id,revision,provider_etag,provider_missing_at,deleted_at FROM tasks_tasks WHERE account_id=? AND id=?',
      )
      .bind(accountId, taskId)
      .first<TaskRow>();
  }
  private async series(accountId: string, id: string): Promise<Series | null> {
    return this.db
      .prepare(
        'SELECT id,account_id,active_task_id,state,created_count,revision FROM tasks_recurrence_series WHERE account_id=? AND id=?',
      )
      .bind(accountId, id)
      .first<Series>();
  }
  private async occurrence(accountId: string, taskId: string): Promise<Occurrence | null> {
    return this.db
      .prepare(
        "SELECT * FROM tasks_recurrence_occurrences WHERE account_id=? AND source_task_id=? ORDER BY CASE WHEN state IN ('cancelled','stopped','finished') THEN 1 ELSE 0 END,attempt DESC,created_at DESC,id DESC LIMIT 1",
      )
      .bind(accountId, taskId)
      .first<Occurrence>();
  }
  private guard(occurrence: Occurrence): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_recurrence_occurrences WHERE id=? AND account_id=? AND claim_id=? AND claim_until>?)',
      )
      .bind(occurrence.id, occurrence.account_id, occurrence.claim_id, this.now());
  }
  private async commit(occurrence: Occurrence, writes: D1PreparedStatement[]): Promise<void> {
    try {
      await this.db.batch([this.guard(occurrence), ...writes]);
    } catch {
      throw new AppError(
        'conflict',
        'this recurrence slice no longer owns its captured state',
        409,
        true,
      );
    }
  }
  private resolvedTransitionWrites(id: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='resolved',snapshot_json='{}' WHERE id=?",
        )
        .bind(id),
      this.db
        .prepare('DELETE FROM tasks_recurrence_transition_children WHERE transition_id=?')
        .bind(id),
    ];
  }
  async advanceNext(): Promise<RecurrenceAdvance> {
    return this.advanceSelection();
  }
  async advance(accountId: string, taskId?: string): Promise<RecurrenceAdvance> {
    identity(accountId);
    if (taskId) identity(taskId);
    return this.advanceSelection(accountId, taskId);
  }
  private async advanceSelection(accountId?: string, taskId?: string): Promise<RecurrenceAdvance> {
    const scoped = accountId ? ' AND account_id=?' : '';
    const bindings = accountId ? [accountId] : [];
    const due = await this.db
      .prepare(
        `SELECT id FROM tasks_recurrence_occurrences WHERE next_at IS NOT NULL AND next_at<=? AND (claim_until IS NULL OR claim_until<=?)${scoped}${taskId ? ' AND source_task_id=?' : ''} ORDER BY fairness_order,id LIMIT 1`,
      )
      .bind(this.now(), this.now(), ...bindings, ...(taskId ? [taskId] : []))
      .first<{ id: string }>();
    const transition = await this.db
      .prepare(
        `SELECT tr.id,tr.account_id,tr.task_id,tr.kind,tr.snapshot_json,tr.children_complete FROM tasks_recurrence_transitions tr
      LEFT JOIN tasks_tasks t ON t.account_id=tr.account_id AND t.id=tr.task_id LEFT JOIN tasks_recurrence_series s ON s.account_id=t.account_id AND s.id=t.series_id
      WHERE tr.state='pending'${accountId ? ' AND tr.account_id=?' : ''}${taskId ? ' AND tr.task_id=?' : ''}
        AND (tr.kind='reopened' OR s.id IS NULL OR s.state IN ('active','finished','stopped') OR s.active_task_id<>t.id)
      ORDER BY tr.observed_at,tr.id LIMIT 1`,
      )
      .bind(...bindings, ...(taskId ? [taskId] : []))
      .first<Transition>();
    const watch =
      this.options.requestTaskCheck && !taskId
        ? await this.db
            .prepare(
              `SELECT w.account_id,w.task_id FROM tasks_recurrence_watches w JOIN tasks_tasks t ON t.account_id=w.account_id AND t.id=w.task_id LEFT JOIN tasks_recurrence_series s ON s.account_id=t.account_id AND s.id=t.series_id
      WHERE w.next_at<=?${accountId ? ' AND w.account_id=?' : ''} AND (s.id IS NULL OR (s.active_task_id=t.id AND s.state='active'))
        AND NOT EXISTS(SELECT 1 FROM tasks_command_resources r JOIN tasks_operations operation ON operation.id=r.operation_id WHERE operation.account_id=w.account_id AND r.list_id=t.list_id AND operation.state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain'))
      ORDER BY w.next_at,w.account_id,w.task_id LIMIT 1`,
            )
            .bind(this.now(), ...bindings)
            .first<{ account_id: string; task_id: string }>()
        : null;
    const scheduler = await this.db
      .prepare('SELECT last_kind FROM tasks_recurrence_fairness WHERE singleton=1')
      .first<{ last_kind: 'work' | 'transition' | 'watch' }>();
    const rotation =
      scheduler?.last_kind === 'work'
        ? ['transition', 'watch', 'work']
        : scheduler?.last_kind === 'watch'
          ? ['work', 'transition', 'watch']
          : ['watch', 'work', 'transition'];
    const selected = rotation.find((kind) =>
      kind === 'work' ? due : kind === 'transition' ? transition : watch,
    );
    if (selected)
      await this.db
        .prepare('UPDATE tasks_recurrence_fairness SET last_kind=? WHERE singleton=1')
        .bind(selected)
        .run();
    if (selected === 'work' && due) return this.advanceOccurrence(due.id);
    if (selected === 'transition' && transition) return this.ingest(transition);
    if (selected === 'watch' && watch) {
      const claimed = await this.db
        .prepare(
          'UPDATE tasks_recurrence_watches SET next_at=? WHERE account_id=? AND task_id=? AND next_at<=? RETURNING task_id',
        )
        .bind(this.now() + 60_000, watch.account_id, watch.task_id, this.now())
        .first();
      if (claimed) {
        await this.options.requestTaskCheck!(watch.account_id, watch.task_id);
        return {
          accountId: watch.account_id,
          taskId: watch.task_id,
          advanced: true,
          pending: false,
          state: 'active',
        };
      }
    }
    return idle;
  }
  private async ingest(transition: Transition): Promise<RecurrenceAdvance> {
    const task = await this.task(transition.account_id, transition.task_id);
    const existing = await this.occurrence(transition.account_id, transition.task_id);
    if (transition.kind === 'reopened') return this.observeReopen(transition, task, existing);
    if (existing && existing.state !== 'cancelled') {
      await this.db.batch(this.resolvedTransitionWrites(transition.id));
      return {
        accountId: transition.account_id,
        taskId: transition.task_id,
        advanced: true,
        pending: existing.next_at !== null,
        state: (await this.series(transition.account_id, existing.series_id))?.state ?? 'paused',
      };
    }
    if (
      !task ||
      task.deleted_at !== null ||
      task.parent_id !== null ||
      !task.completed ||
      !task.repeat_rule_json ||
      !task.scheduled_day ||
      task.provider_missing_at !== null
    ) {
      await this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE id=? AND state='pending'",
        )
        .bind(transition.id)
        .run();
      if (task?.series_id)
        await this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='stopped',revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND active_task_id=?",
          )
          .bind(this.now(), task.account_id, task.series_id, task.id)
          .run();
      return {
        ...idle,
        accountId: transition.account_id,
        taskId: transition.task_id,
        advanced: true,
        state: 'stopped',
      };
    }
    const rule = parseRule(task.repeat_rule_json);
    const seriesId =
      task.series_id ?? 'series:' + (await hash(JSON.stringify([task.account_id, task.id])));
    const series = await this.series(task.account_id, seriesId);
    if (series && series.active_task_id !== task.id) {
      await this.db
        .prepare("UPDATE tasks_recurrence_transitions SET state='resolved' WHERE id=?")
        .bind(transition.id)
        .run();
      return {
        ...idle,
        accountId: task.account_id,
        taskId: task.id,
        advanced: true,
        state: series.state,
      };
    }
    const predecessor =
      task.occurrence_id ?? 'occurrence:' + (await hash(JSON.stringify([seriesId, task.id])));
    const attempt = existing ? existing.attempt + 1 : 1;
    const id =
      'successor:' +
      (await hash(JSON.stringify([task.account_id, seriesId, predecessor, attempt])));
    const operationId = this.now() + ':' + (await hash(`${id}:copy:${attempt}`)).slice(0, 48);
    const owner = await this.options.ownerSubjectFor(task.account_id);
    const day = nextOccurrence(rule, {
      after: task.scheduled_day,
      notBefore: accountToday(rule.zone, new Date(this.now()).toISOString()),
      createdCount: series?.created_count ?? 1,
    });
    const children = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM tasks_recurrence_transition_children WHERE transition_id=?',
      )
      .bind(transition.id)
      .first<{ n: number }>();
    if ((children?.n ?? 0) > 2_000)
      throw new AppError('validation_failed', 'the retained checklist exceeds 2,000 subtasks', 422);
    const list = await this.db
      .prepare(
        'SELECT revision FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL',
      )
      .bind(task.account_id, task.list_id)
      .first<{ revision: number }>();
    if (!list)
      throw new AppError('not_found', 'the recurring task list is no longer available', 404);
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_recurrence_transitions WHERE id=? AND state='pending') OR NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL)",
          )
          .bind(transition.id, task.account_id, task.id, task.revision),
        this.db
          .prepare(
            'INSERT INTO tasks_recurrence_series(id,account_id,active_task_id,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
          )
          .bind(seriesId, task.account_id, task.id, this.now(), this.now()),
        this.db
          .prepare('UPDATE tasks_tasks SET series_id=?,occurrence_id=? WHERE account_id=? AND id=?')
          .bind(seriesId, predecessor, task.account_id, task.id),
        this.db.prepare('UPDATE tasks_recurrence_fairness SET turn=turn+1 WHERE singleton=1'),
        this.db
          .prepare(
            `INSERT INTO tasks_recurrence_occurrences(id,account_id,series_id,predecessor_occurrence_id,source_task_id,transition_id,state,phase,rule_json,scheduled_day,operation_id,owner_subject,list_id,list_revision,total_tasks,checklist_complete,next_at,fairness_order,source_revision,attempt,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,turn,?,?,?,? FROM tasks_recurrence_fairness WHERE singleton=1`,
          )
          .bind(
            id,
            task.account_id,
            seriesId,
            predecessor,
            task.id,
            transition.id,
            day ? 'capturing' : 'finished',
            day ? 'begin' : 'ready',
            JSON.stringify(rule),
            day,
            operationId,
            owner,
            task.list_id,
            list.revision,
            (children?.n ?? 0) + 1,
            transition.children_complete,
            day ? this.now() : null,
            task.revision,
            attempt,
            this.now(),
            this.now(),
          ),
        this.db
          .prepare(
            `INSERT INTO tasks_recurrence_copy_items(occurrence_id,source_task_id,item_key,position,parent_key,snapshot_json) SELECT ?,task_id,'i0',0,NULL,snapshot_json FROM tasks_recurrence_transitions WHERE id=?`,
          )
          .bind(id, transition.id),
        this.db
          .prepare(
            `INSERT INTO tasks_recurrence_copy_items(occurrence_id,source_task_id,item_key,position,parent_key,snapshot_json)
        SELECT ?,task_id,'i'||ROW_NUMBER() OVER(ORDER BY COALESCE(json_extract(snapshot_json,'$.provider_position'),''),task_id),ROW_NUMBER() OVER(ORDER BY COALESCE(json_extract(snapshot_json,'$.provider_position'),''),task_id),'i0',snapshot_json FROM tasks_recurrence_transition_children WHERE transition_id=?`,
          )
          .bind(id, transition.id),
        this.db
          .prepare('UPDATE tasks_recurrence_transitions SET state=? WHERE id=?')
          .bind(day ? 'admitted' : 'resolved', transition.id),
        this.db
          .prepare(
            'UPDATE tasks_recurrence_series SET state=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .bind(day ? 'pending' : 'finished', this.now(), seriesId),
        ...(!day
          ? [
              this.db
                .prepare(
                  "UPDATE tasks_recurrence_copy_items SET snapshot_json='{}' WHERE occurrence_id=?",
                )
                .bind(id),
              ...this.resolvedTransitionWrites(transition.id),
            ]
          : []),
      ]);
    } catch {
      const concurrent = await this.occurrence(task.account_id, task.id);
      if (!concurrent)
        throw new AppError(
          'storage_unavailable',
          'the recurrence intent could not be recorded; its completion remains pending',
          503,
          true,
        );
      return { ...idle, accountId: task.account_id, taskId: task.id };
    }
    return {
      accountId: task.account_id,
      taskId: task.id,
      advanced: true,
      pending: day !== null,
      state: day ? 'pending' : 'finished',
    };
  }
  private async advanceOccurrence(id: string): Promise<RecurrenceAdvance> {
    const claimId = this.id();
    const occurrence = await this.db
      .prepare(
        'UPDATE tasks_recurrence_occurrences SET claim_id=?,claim_until=? WHERE id=? AND next_at<=? AND (claim_until IS NULL OR claim_until<=?) RETURNING *',
      )
      .bind(claimId, this.now() + leaseMs, id, this.now(), this.now())
      .first<Occurrence>();
    if (!occurrence) return idle;
    try {
      const series = await this.series(occurrence.account_id, occurrence.series_id);
      const active = series ? await this.task(occurrence.account_id, series.active_task_id) : null;
      if (
        !occurrence.phase.startsWith('undo_') &&
        (!active || active.deleted_at !== null || active.repeat_rule_json === null)
      )
        await this.stop(occurrence);
      else if (occurrence.phase.startsWith('undo_')) await this.undoSlice(occurrence);
      else if (occurrence.phase === 'begin') await this.begin(occurrence);
      else if (occurrence.phase === 'append') await this.append(occurrence);
      else if (occurrence.phase === 'seal') {
        const sealed = await this.options.commands.sealCapturedCopy(
          occurrence.operation_id,
          occurrence.account_id,
        );
        if (sealed.captureSealed)
          await this.commit(occurrence, [
            this.db
              .prepare(
                "UPDATE tasks_recurrence_occurrences SET phase='copy',state='copying' WHERE id=?",
              )
              .bind(id),
          ]);
      } else if (occurrence.phase === 'copy') await this.copySlice(occurrence);
      else if (occurrence.phase === 'baselines') await this.baselineSlice(occurrence);
      await this.commit(occurrence, [
        this.db.prepare('UPDATE tasks_recurrence_fairness SET turn=turn+1 WHERE singleton=1'),
        this.db
          .prepare(
            'UPDATE tasks_recurrence_occurrences SET claim_id=NULL,claim_until=NULL,fairness_order=(SELECT turn FROM tasks_recurrence_fairness WHERE singleton=1),updated_at=? WHERE id=?',
          )
          .bind(this.now(), id),
      ]);
    } catch (error) {
      const currentClaim = await this.db
        .prepare('SELECT claim_id,claim_until FROM tasks_recurrence_occurrences WHERE id=?')
        .bind(id)
        .first<{ claim_id: string | null; claim_until: number | null }>();
      if (currentClaim?.claim_id !== claimId || (currentClaim.claim_until ?? 0) <= this.now())
        return {
          ...idle,
          accountId: occurrence.account_id,
          taskId: occurrence.source_task_id,
          pending: true,
        };
      const code = error instanceof AppError ? error.code : 'storage_unavailable';
      await this.commit(occurrence, [
        this.db
          .prepare(
            "UPDATE tasks_recurrence_occurrences SET state='paused',error_code=?,next_at=NULL,claim_id=NULL,claim_until=NULL,updated_at=? WHERE id=?",
          )
          .bind(code, this.now(), id),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='paused',revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(this.now(), occurrence.series_id),
      ]);
    }
    const current = await this.db
      .prepare('SELECT next_at FROM tasks_recurrence_occurrences WHERE id=?')
      .bind(id)
      .first<{ next_at: number | null }>();
    const series = await this.series(occurrence.account_id, occurrence.series_id);
    return {
      accountId: occurrence.account_id,
      taskId: occurrence.source_task_id,
      advanced: true,
      pending: current?.next_at !== null,
      state: series?.state ?? 'paused',
    };
  }
  private async begin(occurrence: Occurrence): Promise<void> {
    const task = await this.task(occurrence.account_id, occurrence.source_task_id);
    const series = await this.series(occurrence.account_id, occurrence.series_id);
    if (
      !occurrence.plan_captured &&
      (!task ||
        task.deleted_at !== null ||
        !task.repeat_rule_json ||
        !task.scheduled_day ||
        !task.completed)
    ) {
      await this.stop(occurrence);
      return;
    }
    const rule = parseRule(
      occurrence.plan_captured ? occurrence.rule_json : task!.repeat_rule_json!,
    );
    const day = occurrence.plan_captured
      ? occurrence.scheduled_day
      : nextOccurrence(rule, {
          after: task!.scheduled_day!,
          notBefore: accountToday(rule.zone, new Date(this.now()).toISOString()),
          createdCount: series?.created_count ?? 1,
        });
    if (!day) {
      await this.commit(occurrence, [
        this.db
          .prepare(
            "UPDATE tasks_recurrence_occurrences SET state='finished',phase='ready',next_at=NULL WHERE id=?",
          )
          .bind(occurrence.id),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='finished',revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(this.now(), occurrence.series_id),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_copy_items SET snapshot_json='{}' WHERE occurrence_id=?",
          )
          .bind(occurrence.id),
        ...this.resolvedTransitionWrites(occurrence.transition_id),
      ]);
      return;
    }
    const listId = occurrence.plan_captured ? occurrence.list_id : task!.list_id;
    const list = await this.db
      .prepare(
        'SELECT revision FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL',
      )
      .bind(occurrence.account_id, listId)
      .first<{ revision: number }>();
    if (!list) {
      await this.stop(occurrence);
      return;
    }
    const revision = occurrence.plan_captured ? occurrence.list_revision : list.revision;
    await this.options.commands.beginCapturedCopy({
      operationId: occurrence.operation_id,
      accountId: occurrence.account_id,
      ownerSubject: occurrence.owner_subject,
      source: 'repetition',
      origin: 'scheduled',
      listId,
      listRevision: revision,
      totalTasks: occurrence.total_tasks,
      requestKey: `${occurrence.series_id}:${occurrence.predecessor_occurrence_id}:${occurrence.attempt}`,
      previousTaskId: occurrence.source_task_id,
      scheduleId: occurrence.series_id,
      runId: occurrence.id,
      guardWrites: [
        this.guard(occurrence),
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND completed=1 AND deleted_at IS NULL)',
          )
          .bind(
            occurrence.account_id,
            occurrence.source_task_id,
            task?.revision ?? occurrence.source_revision,
          ),
        this.db
          .prepare(
            'UPDATE tasks_recurrence_occurrences SET plan_captured=1,rule_json=?,scheduled_day=?,list_id=?,list_revision=?,source_revision=? WHERE id=?',
          )
          .bind(
            JSON.stringify(rule),
            day,
            listId,
            revision,
            task?.revision ?? occurrence.source_revision,
            occurrence.id,
          ),
      ],
    });
    await this.commit(occurrence, [
      this.db
        .prepare("UPDATE tasks_recurrence_occurrences SET phase='append' WHERE id=?")
        .bind(occurrence.id),
    ]);
  }
  private async append(occurrence: Occurrence): Promise<void> {
    const candidates = (
      await this.db
        .prepare(
          'SELECT item_key,position,length(CAST(snapshot_json AS BLOB)) AS bytes FROM tasks_recurrence_copy_items WHERE occurrence_id=? AND position>=? ORDER BY position LIMIT 10',
        )
        .bind(occurrence.id, occurrence.append_position)
        .all<{ item_key: string; position: number; bytes: number }>()
    ).results;
    const selected: string[] = [];
    let bytes = 0;
    for (const row of candidates) {
      if (selected.length && bytes + row.bytes > 44_000) break;
      if (row.bytes > 60_000)
        throw new AppError(
          'validation_failed',
          'a retained checklist task exceeds the bounded copy input; inspect it before retrying',
          422,
        );
      selected.push(row.item_key);
      bytes += row.bytes;
    }
    if (!selected.length) {
      await this.commit(occurrence, [
        this.db
          .prepare("UPDATE tasks_recurrence_occurrences SET phase='seal' WHERE id=?")
          .bind(occurrence.id),
      ]);
      return;
    }
    const rows = (
      await this.db
        .prepare(
          'SELECT item_key,source_task_id,position,parent_key,snapshot_json FROM tasks_recurrence_copy_items WHERE occurrence_id=? AND item_key IN (SELECT value FROM json_each(?)) ORDER BY position',
        )
        .bind(occurrence.id, JSON.stringify(selected))
        .all<CopyRow>()
    ).results;
    const snapshots = rows.map((row) => ({
      row,
      task: JSON.parse(row.snapshot_json) as TaskRecurrenceSnapshot,
    }));
    const blockerIds = [...new Set(snapshots.flatMap((item) => item.task.blockedBy))];
    const mappings = new Map(
      (
        await this.db
          .prepare(
            'SELECT source_task_id,item_key FROM tasks_recurrence_copy_items WHERE occurrence_id=? AND source_task_id IN (SELECT value FROM json_each(?))',
          )
          .bind(occurrence.id, JSON.stringify(blockerIds))
          .all<{ source_task_id: string; item_key: string }>()
      ).results.map((row) => [row.source_task_id, row.item_key]),
    );
    const entries: CopyEntry[] = snapshots.map(({ row, task }) => ({
      key: row.item_key,
      sourceTaskId: task.id,
      position: row.position,
      parentKey: row.parent_key,
      title: task.title,
      notes: task.notes,
      completed: false,
      completedAt: null,
      scheduledDay: row.position === 0 ? occurrence.scheduled_day : task.scheduled_day,
      scheduledTime: task.scheduled_time,
      timeZone: task.time_zone,
      repeatRule: row.position === 0 ? parseRule(occurrence.rule_json) : null,
      labelIds: task.labelIds,
      priority: task.priority as 'none' | 'low' | 'medium' | 'high',
      starred: Boolean(task.starred),
      dependencyKeys: task.blockedBy.flatMap((id) => (mappings.has(id) ? [mappings.get(id)!] : [])),
      existingBlockerIds: task.blockedBy.filter((id) => !mappings.has(id)),
    }));
    await this.options.commands.appendCapturedCopy(
      occurrence.operation_id,
      occurrence.account_id,
      entries,
    );
    const next = rows.at(-1)!.position + 1;
    await this.commit(occurrence, [
      this.db
        .prepare('UPDATE tasks_recurrence_occurrences SET append_position=?,phase=? WHERE id=?')
        .bind(next, next === occurrence.total_tasks ? 'seal' : 'append', occurrence.id),
    ]);
  }
  private async countParent(occurrence: Occurrence): Promise<void> {
    const target = await copyTaskId(occurrence.operation_id, 'i0');
    const confirmed = await this.db
      .prepare(
        "SELECT r.task_id FROM tasks_command_copy_receipts r WHERE r.operation_id=? AND r.item_key='i0'",
      )
      .bind(occurrence.operation_id)
      .first<{ task_id: string }>();
    if (!confirmed) return;
    await this.commit(occurrence, [
      this.db
        .prepare(
          'UPDATE tasks_recurrence_series SET created_count=created_count+1,active_task_id=?,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks_recurrence_occurrences WHERE id=? AND parent_counted=0)',
        )
        .bind(target, this.now(), occurrence.series_id, occurrence.id),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_occurrences SET parent_counted=1,target_task_id=? WHERE id=?',
        )
        .bind(target, occurrence.id),
      this.db
        .prepare('UPDATE tasks_tasks SET series_id=?,occurrence_id=? WHERE account_id=? AND id=?')
        .bind(occurrence.series_id, occurrence.id, occurrence.account_id, target),
    ]);
  }
  private async copySlice(occurrence: Occurrence): Promise<void> {
    const operation = (
      await this.options.commands.advance(occurrence.account_id, occurrence.operation_id)
    ).operation;
    await this.countParent(occurrence);
    if (operation.state === 'succeeded')
      await this.commit(occurrence, [
        this.db
          .prepare(
            "UPDATE tasks_recurrence_occurrences SET phase='baselines',state='baselines',baseline_cursor=NULL WHERE id=?",
          )
          .bind(occurrence.id),
      ]);
    else await this.operationState(occurrence, operation);
  }
  private async operationState(occurrence: Occurrence, operation: OperationRecord): Promise<void> {
    if (
      operation.state === 'uncertain' ||
      operation.state === 'reconnect_required' ||
      operation.state === 'blocked_by_limit' ||
      operation.state === 'failed' ||
      operation.state === 'cancelled'
    ) {
      const state = operation.state === 'uncertain' ? 'uncertain' : 'paused';
      const summary = await this.options.operations.summary(operation.id, occurrence.account_id);
      await this.commit(occurrence, [
        this.db
          .prepare(
            'UPDATE tasks_recurrence_occurrences SET state=?,next_at=NULL,error_code=? WHERE id=?',
          )
          .bind(state, summary?.error?.code ?? operation.state, occurrence.id),
        this.db
          .prepare(
            'UPDATE tasks_recurrence_series SET state=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .bind(state, this.now(), occurrence.series_id),
      ]);
    } else {
      const summary = await this.options.operations.summary(operation.id, occurrence.account_id);
      if (summary?.nextAttemptAt && summary.nextAttemptAt > this.now())
        await this.commit(occurrence, [
          this.db
            .prepare('UPDATE tasks_recurrence_occurrences SET next_at=? WHERE id=?')
            .bind(summary.nextAttemptAt, occurrence.id),
        ]);
    }
  }
  private async baselineSlice(occurrence: Occurrence): Promise<void> {
    const progress = await this.options.commands.readCopyProgress(
      occurrence.operation_id,
      occurrence.account_id,
      { limit: 50, ...(occurrence.baseline_cursor ? { cursor: occurrence.baseline_cursor } : {}) },
    );
    const writes = progress.items.map((item) =>
      this.db
        .prepare(
          'UPDATE tasks_recurrence_copy_items SET task_id=?,baseline_revision=?,baseline_etag=? WHERE occurrence_id=? AND item_key=?',
        )
        .bind(item.taskId, item.revision, item.providerEtag, occurrence.id, item.key),
    );
    writes.push(
      this.db
        .prepare(
          'UPDATE tasks_recurrence_occurrences SET baseline_cursor=?,phase=?,state=?,next_at=? WHERE id=?',
        )
        .bind(
          progress.nextCursor,
          progress.nextCursor ? 'baselines' : 'ready',
          progress.nextCursor ? 'baselines' : 'ready',
          progress.nextCursor ? this.now() : null,
          occurrence.id,
        ),
    );
    if (!progress.nextCursor)
      writes.push(
        this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='active',revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(this.now(), occurrence.series_id),
        this.db
          .prepare('UPDATE tasks_recurrence_occurrences SET copy_confirmed_at=? WHERE id=?')
          .bind(this.now(), occurrence.id),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_copy_items SET snapshot_json='{}' WHERE occurrence_id=?",
          )
          .bind(occurrence.id),
        ...this.resolvedTransitionWrites(occurrence.transition_id),
      );
    await this.commit(occurrence, writes);
  }
  private async stop(occurrence: Occurrence): Promise<void> {
    const operation = await this.options.operations.get(
      occurrence.operation_id,
      occurrence.account_id,
    );
    if (operation)
      await this.options.operations.cancel(operation.id, occurrence.account_id, this.now());
    const remaining = operation
      ? await this.options.operations.get(operation.id, occurrence.account_id)
      : null;
    const state =
      remaining?.state === 'uncertain' ||
      remaining?.state === 'running' ||
      remaining?.state === 'partial'
        ? 'uncertain'
        : 'stopped';
    await this.commit(occurrence, [
      this.db
        .prepare(
          "UPDATE tasks_recurrence_occurrences SET state=?,phase='ready',next_at=NULL WHERE id=?",
        )
        .bind(state, occurrence.id),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_series SET state=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .bind(state, this.now(), occurrence.series_id),
    ]);
  }
  async status(accountId: string, taskId: string): Promise<RecurrenceStatus | null> {
    identity(accountId);
    identity(taskId);
    const task = await this.task(accountId, taskId);
    if (!task) return null;
    const occurrence = await this.occurrence(accountId, taskId);
    const series = task.series_id
      ? await this.series(accountId, task.series_id)
      : occurrence
        ? await this.series(accountId, occurrence.series_id)
        : null;
    const pause =
      !task.repeat_rule_json && task.deleted_at === null
        ? await this.db
            .prepare(
              'SELECT rule_json,reason,paused_at FROM tasks_schedule_pauses WHERE account_id=? AND task_id=?',
            )
            .bind(accountId, taskId)
            .first<{
              rule_json: string;
              reason: 'provider_day_removed' | 'provider_nested_task';
              paused_at: number;
            }>()
        : null;
    const pausedRule = pause
      ? { rule: parseRule(pause.rule_json), reason: pause.reason, pausedAt: pause.paused_at }
      : null;
    if (!series && !task.repeat_rule_json && !pausedRule) return null;
    const active = series ? await this.task(accountId, series.active_task_id) : task;
    const watch = active
      ? await this.db
          .prepare('SELECT next_at FROM tasks_recurrence_watches WHERE account_id=? AND task_id=?')
          .bind(accountId, active.id)
          .first<{ next_at: number }>()
      : null;
    const pausedWatch = watch?.next_at === Number.MAX_SAFE_INTEGER;
    return {
      taskId,
      seriesId: series?.id ?? null,
      occurrenceId: task.occurrence_id,
      state: pausedRule
        ? 'paused'
        : series?.state === 'uncertain'
          ? 'uncertain'
          : task.deleted_at !== null ||
              !active ||
              active.deleted_at !== null ||
              active.repeat_rule_json === null
            ? 'stopped'
            : pausedWatch
              ? 'paused'
              : (series?.state ?? 'active'),
      createdCount: series?.created_count ?? 1,
      successorTaskId: occurrence?.target_task_id ?? null,
      operationId: occurrence?.operation_id ?? null,
      checklistComplete: occurrence?.checklist_complete === 1,
      pausedRule,
      nextAttemptAt: occurrence?.next_at ?? null,
      errorCode: occurrence?.error_code ?? (pausedWatch ? 'reconnect_required' : null),
    };
  }
  private async sent(occurrence: Occurrence): Promise<boolean> {
    return (
      occurrence.parent_counted === 1 ||
      occurrence.state === 'uncertain' ||
      Boolean(
        await this.db
          .prepare(
            'SELECT 1 AS sent FROM tasks_operation_steps WHERE operation_id=? AND dispatched_at IS NOT NULL LIMIT 1',
          )
          .bind(occurrence.operation_id)
          .first(),
      )
    );
  }
  private baselinePredicate(): string {
    return `NOT EXISTS(SELECT 1 FROM tasks_recurrence_copy_items item LEFT JOIN tasks_tasks t ON t.account_id=o.account_id AND t.id=item.task_id
      LEFT JOIN tasks_recurrence_copy_items parent ON parent.occurrence_id=item.occurrence_id AND parent.item_key=item.parent_key
      WHERE item.occurrence_id=o.id AND (item.task_id IS NULL OR item.baseline_revision IS NULL OR t.id IS NULL OR t.deleted_at IS NOT NULL OR t.completed<>0 OR t.provider_missing_at IS NOT NULL OR t.revision<>item.baseline_revision OR t.provider_etag IS NOT item.baseline_etag OR t.list_id<>o.list_id OR t.parent_id IS NOT parent.task_id))
      AND NOT EXISTS(SELECT 1 FROM tasks_tasks child WHERE child.account_id=o.account_id AND child.parent_id=o.target_task_id AND child.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM tasks_recurrence_copy_items item WHERE item.occurrence_id=o.id AND item.task_id=child.id))
      AND NOT EXISTS(SELECT 1 FROM tasks_recurrence_occurrences later WHERE later.account_id=o.account_id AND later.source_task_id=o.target_task_id AND later.state NOT IN ('cancelled','stopped','finished'))
      AND EXISTS(SELECT 1 FROM tasks_recurrence_series s WHERE s.id=o.series_id AND s.active_task_id=o.target_task_id)
      AND EXISTS(SELECT 1 FROM tasks_lists l WHERE l.account_id=o.account_id AND l.id=o.list_id AND l.deleted_at IS NULL AND l.provider_missing_at IS NULL AND l.tasks_complete_at IS NOT NULL AND l.completed_complete_at IS NOT NULL AND l.sync_cursor IS NULL)
      AND NOT EXISTS(SELECT 1 FROM tasks_operations mutation WHERE mutation.account_id=o.account_id AND mutation.state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain') AND mutation.id<>o.undo_operation_id AND (
        mutation.resource_key IN (SELECT 'task:'||item.task_id FROM tasks_recurrence_copy_items item WHERE item.occurrence_id=o.id)
        OR EXISTS(SELECT 1 FROM tasks_command_steps step WHERE step.operation_id=mutation.id AND (json_extract(step.input_json,'$.task.id') IN(SELECT item.task_id FROM tasks_recurrence_copy_items item WHERE item.occurrence_id=o.id) OR json_extract(step.input_json,'$.parent.id') IN(SELECT item.task_id FROM tasks_recurrence_copy_items item WHERE item.occurrence_id=o.id)))))`;
  }
  private async removable(occurrence: Occurrence): Promise<boolean> {
    if (
      !occurrence.target_task_id ||
      !['ready', 'undoing', 'reopen_required'].includes(occurrence.state)
    )
      return false;
    return Boolean(
      await this.db
        .prepare(
          `SELECT 1 AS valid FROM tasks_recurrence_occurrences o WHERE o.id=? AND o.copy_confirmed_at IS NOT NULL AND ${this.baselinePredicate()} AND (SELECT COUNT(*) FROM tasks_recurrence_copy_items item WHERE item.occurrence_id=o.id)=o.total_tasks`,
        )
        .bind(occurrence.id)
        .first(),
    );
  }
  private untouchedGuard(occurrence: Occurrence): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_recurrence_occurrences o WHERE o.id=? AND ${this.baselinePredicate()})`,
      )
      .bind(occurrence.id);
  }
  private async observeReopen(
    transition: Transition,
    task: TaskRow | null,
    occurrence: Occurrence | null,
  ): Promise<RecurrenceAdvance> {
    if (occurrence?.state === 'undoing') {
      await this.db.batch(this.resolvedTransitionWrites(transition.id));
      return {
        accountId: occurrence.account_id,
        taskId: occurrence.source_task_id,
        advanced: true,
        pending: true,
        state: 'undoing',
      };
    }
    if (
      !occurrence ||
      occurrence.state === 'cancelled' ||
      task?.completed ||
      !task ||
      task.deleted_at !== null
    ) {
      await this.db
        .prepare("UPDATE tasks_recurrence_transitions SET state='resolved' WHERE id=?")
        .bind(transition.id)
        .run();
      return {
        ...idle,
        accountId: transition.account_id,
        taskId: transition.task_id,
        advanced: true,
      };
    }
    const operation = await this.options.operations.get(
      occurrence.operation_id,
      occurrence.account_id,
    );
    if (operation)
      await this.options.operations.cancel(operation.id, occurrence.account_id, this.now());
    const sent = await this.sent(occurrence);
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE tasks_recurrence_occurrences SET state=?,phase='ready',next_at=NULL,claim_id=NULL,claim_until=NULL,updated_at=? WHERE id=?",
        )
        .bind(sent ? 'reopen_required' : 'cancelled', this.now(), occurrence.id),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_series SET state=?,active_task_id=CASE WHEN ?=0 THEN ? ELSE active_task_id END,revision=revision+1,updated_at=? WHERE id=?',
        )
        .bind(
          sent ? 'reopen_required' : 'active',
          Number(sent),
          task.id,
          this.now(),
          occurrence.series_id,
        ),
      this.db
        .prepare("UPDATE tasks_recurrence_transitions SET state='resolved' WHERE id=?")
        .bind(transition.id),
    ]);
    return {
      accountId: task.account_id,
      taskId: task.id,
      advanced: true,
      pending: false,
      state: sent ? 'reopen_required' : 'active',
    };
  }
  async previewReopen(accountId: string, taskId: string): Promise<ReopenPreview> {
    identity(accountId);
    identity(taskId);
    const task = await this.task(accountId, taskId);
    const occurrence = await this.occurrence(accountId, taskId);
    if (!task || task.deleted_at !== null || !occurrence)
      throw new AppError('not_found', 'there is no retained recurrence completion to reopen', 404);
    const target = occurrence.target_task_id
      ? await this.task(accountId, occurrence.target_task_id)
      : null;
    const sent = await this.sent(occurrence);
    const removable = await this.removable(occurrence);
    const children = target
      ? ((
          await this.db
            .prepare(
              'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND parent_id=? AND deleted_at IS NULL',
            )
            .bind(accountId, target.id)
            .first<{ n: number }>()
        )?.n ?? 0)
      : 0;
    const choices: ReopenPreview['choices'] = !sent
      ? ['cancel_pending', 'one_off']
      : removable
        ? ['remove_untouched', 'one_off']
        : ['one_off'];
    const token = await hash(
      JSON.stringify([
        accountId,
        taskId,
        task.revision,
        occurrence.id,
        occurrence.state,
        occurrence.operation_id,
        occurrence.target_task_id,
        removable,
        children,
        sent,
      ]),
    );
    return {
      taskId,
      revision: task.revision,
      successorTaskId: target?.id ?? null,
      successorTitle: target?.title ?? null,
      successorSubtaskCount: children,
      choices,
      reason: !sent
        ? 'the successor has not been sent. cancel it and reopen this occurrence.'
        : removable
          ? 'undo will verify and remove the untouched successor and its checklist, then reopen this occurrence.'
          : 'the successor changed, has later work, or has an uncertain outcome. retain it and reopen this occurrence as a one-off.',
      token,
    };
  }
  async requestReopen(
    accountId: string,
    ownerSubject: string,
    input: ReopenRequest,
  ): Promise<RecurrenceStatus | null> {
    identity(accountId);
    identity(ownerSubject);
    const parsed = ReopenRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('validation_failed', 'confirm a current recurrence reopen choice', 422);
    const inputHash = await hash(JSON.stringify({ accountId, ownerSubject, input: parsed.data }));
    const prior = await this.db
      .prepare(
        'SELECT account_id,task_id,owner_subject,input_hash FROM tasks_recurrence_reopen_requests WHERE operation_id=?',
      )
      .bind(input.operationId)
      .first<{ account_id: string; task_id: string; owner_subject: string; input_hash: string }>();
    if (prior) {
      if (
        prior.account_id !== accountId ||
        prior.task_id !== input.taskId ||
        prior.owner_subject !== ownerSubject ||
        prior.input_hash !== inputHash
      )
        throw new AppError(
          'conflict',
          'this reopen operation identity already belongs to different input',
          409,
        );
      return this.status(accountId, input.taskId);
    }
    const issued = Number(input.operationId.slice(0, 13));
    if (issued > this.now() + 300_000 || this.now() - issued > 86_400_000)
      throw new AppError(
        'conflict',
        'this unrecorded reopen identity expired; inspect existing work before choosing another action',
        409,
      );
    if (
      await this.db
        .prepare('SELECT id FROM tasks_operations WHERE id=?')
        .bind(input.operationId)
        .first()
    )
      throw new AppError(
        'conflict',
        'this operation identity already belongs to another command',
        409,
      );
    const occurrence = await this.occurrence(accountId, input.taskId);
    if (!occurrence) throw new AppError('not_found', 'this recurrence was not found', 404);
    if (occurrence.undo_operation_id && occurrence.state === 'undoing')
      throw new AppError('conflict', 'another reopen choice is already being executed', 409);
    const preview = await this.previewReopen(accountId, input.taskId);
    if (
      preview.token !== input.token ||
      preview.revision !== input.revision ||
      !preview.choices.includes(input.choice)
    )
      throw new AppError(
        'conflict',
        'the successor changed; review the current reopen choices',
        409,
      );
    if (input.choice === 'remove_untouched' && !this.options.requestTaskCheck)
      throw new AppError(
        'installation_unavailable',
        'safe recurrence undo needs provider verification',
        503,
      );
    const phase = 'undo_cancel';
    try {
      await this.db.batch([
        this.db
          .prepare(
            'INSERT INTO tasks_recurrence_reopen_requests(operation_id,account_id,task_id,occurrence_id,owner_subject,input_hash,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            input.operationId,
            accountId,
            input.taskId,
            occurrence.id,
            ownerSubject,
            inputHash,
            this.now(),
          ),
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL)',
          )
          .bind(accountId, input.taskId, input.revision),
        ...(input.choice === 'remove_untouched' ? [this.untouchedGuard(occurrence)] : []),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_occurrences SET state='undoing',phase=?,undo_choice=?,undo_operation_id=?,undo_task_revision=?,owner_subject=?,next_at=?,error_code=NULL,verify_position=0,verify_requested_at=NULL,updated_at=? WHERE id=?",
          )
          .bind(
            phase,
            input.choice,
            input.operationId,
            input.revision,
            ownerSubject,
            this.now(),
            this.now(),
            occurrence.id,
          ),
        this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='undoing',revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(this.now(), occurrence.series_id),
      ]);
    } catch {
      throw new AppError(
        'conflict',
        'the recurrence changed while its reopen was being captured',
        409,
      );
    }
    return this.status(accountId, input.taskId);
  }
  private async undoOperationId(occurrence: Occurrence, step: string): Promise<string> {
    return (
      occurrence.undo_operation_id!.slice(0, 13) +
      ':' +
      (await hash(occurrence.undo_operation_id + ':' + step)).slice(0, 48)
    );
  }
  private async undoSlice(occurrence: Occurrence): Promise<void> {
    if (occurrence.phase === 'undo_cancel') {
      const operation = await this.options.operations.get(
        occurrence.operation_id,
        occurrence.account_id,
      );
      if (operation && operation.state !== 'succeeded')
        await this.options.operations.cancel(operation.id, occurrence.account_id, this.now());
      if (occurrence.undo_choice === 'cancel_pending' && (await this.sent(occurrence)))
        throw new AppError(
          'conflict',
          'the successor was already sent; inspect the confirmed output before choosing one-off reopen',
          409,
        );
      const next =
        occurrence.undo_choice === 'remove_untouched'
          ? 'undo_verify'
          : occurrence.undo_choice === 'one_off'
            ? 'undo_detach'
            : 'undo_reopen';
      await this.commit(occurrence, [
        this.db
          .prepare('UPDATE tasks_recurrence_occurrences SET phase=? WHERE id=?')
          .bind(next, occurrence.id),
      ]);
      return;
    }
    if (occurrence.phase === 'undo_verify') {
      if (!(await this.removable(occurrence)))
        throw new AppError(
          'conflict',
          'the successor changed; retain it and choose a one-off reopen',
          409,
        );
      const item = await this.db
        .prepare(
          'SELECT task_id FROM tasks_recurrence_copy_items WHERE occurrence_id=? AND position=?',
        )
        .bind(occurrence.id, occurrence.verify_position)
        .first<{ task_id: string | null }>();
      if (!item) {
        await this.commit(occurrence, [
          this.db
            .prepare(
              "UPDATE tasks_recurrence_occurrences SET phase='undo_delete',verify_requested_at=NULL WHERE id=?",
            )
            .bind(occurrence.id),
        ]);
        return;
      }
      if (!item.task_id)
        throw new AppError('conflict', 'the successor has no confirmed provider identity', 409);
      if (occurrence.verify_requested_at === null) {
        await this.options.requestTaskCheck!(occurrence.account_id, item.task_id);
        await this.commit(occurrence, [
          this.db
            .prepare(
              'UPDATE tasks_recurrence_occurrences SET verify_requested_at=?,next_at=? WHERE id=?',
            )
            .bind(this.now(), this.now() + 1_000, occurrence.id),
        ]);
        return;
      }
      const checked = await this.db
        .prepare('SELECT last_provider_check_at FROM tasks_tasks WHERE account_id=? AND id=?')
        .bind(occurrence.account_id, item.task_id)
        .first<{ last_provider_check_at: number | null }>();
      await this.commit(occurrence, [
        (checked?.last_provider_check_at ?? -1) >= occurrence.verify_requested_at
          ? this.db
              .prepare(
                'UPDATE tasks_recurrence_occurrences SET verify_position=verify_position+1,verify_requested_at=NULL,next_at=? WHERE id=?',
              )
              .bind(this.now(), occurrence.id)
          : this.db
              .prepare('UPDATE tasks_recurrence_occurrences SET next_at=? WHERE id=?')
              .bind(this.now() + 1_000, occurrence.id),
      ]);
      return;
    }
    if (occurrence.phase === 'undo_finish') {
      await this.finishUndo(occurrence);
      return;
    }
    const original = await this.task(occurrence.account_id, occurrence.source_task_id);
    if (!original || original.deleted_at !== null)
      throw new AppError('not_found', 'the original occurrence is no longer available', 404);
    const id = await this.undoOperationId(occurrence, occurrence.phase);
    let operation = await this.options.operations.get(id, occurrence.account_id);
    if (!operation) {
      if (occurrence.phase === 'undo_delete') {
        if (!(await this.removable(occurrence)))
          throw new AppError(
            'conflict',
            'the successor changed before deletion; keep it and choose one-off reopen',
            409,
          );
        const target = await this.task(occurrence.account_id, occurrence.target_task_id!);
        if (!target) throw new AppError('not_found', 'the successor is unavailable', 404);
        const children = occurrence.total_tasks - 1;
        operation = await this.options.commands.prepare(
          {
            accountId: occurrence.account_id,
            ownerSubject: occurrence.owner_subject,
            operationId: id,
            command: {
              kind: 'task.delete',
              taskId: target.id,
              revision: target.revision,
              confirm: true,
              confirmSubtaskCount: children,
            },
          },
          [this.guard(occurrence), this.untouchedGuard(occurrence)],
        );
      } else if (occurrence.phase === 'undo_detach')
        operation = await this.options.commands.prepare(
          {
            accountId: occurrence.account_id,
            ownerSubject: occurrence.owner_subject,
            operationId: id,
            command: {
              kind: 'task.edit',
              taskId: original.id,
              revision: original.revision,
              patch: { repeatRule: null },
            },
          },
          [this.guard(occurrence)],
        );
      else {
        if (!original.completed) {
          await this.commit(occurrence, [
            this.db
              .prepare("UPDATE tasks_recurrence_occurrences SET phase='undo_finish' WHERE id=?")
              .bind(occurrence.id),
          ]);
          return;
        }
        operation = await this.options.commands.prepare(
          {
            accountId: occurrence.account_id,
            ownerSubject: occurrence.owner_subject,
            operationId: id,
            command: { kind: 'task.reopen', taskId: original.id, revision: original.revision },
          },
          [this.guard(occurrence)],
        );
      }
    }
    if (operation.state !== 'succeeded')
      operation = (await this.options.commands.advance(occurrence.account_id, id)).operation;
    if (operation.state !== 'succeeded') {
      await this.operationState(occurrence, operation);
      return;
    }
    const next =
      occurrence.phase === 'undo_delete' || occurrence.phase === 'undo_detach'
        ? 'undo_reopen'
        : 'undo_finish';
    await this.commit(occurrence, [
      this.db
        .prepare('UPDATE tasks_recurrence_occurrences SET phase=?,next_at=? WHERE id=?')
        .bind(next, this.now(), occurrence.id),
    ]);
  }
  private async finishUndo(occurrence: Occurrence): Promise<void> {
    const oneOff = occurrence.undo_choice === 'one_off';
    const source = await this.task(occurrence.account_id, occurrence.source_task_id);
    if (!source || source.deleted_at !== null || source.completed)
      throw new AppError(
        'conflict',
        'the original occurrence changed while reopen was finishing',
        409,
      );
    const previous = await this.options.operations.get(
      occurrence.operation_id,
      occurrence.account_id,
    );
    const uncertain = oneOff && previous?.state === 'uncertain';
    await this.commit(occurrence, [
      ...(oneOff
        ? [
            this.db
              .prepare(
                'UPDATE tasks_tasks SET repeat_rule_json=NULL,series_id=NULL,occurrence_id=NULL,revision=revision+1 WHERE account_id=? AND id=?',
              )
              .bind(occurrence.account_id, occurrence.source_task_id),
          ]
        : []),
      this.db
        .prepare(
          "UPDATE tasks_recurrence_occurrences SET state='cancelled',phase='ready',next_at=NULL,error_code=?,checklist_complete=CASE WHEN copy_confirmed_at IS NULL THEN 0 ELSE checklist_complete END WHERE id=?",
        )
        .bind(uncertain ? 'outcome_uncertain' : null, occurrence.id),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_series SET state=?,active_task_id=CASE WHEN ?=0 THEN ? ELSE active_task_id END,revision=revision+1,updated_at=? WHERE id=?',
        )
        .bind(
          uncertain ? 'uncertain' : oneOff && !occurrence.target_task_id ? 'paused' : 'active',
          Number(oneOff),
          occurrence.source_task_id,
          this.now(),
          occurrence.series_id,
        ),
      this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='resolved' WHERE account_id=? AND task_id=? AND state IN ('pending','admitted')",
        )
        .bind(occurrence.account_id, occurrence.source_task_id),
      this.db
        .prepare(
          'UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id=?',
        )
        .bind(occurrence.account_id, source.list_id),
      ...(!uncertain
        ? [
            this.db
              .prepare(
                "UPDATE tasks_recurrence_copy_items SET snapshot_json='{}' WHERE occurrence_id=?",
              )
              .bind(occurrence.id),
            ...this.resolvedTransitionWrites(occurrence.transition_id),
          ]
        : []),
    ]);
  }
  async resume(accountId: string, taskId: string): Promise<void> {
    identity(accountId);
    identity(taskId);
    const occurrence = await this.occurrence(accountId, taskId);
    if (occurrence?.state === 'cancelled' && occurrence.error_code === 'outcome_uncertain') {
      await this.reconcileOneOff(occurrence);
      return;
    }
    if (!occurrence || ['ready', 'finished', 'cancelled', 'stopped'].includes(occurrence.state)) {
      const source = await this.task(accountId, taskId);
      const series = source?.series_id
        ? await this.series(accountId, source.series_id)
        : occurrence
          ? await this.series(accountId, occurrence.series_id)
          : null;
      const active = series ? await this.task(accountId, series.active_task_id) : source;
      const watch = active
        ? await this.db
            .prepare(
              'SELECT next_at FROM tasks_recurrence_watches WHERE account_id=? AND task_id=?',
            )
            .bind(accountId, active.id)
            .first<{ next_at: number }>()
        : null;
      if (
        active &&
        active.deleted_at === null &&
        active.provider_missing_at === null &&
        !active.completed &&
        active.repeat_rule_json &&
        series?.state !== 'uncertain' &&
        (series?.state === 'paused' || watch?.next_at === Number.MAX_SAFE_INTEGER)
      ) {
        await assertProviderWritable(this.db, accountId);
        await this.db.batch([
          providerWriteGuard(this.db, accountId),
          this.db
            .prepare(
              'INSERT INTO tasks_recurrence_watches(account_id,task_id,next_at) VALUES(?,?,?) ON CONFLICT(account_id,task_id) DO UPDATE SET next_at=excluded.next_at',
            )
            .bind(accountId, active.id, this.now()),
          ...(series
            ? [
                this.db
                  .prepare(
                    "UPDATE tasks_recurrence_series SET state='active',revision=revision+1,updated_at=? WHERE account_id=? AND id=?",
                  )
                  .bind(this.now(), accountId, series.id),
              ]
            : []),
        ]);
        return;
      }
    }
    if (!occurrence || !['paused', 'uncertain'].includes(occurrence.state))
      throw new AppError('conflict', 'this recurrence has no paused work to resume', 409);
    const id =
      occurrence.phase.startsWith('undo_') && occurrence.undo_operation_id
        ? await this.undoOperationId(occurrence, occurrence.phase)
        : occurrence.operation_id;
    const operation = await this.options.operations.get(id, accountId);
    if (operation?.state === 'uncertain')
      throw new AppError(
        'outcome_uncertain',
        'resolve the provider operation before resuming recurrence',
        409,
      );
    if (operation && ['reconnect_required', 'blocked_by_limit'].includes(operation.state))
      await this.options.operations.resume(id, accountId, this.now());
    if (operation && ['failed', 'cancelled'].includes(operation.state))
      throw new AppError(
        'conflict',
        'this operation ended; inspect its confirmed output before choosing another action',
        409,
      );
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE tasks_recurrence_occurrences SET state=?,next_at=?,error_code=NULL WHERE id=?',
        )
        .bind(
          occurrence.phase.startsWith('undo_')
            ? 'undoing'
            : occurrence.phase === 'copy'
              ? 'copying'
              : 'capturing',
          this.now(),
          occurrence.id,
        ),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_series SET state=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .bind(
          occurrence.phase.startsWith('undo_') ? 'undoing' : 'pending',
          this.now(),
          occurrence.series_id,
        ),
    ]);
  }
  private async reconcileOneOff(occurrence: Occurrence): Promise<void> {
    let operation = await this.options.operations.get(
      occurrence.operation_id,
      occurrence.account_id,
    );
    if (!operation || operation.state === 'uncertain')
      throw new AppError(
        'outcome_uncertain',
        'resolve the original copy operation before reconciling its series',
        409,
      );
    if (!['succeeded', 'cancelled', 'failed'].includes(operation.state))
      operation = (
        await this.options.commands.advance(occurrence.account_id, occurrence.operation_id)
      ).operation;
    if (!['succeeded', 'cancelled', 'failed'].includes(operation.state))
      throw new AppError(
        'outcome_uncertain',
        'the original copy still needs a confirmed local outcome',
        409,
      );
    const progress = await this.options.commands.readCopyProgress(
      occurrence.operation_id,
      occurrence.account_id,
      { limit: 1 },
    );
    const parent = progress.items.find((item) => item.key === 'i0');
    if (!parent) {
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE tasks_recurrence_series SET state='stopped',revision=revision+1,updated_at=? WHERE id=?",
          )
          .bind(this.now(), occurrence.series_id),
        this.db
          .prepare('UPDATE tasks_recurrence_occurrences SET error_code=NULL WHERE id=?')
          .bind(occurrence.id),
      ]);
      return;
    }
    const target = await this.task(occurrence.account_id, parent.taskId);
    if (!target || target.deleted_at !== null)
      throw new AppError(
        'conflict',
        'the confirmed successor is unavailable; inspect the retained copy result',
        409,
      );
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE tasks_recurrence_series SET created_count=created_count+1,active_task_id=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks_recurrence_occurrences WHERE id=? AND parent_counted=0)',
        )
        .bind(
          target.id,
          target.repeat_rule_json ? 'active' : 'stopped',
          this.now(),
          occurrence.series_id,
          occurrence.id,
        ),
      this.db
        .prepare(
          'UPDATE tasks_recurrence_occurrences SET parent_counted=1,target_task_id=?,checklist_complete=0,error_code=NULL WHERE id=?',
        )
        .bind(target.id, occurrence.id),
      this.db
        .prepare('UPDATE tasks_tasks SET series_id=?,occurrence_id=? WHERE account_id=? AND id=?')
        .bind(occurrence.series_id, occurrence.id, occurrence.account_id, target.id),
      this.db
        .prepare("UPDATE tasks_recurrence_copy_items SET snapshot_json='{}' WHERE occurrence_id=?")
        .bind(occurrence.id),
      ...this.resolvedTransitionWrites(occurrence.transition_id),
    ]);
  }
}
