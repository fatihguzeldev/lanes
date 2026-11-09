import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { Task } from '../../contracts/task';
import { TaskQueries } from '../queries/tasks';
import { conflict, digest, ref } from './input';
import type { CapturedStep, ListRef, TaskRef } from './state';
function taskReferenceSql(task: string, list: string): string {
  return `json_object('id',${task}.id,'listId',${task}.list_id,'parentId',${task}.parent_id,'title',${task}.title,'completed',json(CASE WHEN ${task}.completed=1 THEN 'true' ELSE 'false' END),'completedAt',${task}.completed_at,'scheduledDay',${task}.scheduled_day,'scheduledTime',${task}.scheduled_time,'timeZone',${task}.time_zone,'repeatRule',json(COALESCE(${task}.repeat_rule_json,'null')),'revision',${task}.revision,'provider',json_object('id',${task}.provider_id,'listId',${list}.provider_id,'etag',${task}.provider_etag,'position',${task}.provider_position,'updatedAt',${task}.provider_updated_at),'capabilities',json(${task}.capabilities_json))`;
}

/** Reads the confirmed task/list snapshot and prepares its capture fences. */
export class TaskCommandResources {
  constructor(
    private readonly db: D1Database,
    private readonly queries: TaskQueries,
  ) {}

  async list(accountId: string, listId: string, revision?: number): Promise<ListRef> {
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

  complete(list: ListRef): void {
    if (!list.complete)
      throw conflict(
        'refresh complete task coverage for this list before capturing hierarchy or manual sibling order.',
      );
  }

  async task(accountId: string, id: string, revision?: number): Promise<Task> {
    const task = await this.queries.getTask(accountId, id);
    if (revision !== undefined && task.revision !== revision) throw conflict();
    return task;
  }

  async childCount(accountId: string, taskId: string, openOnly = false): Promise<number> {
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

  childCompletionCapture(
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

  async position(
    accountId: string,
    list: ListRef,
    parentId: string | null,
    parentRevision: number | undefined,
    previousId: string | null | undefined,
    previousRevision: number | undefined,
    movingId?: string,
    relativeOrder = false,
  ): Promise<{ parent: TaskRef | null; previous: TaskRef | null }> {
    if (!relativeOrder || previousId === undefined) this.complete(list);
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
      parent = relativeOrder
        ? { ...ref(value), notesDigest: await digest(value.notes) }
        : ref(value);
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
        previous = relativeOrder
          ? { ...ref(value), notesDigest: await digest(value.notes) }
          : ref(value);
      }
    }
    return { parent, previous };
  }

  async alreadyPositioned(
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

  revisionGuard(accountId: string, task: TaskRef): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND list_id=? AND provider_id=? AND deleted_at IS NULL)',
      )
      .bind(accountId, task.id, task.revision, task.listId, task.provider.id);
  }

  listGuard(accountId: string, list: ListRef): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND revision=? AND projection_revision=? AND deleted_at IS NULL)',
      )
      .bind(accountId, list.id, list.revision, list.projectionRevision);
  }

  listIdentityGuard(accountId: string, list: ListRef): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND provider_id=? AND deleted_at IS NULL AND provider_missing_at IS NULL)',
      )
      .bind(accountId, list.id, list.providerId);
  }

  ordinaryReopenGuard(accountId: string, step: CapturedStep): D1PreparedStatement {
    const identity = step.ordinaryReopenIdentity!;
    return this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND deleted_at IS NULL AND series_id IS ? AND occurrence_id IS ?)',
      )
      .bind(accountId, step.task!.id, identity.seriesId, identity.occurrenceId);
  }
}
