import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../contracts/errors';
import { assertProviderWritable } from '../../../accounts/access';
import type { ProviderCommand, PrepareProviderCommand } from '../../provider-command-contract';
import { CapturedCopyPlanner } from './provider-copy-plan';
import type { CopyEntry } from './provider-copy-contract';
import type { OperationRecord } from '../operations';
import type { ListRef } from './provider-command-state';
import { TaskQueries } from '../queries/tasks';

export interface DuplicatePlanOptions {
  copies: CapturedCopyPlanner;
  now?: () => number;
  queries: TaskQueries;
  list(accountId: string, listId: string, revision?: number): Promise<ListRef>;
  position(
    accountId: string,
    list: ListRef,
    parentId: string | null,
    parentRevision: number | undefined,
    previousId: string | null | undefined,
    previousRevision: number | undefined,
  ): Promise<{ previous: { id: string } | null }>;
  listAppearanceSnapshot?(accountId: string, listId: string): Promise<{ color: string }>;
}
export interface DuplicateConsequences {
  taskCount: number;
  contextParentCount: number;
  externalDependencyCount: number;
  repeatingTaskCount: number;
  coverageComplete: boolean;
}
type DuplicateCommand = Extract<ProviderCommand, { kind: 'task.duplicate' | 'list.duplicate' }>;
/** Duplication snapshots are captured by SQL once; only bounded copy records cross the Worker boundary. */
export class TaskDuplicatePlanner {
  constructor(
    private readonly db: D1Database,
    private readonly options: DuplicatePlanOptions,
  ) {}
  private selection(
    accountId: string,
    listId: string,
    taskId: string | null,
    includeCompleted: boolean,
  ): { sql: string; bindings: (string | number | null)[] } {
    const selected = `t.account_id=? AND t.list_id=? AND t.deleted_at IS NULL AND (? IS NULL OR t.id=? OR t.parent_id=?) AND (?=1 OR t.completed=0 OR t.id=? OR EXISTS(SELECT 1 FROM tasks_tasks c WHERE c.account_id=t.account_id AND c.parent_id=t.id AND c.deleted_at IS NULL AND c.completed=0))`;
    return {
      sql: `WITH selected AS(SELECT t.*,ROW_NUMBER() OVER(ORDER BY CASE WHEN t.id=? OR t.parent_id IS NULL THEN 0 ELSE 1 END,COALESCE(p.provider_position,t.provider_position),COALESCE(p.id,t.id),t.provider_position,t.id)-1 AS copy_position FROM tasks_tasks t LEFT JOIN tasks_tasks p ON p.account_id=t.account_id AND p.id=t.parent_id WHERE ${selected}),named AS(SELECT *,'i'||copy_position AS copy_key FROM selected)`,
      bindings: [
        taskId,
        accountId,
        listId,
        taskId,
        taskId,
        taskId,
        Number(includeCompleted),
        taskId,
      ],
    };
  }
  async inspect(accountId: string, command: DuplicateCommand): Promise<DuplicateConsequences> {
    const task =
      command.kind === 'task.duplicate'
        ? await this.options.queries.getTask(accountId, command.taskId)
        : null;
    if (task && task.revision !== command.revision)
      throw new AppError('conflict', 'the source task changed. refresh before copying.', 409);
    const list = await this.options.list(
      accountId,
      task?.listId ?? command.listId,
      command.kind === 'list.duplicate' ? command.revision : undefined,
    );
    const selection = this.selection(
      accountId,
      list.id,
      task?.id ?? null,
      command.includeCompleted,
    );
    const counts = await this.db
      .prepare(
        `${selection.sql} SELECT COUNT(*) AS tasks,COALESCE(SUM(CASE WHEN completed=1 AND ?=0 THEN 1 ELSE 0 END),0) AS context,COALESCE(SUM(CASE WHEN repeat_rule_json IS NOT NULL THEN 1 ELSE 0 END),0) AS repeating,(SELECT COUNT(*) FROM tasks_dependencies d JOIN named source ON source.id=d.task_id WHERE d.account_id=? AND NOT EXISTS(SELECT 1 FROM named target WHERE target.id=d.blocker_id)) AS external FROM named`,
      )
      .bind(...selection.bindings, Number(command.includeCompleted), accountId)
      .first<{ tasks: number; context: number; repeating: number; external: number }>();
    return {
      taskCount: counts?.tasks ?? 0,
      contextParentCount: counts?.context ?? 0,
      externalDependencyCount: counts?.external ?? 0,
      repeatingTaskCount: counts?.repeating ?? 0,
      coverageComplete: list.complete,
    };
  }
  async prepare(
    input: PrepareProviderCommand & { command: DuplicateCommand },
    trustedGuards: D1PreparedStatement[] = [],
  ): Promise<OperationRecord> {
    await assertProviderWritable(this.db, input.accountId);
    const command = input.command,
      consequences = await this.inspect(input.accountId, command);
    if (!consequences.coverageComplete)
      throw new AppError(
        'conflict',
        'refresh complete source list coverage before capturing a copy.',
        409,
      );
    if (consequences.taskCount > 2000)
      throw new AppError(
        'validation_failed',
        'this copy exceeds 2,000 tasks including subtasks. select a smaller source.',
        422,
      );
    const confirmations: Record<string, string> = {};
    if (consequences.repeatingTaskCount && !command.confirmIndependentRepeat)
      confirmations.independentRepeatCount = String(consequences.repeatingTaskCount);
    if (
      consequences.externalDependencyCount &&
      command.confirmOmittedDependencyCount !== consequences.externalDependencyCount
    )
      confirmations.omittedDependencyCount = String(consequences.externalDependencyCount);
    if (Object.keys(confirmations).length)
      throw new AppError(
        'validation_failed',
        'confirm independent repeat rules and omitted outside dependencies before copying.',
        422,
        false,
        { confirmation: 'required', ...confirmations },
      );
    const sourceTask =
      command.kind === 'task.duplicate'
        ? await this.options.queries.getTask(input.accountId, command.taskId)
        : null;
    const source = await this.options.list(
        input.accountId,
        sourceTask?.listId ?? command.listId,
        command.kind === 'list.duplicate' ? command.revision : undefined,
      ),
      selection = this.selection(
        input.accountId,
        source.id,
        sourceTask?.id ?? null,
        command.includeCompleted,
      );
    const unsupported = await this.db
      .prepare(
        `${selection.sql} SELECT 1 FROM named WHERE unsupported_hierarchy=1 OR provider_missing_at IS NOT NULL LIMIT 1`,
      )
      .bind(...selection.bindings)
      .first();
    if (unsupported)
      throw new AppError(
        'validation_failed',
        'the source contains an unresolved provider identity or unsupported hierarchy. refresh or correct it before copying.',
        422,
      );
    let destination: ListRef | null = null,
      previousId: string | null = null,
      parentId: string | null = null;
    if (command.kind === 'task.duplicate') {
      destination = await this.options.list(input.accountId, command.listId, command.listRevision);
      parentId = command.parentId;
      if (parentId && (consequences.taskCount > 1 || sourceTask?.repeatRule))
        throw new AppError(
          'validation_failed',
          'a copied checklist or repeating task cannot be nested. reorganize it first.',
          422,
        );
      previousId =
        (
          await this.options.position(
            input.accountId,
            destination,
            parentId,
            command.parentRevision,
            command.previousId,
            command.previousRevision,
          )
        ).previous?.id ?? null;
    }
    const sourceGuard = this.db
      .prepare(
        'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND revision=? AND projection_revision=? AND deleted_at IS NULL)',
      )
      .bind(input.accountId, source.id, source.revision, source.projectionRevision);
    const titleOverride = command.kind === 'task.duplicate' ? (command.title ?? null) : null;
    const snapshot = this.db
      .prepare(
        `${selection.sql} INSERT INTO tasks_command_copy_sources(operation_id,item_key,position,input_json)
   SELECT ?,copy_key,copy_position,json_patch(json_object('key',n.copy_key,'sourceTaskId',n.id,'position',n.copy_position,'parentKey',(SELECT p.copy_key FROM named p WHERE p.id=n.parent_id),'title',CASE WHEN n.id=? AND ? IS NOT NULL THEN ? ELSE n.title END,'notes',n.notes,'completed',json(CASE WHEN ?=1 AND n.completed=1 THEN 'true' ELSE 'false' END),'completedAt',CASE WHEN ?=1 AND n.completed=1 THEN n.completed_at ELSE NULL END,'scheduledDay',n.scheduled_day,'scheduledTime',n.scheduled_time,'timeZone',n.time_zone,'repeatRule',json(COALESCE(n.repeat_rule_json,'null')),'priority',n.priority,'starred',json(CASE WHEN n.starred=1 THEN 'true' ELSE 'false' END),'listKey','list'),json_object('labelIds',json('[]'),'existingBlockerIds',json('[]'),'labelDefinitions',json(COALESCE((SELECT json_group_array(json_object('name',label.name,'color',label.color)) FROM tasks_task_labels assignment JOIN tasks_labels label ON label.account_id=assignment.account_id AND label.id=assignment.label_id WHERE assignment.account_id=n.account_id AND assignment.task_id=n.id),'[]')),'dependencyKeys',json(COALESCE((SELECT json_group_array(target.copy_key) FROM tasks_dependencies d JOIN named target ON target.id=d.blocker_id WHERE d.account_id=n.account_id AND d.task_id=n.id),'[]')))) FROM named n`,
      )
      .bind(
        ...selection.bindings,
        input.operationId,
        sourceTask?.id ?? null,
        titleOverride,
        titleOverride,
        Number(command.includeCompleted),
        Number(command.includeCompleted),
      );
    const auto = this.db
      .prepare(
        "UPDATE tasks_command_plans SET copy_context_json=json_set(copy_context_json,'$.autoSource',json('true')) WHERE operation_id=?",
      )
      .bind(input.operationId);
    const color =
      command.kind === 'list.duplicate'
        ? await this.options.listAppearanceSnapshot?.(input.accountId, source.id)
        : undefined;
    const record = await this.options.copies.begin({
      operationId: input.operationId,
      ownerSubject: input.ownerSubject,
      accountId: input.accountId,
      source: 'duplication',
      origin: 'owner',
      totalTasks: consequences.taskCount,
      requestKey: input.operationId,
      request: command,
      ...(command.kind === 'task.duplicate'
        ? {
            listId: destination!.id,
            listRevision: destination!.revision,
            previousTaskId: previousId,
            ...(parentId ? { parentTaskId: parentId } : {}),
          }
        : {
            totalLists: 1,
            newListCount: 1,
            lists: [
              {
                key: 'list',
                position: 0,
                title: command.title,
                boardId: command.boardId,
                ...(command.boardRevision === undefined
                  ? {}
                  : { boardRevision: command.boardRevision }),
                ...(color ? { color: color.color } : {}),
              },
            ],
          }),
      guardWrites: [
        ...trustedGuards,
        sourceGuard,
        ...(sourceTask
          ? [
              this.db
                .prepare(
                  'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL)',
                )
                .bind(input.accountId, sourceTask.id, sourceTask.revision),
            ]
          : []),
        snapshot,
        auto,
      ],
    });
    return record;
  }
  async advance(operationId: string, accountId: string): Promise<OperationRecord> {
    const rows = (
      await this.db
        .prepare(
          `SELECT s.item_key,s.input_json FROM tasks_command_copy_sources s LEFT JOIN tasks_command_copy_entries e ON e.operation_id=s.operation_id AND e.item_key=s.item_key WHERE s.operation_id=? AND e.item_key IS NULL ORDER BY s.position LIMIT 10`,
        )
        .bind(operationId)
        .all<{ item_key: string; input_json: string }>()
    ).results;
    const entries: CopyEntry[] = [];
    let length = 0;
    for (const row of rows) {
      const size = new TextEncoder().encode(row.input_json).byteLength;
      if (entries.length && length + size > 60_000) break;
      entries.push(JSON.parse(row.input_json) as CopyEntry);
      length += size;
    }
    if (entries.length) await this.options.copies.appendTasks(operationId, accountId, entries);
    else await this.options.copies.seal(operationId, accountId);
    await this.db
      .prepare('UPDATE tasks_operations SET updated_at=? WHERE id=? AND account_id=?')
      .bind(this.options.now?.() ?? Date.now(), operationId, accountId)
      .run();
    return await this.options.copies.admit(operationId, accountId);
  }
}
