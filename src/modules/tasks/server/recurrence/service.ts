import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import {
  assertProviderWritable,
  providerWriteGuard,
} from '../../../accounts/server/connections/access';
import { type RecurrenceAdvance } from '../../contracts/recurrence';
import { accountToday, nextOccurrence } from '../../model/planning';
import { copyTaskId, type CopyEntry } from '../commands/copy-contract';
import type { TaskRecurrenceSnapshot } from '../projection/store';
import { RecurrencePersistence } from './persistence';
import { RecurrenceQueries } from './queries';
import type { CopyRow, Occurrence, RecurrenceOptions, Transition } from './records';
import { RecurrenceReopening } from './reopening';
import { hash, identity, idle, leaseMs, parseRule } from './state';

/** Advances one bounded successor slice; reopen and read flows are separate collaborators. */
export class RecurrenceService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly persistence: RecurrencePersistence;
  readonly queries: RecurrenceQueries;
  readonly reopening: RecurrenceReopening;
  constructor(
    private readonly db: D1Database,
    private readonly options: RecurrenceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.persistence = new RecurrencePersistence(db, options.operations, this.now);
    this.queries = new RecurrenceQueries(db, this.persistence);
    this.reopening = new RecurrenceReopening(db, options, this.persistence, this.queries);
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
    const task = await this.persistence.task(transition.account_id, transition.task_id);
    const existing = await this.persistence.occurrence(transition.account_id, transition.task_id);
    if (transition.kind === 'reopened')
      return this.reopening.observeReopen(transition, task, existing);
    if (existing && existing.state !== 'cancelled') {
      await this.db.batch(this.persistence.resolvedTransitionWrites(transition.id));
      return {
        accountId: transition.account_id,
        taskId: transition.task_id,
        advanced: true,
        pending: existing.next_at !== null,
        state:
          (await this.persistence.series(transition.account_id, existing.series_id))?.state ??
          'paused',
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
    const series = await this.persistence.series(task.account_id, seriesId);
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
              ...this.persistence.resolvedTransitionWrites(transition.id),
            ]
          : []),
      ]);
    } catch {
      const concurrent = await this.persistence.occurrence(task.account_id, task.id);
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
      const series = await this.persistence.series(occurrence.account_id, occurrence.series_id);
      const active = series
        ? await this.persistence.task(occurrence.account_id, series.active_task_id)
        : null;
      if (
        !occurrence.phase.startsWith('undo_') &&
        (!active || active.deleted_at !== null || active.repeat_rule_json === null)
      )
        await this.stop(occurrence);
      else if (occurrence.phase.startsWith('undo_')) await this.reopening.undoSlice(occurrence);
      else if (occurrence.phase === 'begin') await this.begin(occurrence);
      else if (occurrence.phase === 'append') await this.append(occurrence);
      else if (occurrence.phase === 'seal') {
        const sealed = await this.options.commands.sealCapturedCopy(
          occurrence.operation_id,
          occurrence.account_id,
        );
        if (sealed.captureSealed)
          await this.persistence.commit(occurrence, [
            this.db
              .prepare(
                "UPDATE tasks_recurrence_occurrences SET phase='copy',state='copying' WHERE id=?",
              )
              .bind(id),
          ]);
      } else if (occurrence.phase === 'copy') await this.copySlice(occurrence);
      else if (occurrence.phase === 'baselines') await this.baselineSlice(occurrence);
      await this.persistence.commit(occurrence, [
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
      await this.persistence.commit(occurrence, [
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
    const series = await this.persistence.series(occurrence.account_id, occurrence.series_id);
    return {
      accountId: occurrence.account_id,
      taskId: occurrence.source_task_id,
      advanced: true,
      pending: current?.next_at !== null,
      state: series?.state ?? 'paused',
    };
  }

  private async begin(occurrence: Occurrence): Promise<void> {
    const task = await this.persistence.task(occurrence.account_id, occurrence.source_task_id);
    const series = await this.persistence.series(occurrence.account_id, occurrence.series_id);
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
      await this.persistence.commit(occurrence, [
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
        ...this.persistence.resolvedTransitionWrites(occurrence.transition_id),
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
        this.persistence.guard(occurrence),
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
    await this.persistence.commit(occurrence, [
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
      await this.persistence.commit(occurrence, [
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
    await this.persistence.commit(occurrence, [
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
    await this.persistence.commit(occurrence, [
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
      await this.persistence.commit(occurrence, [
        this.db
          .prepare(
            "UPDATE tasks_recurrence_occurrences SET phase='baselines',state='baselines',baseline_cursor=NULL WHERE id=?",
          )
          .bind(occurrence.id),
      ]);
    else await this.persistence.operationState(occurrence, operation);
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
        ...this.persistence.resolvedTransitionWrites(occurrence.transition_id),
      );
    await this.persistence.commit(occurrence, writes);
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
    await this.persistence.commit(occurrence, [
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

  async resume(accountId: string, taskId: string): Promise<void> {
    identity(accountId);
    identity(taskId);
    const occurrence = await this.persistence.occurrence(accountId, taskId);
    if (occurrence?.state === 'cancelled' && occurrence.error_code === 'outcome_uncertain') {
      await this.reopening.reconcileOneOff(occurrence);
      return;
    }
    if (!occurrence || ['ready', 'finished', 'cancelled', 'stopped'].includes(occurrence.state)) {
      const source = await this.persistence.task(accountId, taskId);
      const series = source?.series_id
        ? await this.persistence.series(accountId, source.series_id)
        : occurrence
          ? await this.persistence.series(accountId, occurrence.series_id)
          : null;
      const active = series
        ? await this.persistence.task(accountId, series.active_task_id)
        : source;
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
        ? await this.reopening.undoOperationId(occurrence, occurrence.phase)
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
}
