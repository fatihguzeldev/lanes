import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import type { HistoryService } from '../../history/server/events/event-store';
import type { HistoryEventInput } from '../../history/contracts/events';
import { ResourceIdSchema, type TaskCapabilities } from '../contracts';
import { normalizeTaskSearchText } from '../model';
import type { GoogleTaskDTO } from './provider';

export interface TaskProjectionOptions {
  history: HistoryService;
  now?: () => number;
  id?: () => string;
}

export interface ProjectionListRow {
  id: string;
  account_id: string;
  provider_id: string;
  provider_etag: string | null;
  title: string;
  is_default: number;
  revision: number;
  projection_revision: number;
  tasks_complete_at: number | null;
  completed_complete_at: number | null;
  last_full_sync_at: number | null;
  sync_watermark: string | null;
  sync_cursor: string | null;
  deleted_at: number | null;
}
interface OldTask {
  id: string;
  list_id: string;
  provider_id: string;
  provider_parent_id: string | null;
  parent_id: string | null;
  provider_etag: string | null;
  provider_updated_at: string | null;
  provider_hidden: number;
  title: string;
  notes: string;
  completed: number;
  completed_at: string | null;
  scheduled_day: string | null;
  scheduled_time: string | null;
  time_zone: string | null;
  repeat_rule_json: string | null;
  revision: number;
  deleted_at: number | null;
  unsupported_hierarchy: number;
  capabilities_json: string;
}
export const projectionListFields =
  'id,account_id,provider_id,provider_etag,title,is_default,revision,projection_revision,tasks_complete_at,completed_complete_at,last_full_sync_at,sync_watermark,sync_cursor,deleted_at';
export function assertProjectionIdentity(value: string): void {
  if (!ResourceIdSchema.max(1_024).safeParse(value).success)
    throw new AppError(
      'validation_failed',
      'provide an explicit account or resource identity',
      422,
    );
}
export async function providerProjectionVersion(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function sourceUrl(value: string | undefined): string | null {
  try {
    return value && new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
function capabilities(task: GoogleTaskDTO, unsupported = false, missing = false): TaskCapabilities {
  const assigned = task.assignmentInfo;
  return {
    canEdit: !unsupported && !missing,
    canEditNotes: !unsupported && !missing && assigned?.surfaceType !== 'DOCUMENT',
    canMove: !unsupported && !missing,
    canDelete: !unsupported && !missing,
    canHaveChildren: !unsupported && !missing && !assigned,
    canNest: !unsupported && !missing && !assigned,
    assignmentSource: assigned ? (assigned.surfaceType === 'DOCUMENT' ? 'docs' : 'chat') : null,
    sourceUrl: sourceUrl(assigned?.linkToTask),
    restriction: missing
      ? 'google no longer returns this task at its recorded address; its metadata is retained while identity is unresolved'
      : unsupported
        ? 'the provider hierarchy cannot be safely edited in lanes'
        : assigned
          ? 'google limits nesting for assigned tasks; deleting also removes the source assignment'
          : null,
  };
}

/** Raw projection row snapshots, not browser Task objects. labelIds/blockedBy are JSON arrays.
 * Capture uses INSERT SELECT so a large open checklist never crosses the Worker boundary. */
export interface TaskRecurrenceSnapshot {
  id: string;
  account_id: string;
  list_id: string;
  parent_id: string | null;
  provider_id: string;
  provider_position: string | null;
  title: string;
  notes: string;
  completed: number;
  scheduled_day: string | null;
  scheduled_time: string | null;
  time_zone: string | null;
  repeat_rule_json: string | null;
  series_id: string | null;
  occurrence_id: string | null;
  priority: string;
  starred: number;
  revision: number;
  labelIds: string[];
  blockedBy: string[];
}
function snapshot(alias: string): string {
  const fields = [
    'id',
    'account_id',
    'list_id',
    'parent_id',
    'provider_id',
    'provider_position',
    'title',
    'notes',
    'completed',
    'scheduled_day',
    'scheduled_time',
    'time_zone',
    'repeat_rule_json',
    'series_id',
    'occurrence_id',
    'priority',
    'starred',
    'revision',
  ];
  const head = fields
    .slice(0, 15)
    .map((field) => `'${field}',${alias}.${field}`)
    .join(',');
  const tail = fields
    .slice(15)
    .map((field) => `'${field}',${alias}.${field}`)
    .join(',');
  return `json_patch(json_object(${head}),json_object(${tail},'labelIds',json(COALESCE((SELECT json_group_array(label_id) FROM tasks_task_labels labels WHERE labels.account_id=${alias}.account_id AND labels.task_id=${alias}.id),'[]')),'blockedBy',json(COALESCE((SELECT json_group_array(blocker_id) FROM tasks_dependencies deps WHERE deps.account_id=${alias}.account_id AND deps.task_id=${alias}.id),'[]'))))`;
}
export interface ProjectionWriteOptions {
  scanId?: string;
  observed?: boolean;
  baseline?: boolean;
  knownTaskIds?: ReadonlyMap<string, string>;
  preserveMissingFields?: boolean;
  clearedFields?: ReadonlyMap<string, ReadonlySet<'due' | 'completed' | 'parent'>>;
}
export class TaskProjectionStore {
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskProjectionOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  prepareCompletionCapture(
    accountId: string,
    taskId: string,
    operationId: string,
    expectedRevision: number,
    kind: 'completed' | 'reopened' = 'completed',
  ): D1PreparedStatement[] {
    assertProjectionIdentity(accountId);
    assertProjectionIdentity(taskId);
    assertProjectionIdentity(operationId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new AppError('validation_failed', 'capture the confirmed task revision', 422);
    const transitionId = `owner:${operationId}:${taskId}`;
    return [
      this.db
        .prepare(
          'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL)',
        )
        .bind(accountId, taskId, expectedRevision),
      this.db
        .prepare(
          `INSERT INTO tasks_recurrence_transitions(id,account_id,task_id,provider_version,kind,snapshot_json,children_complete,observed_at,state)
        SELECT ?,t.account_id,t.id,?,?,${snapshot('t')},CASE WHEN l.tasks_complete_at IS NOT NULL AND l.completed_complete_at IS NOT NULL AND l.sync_cursor IS NULL THEN 1 ELSE 0 END,?,'captured'
        FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.id=? AND t.parent_id IS NULL AND t.repeat_rule_json IS NOT NULL AND t.completed=?
        ON CONFLICT(account_id,task_id,provider_version,kind) DO NOTHING`,
        )
        .bind(
          transitionId,
          `owner:${operationId}`,
          kind,
          this.now(),
          accountId,
          taskId,
          kind === 'completed' ? 0 : 1,
        ),
      this.db
        .prepare(
          `INSERT INTO tasks_recurrence_transition_children(transition_id,task_id,snapshot_json) SELECT ?,c.id,${snapshot('c')} FROM tasks_tasks c
        WHERE c.account_id=? AND c.parent_id=? AND c.deleted_at IS NULL AND c.completed=0 AND EXISTS(SELECT 1 FROM tasks_recurrence_transitions WHERE id=? AND state='captured') ON CONFLICT(transition_id,task_id) DO NOTHING`,
        )
        .bind(transitionId, accountId, taskId, transitionId),
    ];
  }
  prepareCompletionConfirmationWrites(
    accountId: string,
    taskId: string,
    operationId: string,
  ): D1PreparedStatement[] {
    assertProjectionIdentity(accountId);
    assertProjectionIdentity(taskId);
    assertProjectionIdentity(operationId);
    return [
      this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='pending',observed_at=? WHERE account_id=? AND task_id=? AND id=? AND state='captured'",
        )
        .bind(this.now(), accountId, taskId, `owner:${operationId}:${taskId}`),
    ];
  }
  prepareCompletionCancellationWrites(
    accountId: string,
    taskId: string,
    operationId: string,
  ): D1PreparedStatement[] {
    assertProjectionIdentity(accountId);
    assertProjectionIdentity(taskId);
    assertProjectionIdentity(operationId);
    return [
      this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE account_id=? AND task_id=? AND id=? AND state='captured'",
        )
        .bind(accountId, taskId, `owner:${operationId}:${taskId}`),
    ];
  }

  /** The caller owns the projection_revision/claim guard and joins these statements to one batch. */
  async prepareConfirmedWrites(
    accountId: string,
    listId: string,
    records: GoogleTaskDTO[],
    options: ProjectionWriteOptions = {},
  ): Promise<{ writes: D1PreparedStatement[]; taskIds: Map<string, string> }> {
    assertProjectionIdentity(accountId);
    assertProjectionIdentity(listId);
    if (records.length > 5)
      throw new AppError(
        'validation_failed',
        'reconcile at most five task records in one slice',
        422,
      );
    const list = await this.db
      .prepare(
        `SELECT ${projectionListFields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(accountId, listId)
      .first<ProjectionListRow>();
    if (!list) throw new AppError('not_found', 'the task list is no longer available', 404);
    const providerIds = [
      ...new Set(records.flatMap((task) => (task.parent ? [task.id, task.parent] : [task.id]))),
    ];
    const oldRows = providerIds.length
      ? (
          await this.db
            .prepare(
              'SELECT * FROM tasks_tasks WHERE account_id=? AND list_id=? AND provider_id IN (SELECT value FROM json_each(?))',
            )
            .bind(accountId, listId, JSON.stringify(providerIds))
            .all<OldTask>()
        ).results
      : [];
    const oldByProvider = new Map(oldRows.map((row) => [row.provider_id, row]));
    const taskIds = new Map(oldRows.map((row) => [row.provider_id, row.id]));
    if (options.knownTaskIds?.size) {
      if (options.knownTaskIds.size > 10)
        throw new AppError(
          'validation_failed',
          'capture at most ten explicit task identities per projection slice',
          422,
        );
      const knownRows = (
        await this.db
          .prepare('SELECT * FROM tasks_tasks WHERE id IN (SELECT value FROM json_each(?))')
          .bind(JSON.stringify([...options.knownTaskIds.values()]))
          .all<OldTask & { account_id: string }>()
      ).results;
      if (knownRows.some((row) => row.account_id !== accountId || row.deleted_at !== null))
        throw new AppError(
          'not_found',
          'a captured task identity is unavailable in this account',
          404,
        );
      const byId = new Map(knownRows.map((row) => [row.id, row]));
      for (const [providerId, lanesId] of options.knownTaskIds) {
        assertProjectionIdentity(lanesId);
        const old = byId.get(lanesId);
        taskIds.set(providerId, lanesId);
        if (old) oldByProvider.set(providerId, old);
      }
    }
    for (const task of records) if (!taskIds.has(task.id)) taskIds.set(task.id, this.id());
    const childParents = new Set(
      (
        await this.db
          .prepare(
            'SELECT DISTINCT parent_id FROM tasks_tasks WHERE account_id=? AND list_id=? AND parent_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL',
          )
          .bind(accountId, listId, JSON.stringify([...taskIds.values()]))
          .all<{ parent_id: string }>()
      ).results.map((row) => row.parent_id),
    );
    const captures: D1PreparedStatement[] = [];
    const writes: D1PreparedStatement[] = [];
    const events: D1PreparedStatement[] = [];
    const at = this.now();
    const scanId = options.scanId ?? this.id();
    // Children may arrive on a later destination page. Keep their provider parent reference
    // without leaving a cross-list foreign key or allowing edits to an unresolved hierarchy.
    for (const old of oldByProvider.values())
      if (
        old.list_id !== listId &&
        records.some((task) => task.id === old.provider_id && !task.deleted)
      )
        writes.push(
          this.db
            .prepare(
              `UPDATE tasks_tasks SET parent_id=NULL,unsupported_hierarchy=1,
          capabilities_json=json_set(capabilities_json,'$.canEdit',json('false'),'$.canEditNotes',json('false'),'$.canMove',json('false'),'$.canDelete',json('false'),'$.canHaveChildren',json('false'),'$.canNest',json('false'),'$.restriction','the provider hierarchy is being reconciled after its parent changed lists'),revision=revision+1
          WHERE account_id=? AND parent_id=? AND list_id<>?`,
            )
            .bind(accountId, old.id, listId),
        );
    if (options.observed) {
      const touched = [
        ...new Set(
          records
            .flatMap((task) => [
              oldByProvider.get(task.id)?.id,
              oldByProvider.get(task.id)?.parent_id,
              task.parent ? taskIds.get(task.parent) : null,
            ])
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const captureId = this.id();
      captures.push(
        this.db
          .prepare(
            `DELETE FROM tasks_recurrence_observations WHERE account_id=? AND task_id IN (SELECT value FROM json_each(?)) AND scan_id<>?`,
          )
          .bind(accountId, JSON.stringify(touched), scanId),
      );
      captures.push(
        this.db
          .prepare(
            `INSERT INTO tasks_recurrence_observations(account_id,task_id,list_id,scan_id,capture_id,snapshot_json,children_complete)
        SELECT t.account_id,t.id,t.list_id,?,?,${snapshot('t')},CASE WHEN l.tasks_complete_at IS NOT NULL AND l.completed_complete_at IS NOT NULL AND l.sync_cursor IS NULL THEN 1 ELSE 0 END
        FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
        WHERE t.account_id=? AND t.id IN (SELECT value FROM json_each(?)) AND t.deleted_at IS NULL AND t.completed=0 AND t.parent_id IS NULL AND t.repeat_rule_json IS NOT NULL
        ON CONFLICT(account_id,task_id) DO NOTHING`,
          )
          .bind(scanId, captureId, accountId, JSON.stringify(touched)),
      );
      captures.push(
        this.db
          .prepare(
            `INSERT INTO tasks_recurrence_observation_children(account_id,parent_id,task_id,snapshot_json)
        SELECT c.account_id,c.parent_id,c.id,${snapshot('c')} FROM tasks_tasks c JOIN tasks_recurrence_observations o ON o.account_id=c.account_id AND o.task_id=c.parent_id
        WHERE c.account_id=? AND o.capture_id=? AND c.deleted_at IS NULL AND c.completed=0 ON CONFLICT(account_id,parent_id,task_id) DO NOTHING`,
          )
          .bind(accountId, captureId),
      );
    }
    for (const incoming of records) {
      const old = oldByProvider.get(incoming.id);
      const clears = options.clearedFields?.get(incoming.id);
      const oldCapabilities =
        old && options.preserveMissingFields
          ? (JSON.parse(old.capabilities_json) as Partial<TaskCapabilities>)
          : null;
      const task: GoogleTaskDTO =
        options.preserveMissingFields && old
          ? {
              ...incoming,
              title: incoming.title ?? old.title,
              notes: incoming.notes ?? old.notes,
              status: incoming.status ?? (old.completed ? 'completed' : 'needsAction'),
              ...(incoming.assignmentInfo === undefined && oldCapabilities?.assignmentSource
                ? {
                    assignmentInfo: {
                      surfaceType:
                        oldCapabilities.assignmentSource === 'docs' ? 'DOCUMENT' : 'SPACE',
                      ...(oldCapabilities.sourceUrl
                        ? { linkToTask: oldCapabilities.sourceUrl }
                        : {}),
                    },
                  }
                : {}),
              ...(incoming.parent === undefined &&
              !clears?.has('parent') &&
              old.provider_parent_id !== null
                ? { parent: old.provider_parent_id }
                : {}),
              ...(incoming.due === undefined && !clears?.has('due') && old.scheduled_day !== null
                ? { due: old.scheduled_day + 'T00:00:00Z' }
                : {}),
              ...(incoming.completed === undefined &&
              !clears?.has('completed') &&
              old.completed_at !== null
                ? { completed: old.completed_at }
                : {}),
            }
          : incoming;
      const id = taskIds.get(task.id)!;
      const providerVersion = await providerProjectionVersion(
        task.etag ? { etag: task.etag } : task.updated ? { updated: task.updated, task } : task,
      );
      const completed = task.status === 'completed';
      const day = task.due?.slice(0, 10) ?? null;
      const parentId =
        task.parent && task.parent !== task.id
          ? (taskIds.get(task.parent) ??
            (old?.provider_parent_id === task.parent ? old.parent_id : null))
          : null;
      const parent = task.parent ? oldByProvider.get(task.parent) : undefined;
      const parentInput = task.parent ? records.find((item) => item.id === task.parent) : undefined;
      const unsupported = Boolean(
        task.parent &&
        (!parentId ||
          task.parent === task.id ||
          parent?.provider_parent_id ||
          parentInput?.parent ||
          childParents.has(id) ||
          records.some((child) => child.parent === task.id && !child.deleted) ||
          (options.preserveMissingFields &&
            task.parent === old?.provider_parent_id &&
            old.unsupported_hierarchy)),
      );
      const emit = (kind: HistoryEventInput['kind'], summary: Record<string, unknown>) => {
        if (!options.observed) return;
        events.push(
          this.options.history.eventWrite({
            id: this.id(),
            accountId,
            taskId: id,
            listId,
            kind,
            origin: 'observed',
            dedupKey: `sync:${id}:${providerVersion}:${kind}`,
            recordedAt: new Date(at).toISOString(),
            providerAt: task.updated ?? null,
            taskTitle: [...(task.title ?? old?.title ?? '')].slice(0, 1_024).join(''),
            listTitle: [...list.title].slice(0, 1_024).join(''),
            summary: { providerVersion, ...summary },
          } as HistoryEventInput),
        );
      };
      if (
        old &&
        old.deleted_at === null &&
        options.observed &&
        !task.deleted &&
        old.completed !== Number(completed) &&
        old.repeat_rule_json &&
        old.parent_id === null
      ) {
        const transitionId = `${id}:${providerVersion}:${completed ? 'completed' : 'reopened'}`;
        captures.push(
          this.db
            .prepare(
              `INSERT INTO tasks_recurrence_transitions(id,account_id,task_id,provider_version,kind,snapshot_json,children_complete,observed_at)
          SELECT ?,t.account_id,t.id,?,?,COALESCE(o.snapshot_json,${snapshot('t')}),COALESCE(o.children_complete,CASE WHEN l.tasks_complete_at IS NOT NULL AND l.completed_complete_at IS NOT NULL AND l.sync_cursor IS NULL THEN 1 ELSE 0 END),?
          FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id LEFT JOIN tasks_recurrence_observations o ON o.account_id=t.account_id AND o.task_id=t.id AND o.scan_id=? WHERE t.account_id=? AND t.id=?
          ON CONFLICT(account_id,task_id,provider_version,kind) DO NOTHING`,
            )
            .bind(
              transitionId,
              providerVersion,
              completed ? 'completed' : 'reopened',
              at,
              scanId,
              accountId,
              id,
            ),
        );
        captures.push(
          this.db
            .prepare(
              `INSERT INTO tasks_recurrence_transition_children(transition_id,task_id,snapshot_json)
          SELECT ?,c.task_id,c.snapshot_json FROM tasks_recurrence_observation_children c JOIN tasks_recurrence_observations o ON o.account_id=c.account_id AND o.task_id=c.parent_id WHERE c.account_id=? AND c.parent_id=? AND o.scan_id=?
          UNION ALL SELECT ?,c.id,${snapshot('c')} FROM tasks_tasks c WHERE c.account_id=? AND c.parent_id=? AND c.deleted_at IS NULL AND c.completed=0 AND NOT EXISTS(SELECT 1 FROM tasks_recurrence_observations o WHERE o.account_id=c.account_id AND o.task_id=c.parent_id AND o.scan_id=?)
          ON CONFLICT(transition_id,task_id) DO NOTHING`,
            )
            .bind(transitionId, accountId, id, scanId, transitionId, accountId, id, scanId),
        );
      }
      if (task.deleted) {
        if (!old || old.deleted_at !== null) continue;
        writes.push(...this.retireTaskWrites(accountId, id, at));
        emit('task_deleted', {
          parentId: old.parent_id,
          knownSubtaskCount:
            (
              await this.db
                .prepare(
                  'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND parent_id=? AND deleted_at IS NULL',
                )
                .bind(accountId, id)
                .first<{ n: number }>()
            )?.n ?? 0,
        });
        continue;
      }
      if (old?.repeat_rule_json && (day === null || task.parent !== undefined)) {
        writes.push(
          this.db
            .prepare(
              `INSERT INTO tasks_schedule_pauses(account_id,task_id,rule_json,reason,paused_at,provider_version) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,task_id) DO UPDATE SET rule_json=excluded.rule_json,reason=excluded.reason,paused_at=excluded.paused_at,provider_version=excluded.provider_version`,
            )
            .bind(
              accountId,
              id,
              old.repeat_rule_json,
              day === null ? 'provider_day_removed' : 'provider_nested_task',
              at,
              providerVersion,
            ),
        );
        writes.push(
          this.db
            .prepare(
              "UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE account_id=? AND task_id=? AND state IN ('captured','pending')",
            )
            .bind(accountId, id),
        );
      }
      const title = task.title ?? '';
      const notes = task.notes ?? '';
      const cap = JSON.stringify(capabilities(task, unsupported));
      writes.push(
        this.db
          .prepare(
            `INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,provider_parent_id,provider_etag,provider_position,provider_updated_at,title,title_key,notes,search_text,completed,completed_at,scheduled_day,capabilities_json,unsupported_hierarchy,revision,last_seen_scan,provider_hidden)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT(id) DO UPDATE SET list_id=excluded.list_id,provider_id=excluded.provider_id,parent_id=excluded.parent_id,provider_parent_id=excluded.provider_parent_id,provider_etag=excluded.provider_etag,
          provider_position=excluded.provider_position,provider_updated_at=excluded.provider_updated_at,title=excluded.title,title_key=excluded.title_key,notes=excluded.notes,search_text=excluded.search_text,
          completed=excluded.completed,completed_at=excluded.completed_at,scheduled_day=excluded.scheduled_day,
          scheduled_time=CASE WHEN excluded.scheduled_day IS NULL THEN NULL ELSE tasks_tasks.scheduled_time END,
          time_zone=CASE WHEN excluded.scheduled_day IS NULL THEN NULL ELSE tasks_tasks.time_zone END,
          repeat_rule_json=CASE WHEN excluded.scheduled_day IS NULL OR excluded.provider_parent_id IS NOT NULL THEN NULL ELSE tasks_tasks.repeat_rule_json END,
          capabilities_json=excluded.capabilities_json,unsupported_hierarchy=excluded.unsupported_hierarchy,
          revision=tasks_tasks.revision+CASE WHEN tasks_tasks.list_id IS NOT excluded.list_id OR tasks_tasks.provider_etag IS NOT excluded.provider_etag OR tasks_tasks.provider_updated_at IS NOT excluded.provider_updated_at OR tasks_tasks.title IS NOT excluded.title OR tasks_tasks.notes IS NOT excluded.notes OR tasks_tasks.completed IS NOT excluded.completed OR tasks_tasks.completed_at IS NOT excluded.completed_at OR tasks_tasks.scheduled_day IS NOT excluded.scheduled_day OR tasks_tasks.parent_id IS NOT excluded.parent_id OR tasks_tasks.provider_position IS NOT excluded.provider_position OR tasks_tasks.capabilities_json IS NOT excluded.capabilities_json OR tasks_tasks.provider_missing_at IS NOT NULL THEN 1 ELSE 0 END,
          last_seen_scan=COALESCE(excluded.last_seen_scan,tasks_tasks.last_seen_scan),provider_hidden=excluded.provider_hidden,provider_missing_at=NULL,deleted_at=NULL WHERE tasks_tasks.account_id=excluded.account_id`,
          )
          .bind(
            id,
            accountId,
            listId,
            parentId,
            task.id,
            task.parent ?? null,
            task.etag ?? null,
            task.position ?? null,
            task.updated ?? null,
            title,
            normalizeTaskSearchText(title),
            notes,
            normalizeTaskSearchText(title + '\n' + notes),
            Number(completed),
            task.completed ?? null,
            day,
            cap,
            Number(unsupported),
            options.scanId ?? null,
            Number(
              task.hidden ??
                (Boolean(options.preserveMissingFields) && Boolean(old?.provider_hidden)),
            ),
          ),
      );
      if (!old && !options.baseline) emit('task_created', {});
      if (old && old.deleted_at === null) {
        if (old.completed !== Number(completed))
          emit(
            completed ? 'task_completed' : 'task_reopened',
            completed
              ? { completedAt: task.completed ?? null }
              : { previousCompletedAt: old.completed_at },
          );
        if (old.scheduled_day !== day)
          emit('scheduled_day_changed', { before: old.scheduled_day, after: day });
        if (old.list_id !== listId || old.parent_id !== parentId)
          emit('task_moved', {
            from: { listId: old.list_id, parentId: old.parent_id },
            to: { listId, parentId },
          });
      }
    }
    // A parent can arrive on a later provider page. Preserve the original provider address until then.
    for (const task of records.filter((task) => !task.deleted && !task.parent))
      writes.push(
        this.db
          .prepare(
            `UPDATE tasks_tasks SET parent_id=?,unsupported_hierarchy=0,
      capabilities_json=json_set(capabilities_json,'$.canEdit',json('true'),'$.canEditNotes',json(CASE WHEN json_extract(capabilities_json,'$.assignmentSource')='docs' THEN 'false' ELSE 'true' END),'$.canMove',json('true'),'$.canDelete',json('true'),'$.canHaveChildren',json(CASE WHEN json_extract(capabilities_json,'$.assignmentSource') IS NULL THEN 'true' ELSE 'false' END),'$.canNest',json(CASE WHEN json_extract(capabilities_json,'$.assignmentSource') IS NULL THEN 'true' ELSE 'false' END),'$.restriction',CASE WHEN json_extract(capabilities_json,'$.assignmentSource') IS NULL THEN NULL ELSE 'google limits nesting for assigned tasks; deleting also removes the source assignment' END),revision=revision+1
      WHERE account_id=? AND list_id=? AND provider_parent_id=? AND id<>? AND (parent_id IS NOT ? OR unsupported_hierarchy=1) AND deleted_at IS NULL AND provider_missing_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM tasks_tasks descendant WHERE descendant.account_id=tasks_tasks.account_id AND descendant.parent_id=tasks_tasks.id AND descendant.deleted_at IS NULL)`,
          )
          .bind(
            taskIds.get(task.id)!,
            accountId,
            listId,
            task.id,
            taskIds.get(task.id)!,
            taskIds.get(task.id)!,
          ),
      );
    for (const task of records.filter((task) => !task.deleted && task.parent))
      writes.push(
        this.db
          .prepare(
            `UPDATE tasks_tasks SET unsupported_hierarchy=1,
      capabilities_json=json_set(capabilities_json,'$.canEdit',json('false'),'$.canEditNotes',json('false'),'$.canMove',json('false'),'$.canDelete',json('false'),'$.canHaveChildren',json('false'),'$.canNest',json('false'),'$.restriction','the provider hierarchy cannot be safely edited in lanes'),revision=revision+1
      WHERE account_id=? AND list_id=? AND parent_id=? AND deleted_at IS NULL AND unsupported_hierarchy=0`,
          )
          .bind(accountId, listId, taskIds.get(task.id)!),
      );
    return { writes: [...captures, ...writes, ...events], taskIds };
  }
  retireTaskWrites(accountId: string, taskId: string, at: number): D1PreparedStatement[] {
    const affected = 'SELECT id FROM tasks_tasks WHERE account_id=? AND (id=? OR parent_id=?)';
    const scope = `WITH affected AS (${affected})`;
    return [
      this.db
        .prepare(
          `${scope} UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=? AND EXISTS(SELECT 1 FROM tasks_dependencies d WHERE d.account_id=? AND (d.task_id IN(SELECT id FROM affected) OR d.blocker_id IN(SELECT id FROM affected)))`,
        )
        .bind(accountId, taskId, taskId, accountId, accountId),
      this.db
        .prepare(
          `${scope} UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id IN(SELECT t.list_id FROM tasks_tasks t JOIN tasks_dependencies d ON d.account_id=t.account_id AND d.task_id=t.id WHERE t.account_id=? AND t.deleted_at IS NULL AND t.id NOT IN(SELECT id FROM affected) AND d.blocker_id IN(SELECT id FROM affected))`,
        )
        .bind(accountId, taskId, taskId, accountId, accountId),
      this.db
        .prepare(
          `${scope} UPDATE tasks_tasks SET revision=revision+1 WHERE account_id=? AND deleted_at IS NULL AND id NOT IN(SELECT id FROM affected) AND id IN(SELECT d.task_id FROM tasks_dependencies d WHERE d.account_id=? AND d.blocker_id IN(SELECT id FROM affected))`,
        )
        .bind(accountId, taskId, taskId, accountId, accountId),
      this.db
        .prepare(`DELETE FROM tasks_task_labels WHERE account_id=? AND task_id IN (${affected})`)
        .bind(accountId, accountId, taskId, taskId),
      this.db
        .prepare(
          `DELETE FROM tasks_dependencies WHERE account_id=? AND (task_id IN (${affected}) OR blocker_id IN (${affected}))`,
        )
        .bind(accountId, accountId, taskId, taskId, accountId, taskId, taskId),
      this.db
        .prepare(
          `DELETE FROM tasks_schedule_pauses WHERE account_id=? AND task_id IN (${affected})`,
        )
        .bind(accountId, accountId, taskId, taskId),
      this.db
        .prepare(
          `UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE account_id=? AND task_id IN (${affected}) AND state='pending'`,
        )
        .bind(accountId, accountId, taskId, taskId),
      this.db
        .prepare(
          "UPDATE tasks_tasks SET deleted_at=?,repeat_rule_json=NULL,scheduled_time=NULL,time_zone=NULL,priority='none',starred=0,revision=revision+1 WHERE account_id=? AND (id=? OR parent_id=?) AND deleted_at IS NULL",
        )
        .bind(at, accountId, taskId, taskId),
    ];
  }
}
