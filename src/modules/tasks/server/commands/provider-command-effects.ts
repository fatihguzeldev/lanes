import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { HistoryService } from '../../../history/server';
import type { HistoryEventInput } from '../../../history/contracts';
import type { TaskMetadataService } from '../metadata';
import type { CapturedStep } from './provider-command-state';

interface TaskCommandEffectsOptions {
  history: HistoryService;
  metadata?: TaskMetadataService;
  now: () => number;
}

/** Prepare confirmed local effects; the command owner commits them with its receipt. */
export class TaskCommandEffects {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskCommandEffectsOptions,
  ) {
    this.now = options.now;
  }

  event(
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
  scheduleWrites(
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
  async metadataWrites(
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
}
