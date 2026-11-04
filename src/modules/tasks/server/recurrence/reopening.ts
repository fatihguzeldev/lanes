import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import {
  ReopenRequestSchema,
  type RecurrenceAdvance,
  type RecurrenceStatus,
  type ReopenPreview,
  type ReopenRequest,
} from '../../contracts/recurrence';
import type { RecurrencePersistence } from './persistence';
import type { RecurrenceQueries } from './queries';
import type { Occurrence, RecurrenceOptions, TaskRow, Transition } from './records';
import { hash, identity, idle } from './state';

/** Explicit reopen choices retain or undo only the captured successor. */
export class RecurrenceReopening {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: RecurrenceOptions,
    private readonly persistence: RecurrencePersistence,
    private readonly queries: RecurrenceQueries,
  ) {
    this.now = options.now ?? Date.now;
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

  async observeReopen(
    transition: Transition,
    task: TaskRow | null,
    occurrence: Occurrence | null,
  ): Promise<RecurrenceAdvance> {
    if (occurrence?.state === 'undoing') {
      await this.db.batch(this.persistence.resolvedTransitionWrites(transition.id));
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
    const task = await this.persistence.task(accountId, taskId);
    const occurrence = await this.persistence.occurrence(accountId, taskId);
    if (!task || task.deleted_at !== null || !occurrence)
      throw new AppError('not_found', 'there is no retained recurrence completion to reopen', 404);
    const target = occurrence.target_task_id
      ? await this.persistence.task(accountId, occurrence.target_task_id)
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
      return this.queries.status(accountId, input.taskId);
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
    const occurrence = await this.persistence.occurrence(accountId, input.taskId);
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
    return this.queries.status(accountId, input.taskId);
  }

  async undoOperationId(occurrence: Occurrence, step: string): Promise<string> {
    return (
      occurrence.undo_operation_id!.slice(0, 13) +
      ':' +
      (await hash(occurrence.undo_operation_id + ':' + step)).slice(0, 48)
    );
  }

  async undoSlice(occurrence: Occurrence): Promise<void> {
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
      await this.persistence.commit(occurrence, [
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
        await this.persistence.commit(occurrence, [
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
        await this.persistence.commit(occurrence, [
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
      await this.persistence.commit(occurrence, [
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
    const original = await this.persistence.task(occurrence.account_id, occurrence.source_task_id);
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
        const target = await this.persistence.task(
          occurrence.account_id,
          occurrence.target_task_id!,
        );
        if (!target) throw new AppError('not_found', 'the successor is unavailable', 404);
        const children = occurrence.total_tasks - 1;
        operation = await this.options.commands.capture.prepare(
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
          [this.persistence.guard(occurrence), this.untouchedGuard(occurrence)],
        );
      } else if (occurrence.phase === 'undo_detach')
        operation = await this.options.commands.capture.prepare(
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
          [this.persistence.guard(occurrence)],
        );
      else {
        if (!original.completed) {
          await this.persistence.commit(occurrence, [
            this.db
              .prepare("UPDATE tasks_recurrence_occurrences SET phase='undo_finish' WHERE id=?")
              .bind(occurrence.id),
          ]);
          return;
        }
        operation = await this.options.commands.capture.prepare(
          {
            accountId: occurrence.account_id,
            ownerSubject: occurrence.owner_subject,
            operationId: id,
            command: { kind: 'task.reopen', taskId: original.id, revision: original.revision },
          },
          [this.persistence.guard(occurrence)],
        );
      }
    }
    if (operation.state !== 'succeeded')
      operation = (await this.options.commands.advance(occurrence.account_id, id)).operation;
    if (operation.state !== 'succeeded') {
      await this.persistence.operationState(occurrence, operation);
      return;
    }
    const next =
      occurrence.phase === 'undo_delete' || occurrence.phase === 'undo_detach'
        ? 'undo_reopen'
        : 'undo_finish';
    await this.persistence.commit(occurrence, [
      this.db
        .prepare('UPDATE tasks_recurrence_occurrences SET phase=?,next_at=? WHERE id=?')
        .bind(next, this.now(), occurrence.id),
    ]);
  }

  private async finishUndo(occurrence: Occurrence): Promise<void> {
    const oneOff = occurrence.undo_choice === 'one_off';
    const source = await this.persistence.task(occurrence.account_id, occurrence.source_task_id);
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
    await this.persistence.commit(occurrence, [
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
            ...this.persistence.resolvedTransitionWrites(occurrence.transition_id),
          ]
        : []),
    ]);
  }

  async reconcileOneOff(occurrence: Occurrence): Promise<void> {
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
    const target = await this.persistence.task(occurrence.account_id, parent.taskId);
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
      ...this.persistence.resolvedTransitionWrites(occurrence.transition_id),
    ]);
  }
}
