import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../contracts/errors';
import type { HistoryService } from '../../history/server';
import type { HistoryEventInput } from '../../history/contracts';
import { ResourceIdSchema, type TaskCapabilities, type TaskList } from '../contracts';
import { normalizeTaskSearchText } from '../model';
import {
  RefreshRequestSchema,
  type RefreshRequest,
  type SyncAdvance,
  type SyncStatus,
} from '../sync-contract';
export type { RefreshRequest, SyncAdvance, SyncStatus } from '../sync-contract';
import {
  GoogleTasksError,
  type GoogleTaskDTO,
  type GoogleTaskListDTO,
  type GoogleTasksClient,
} from './provider';
export type SyncReader = Pick<
  GoogleTasksClient,
  'getTaskList' | 'listTaskLists' | 'listTasks' | 'getTask'
>;
export interface TaskSyncOptions {
  clientFor(accountId: string): Promise<SyncReader>;
  history: HistoryService;
  placementWrites?(list: TaskList, defaultStatusChanged: boolean): D1PreparedStatement[];
  removalWrites?(accountId: string, listId: string): D1PreparedStatement[];
  refreshRejectedToken?(accountId: string, reader: SyncReader): Promise<void>;
  now?: () => number;
  id?: () => string;
}

interface ListRow {
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
interface Job {
  account_id: string;
  claim_id: string | null;
  claim_until: number | null;
  default_pending: number;
  inventory_pending: number;
  task_turn: number;
  attempts: number;
  auth_refresh_attempted: number;
}
interface Work {
  account_id: string;
  list_id: string;
  mode: 'full' | 'delta' | null;
  page_token: string | null;
  scan_id: string | null;
  started_at: number | null;
  updated_min: string | null;
}
const listFields =
  'id,account_id,provider_id,provider_etag,title,is_default,revision,projection_revision,tasks_complete_at,completed_complete_at,last_full_sync_at,sync_watermark,sync_cursor,deleted_at';
const leaseMs = 45_000;
const fullInterval = 30 * 60_000;
const noCapturedCommand = (account: string, list: string): string =>
  `NOT EXISTS(SELECT 1 FROM tasks_command_resources resources JOIN tasks_operations operation ON operation.id=resources.operation_id WHERE operation.account_id=${account} AND resources.list_id=${list} AND operation.state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain'))`;
function identity(value: string): void {
  if (!ResourceIdSchema.max(1_024).safeParse(value).success)
    throw new AppError(
      'validation_failed',
      'provide an explicit account or resource identity',
      422,
    );
}
function listModel(row: ListRow): TaskList {
  return {
    id: row.id,
    accountId: row.account_id,
    providerId: row.provider_id,
    providerEtag: row.provider_etag,
    title: row.title,
    isDefault: row.is_default === 1,
    revision: row.revision,
  };
}
async function version(value: unknown): Promise<string> {
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
    private readonly options: Pick<TaskSyncOptions, 'history' | 'now' | 'id'>,
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
    identity(accountId);
    identity(taskId);
    identity(operationId);
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
    identity(accountId);
    identity(taskId);
    identity(operationId);
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
    identity(accountId);
    identity(taskId);
    identity(operationId);
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
    identity(accountId);
    identity(listId);
    if (records.length > 5)
      throw new AppError(
        'validation_failed',
        'reconcile at most five task records in one slice',
        422,
      );
    const list = await this.db
      .prepare(
        `SELECT ${listFields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(accountId, listId)
      .first<ListRow>();
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
        identity(lanesId);
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
      const providerVersion = await version(
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
export class TaskSyncService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly projection: TaskProjectionStore;
  constructor(
    private readonly db: D1Database,
    private readonly options: TaskSyncOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.projection = new TaskProjectionStore(db, options);
  }
  private async batch(writes: D1PreparedStatement[]): Promise<void> {
    try {
      const results = await this.db.batch(writes);
      if (results.some((result) => !result.success)) throw new Error();
    } catch {
      throw new AppError(
        'storage_unavailable',
        'the sync page could not be committed; its checkpoint was retained',
        503,
        true,
      );
    }
  }
  private guard(job: Job, list?: ListRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_write_guards(valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM tasks_sync_jobs WHERE account_id=? AND claim_id=? AND claim_until>?) ${list ? 'AND EXISTS (SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND projection_revision=? AND deleted_at IS NULL)' : ''} THEN 1 ELSE 0 END WHERE NOT (EXISTS (SELECT 1 FROM tasks_sync_jobs WHERE account_id=? AND claim_id=? AND claim_until>?) ${list ? 'AND EXISTS (SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND projection_revision=? AND deleted_at IS NULL)' : ''})`,
      )
      .bind(
        job.account_id,
        job.claim_id,
        this.now(),
        ...(list ? [list.account_id, list.id, list.projection_revision] : []),
        job.account_id,
        job.claim_id,
        this.now(),
        ...(list ? [list.account_id, list.id, list.projection_revision] : []),
      );
  }
  private async commit(job: Job, writes: D1PreparedStatement[], list?: ListRow): Promise<void> {
    try {
      await this.batch([this.guard(job, list), ...writes]);
    } catch (error) {
      const still = await this.db
        .prepare('SELECT claim_id,claim_until FROM tasks_sync_jobs WHERE account_id=?')
        .bind(job.account_id)
        .first<{ claim_id: string | null; claim_until: number | null }>();
      const current = list
        ? await this.db
            .prepare(
              'SELECT projection_revision,deleted_at FROM tasks_lists WHERE account_id=? AND id=?',
            )
            .bind(list.account_id, list.id)
            .first<{ projection_revision: number; deleted_at: number | null }>()
        : null;
      if (
        still?.claim_id !== job.claim_id ||
        (still?.claim_until ?? 0) <= this.now() ||
        (list &&
          (current?.projection_revision !== list.projection_revision ||
            current?.deleted_at !== null))
      )
        throw new AppError(
          'conflict',
          'the task projection changed while google was being read; refresh this slice',
          409,
        );
      throw error;
    }
  }
  private enqueueLists(accountId: string, at: number, visible: string[] = []): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO tasks_sync_list_work(account_id,list_id,priority,next_at)
      SELECT account_id,id,CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END,? FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL
      ON CONFLICT(account_id,list_id) DO UPDATE SET priority=MIN(tasks_sync_list_work.priority,excluded.priority),next_at=MIN(tasks_sync_list_work.next_at,excluded.next_at)`,
      )
      .bind(JSON.stringify(visible), at, accountId);
  }
  async getStatus(accountId: string): Promise<SyncStatus> {
    identity(accountId);
    const state = await this.db
      .prepare(
        `SELECT CASE WHEN inventory_complete_at IS NOT NULL AND inventory_cursor IS NULL
      AND EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND is_default=1 AND deleted_at IS NULL AND provider_missing_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL AND (tasks_complete_at IS NULL OR completed_complete_at IS NULL OR sync_cursor IS NOT NULL OR provider_missing_at IS NOT NULL)) THEN 1 ELSE 0 END AS initialized FROM tasks_account_state WHERE account_id=?`,
      )
      .bind(accountId, accountId, accountId)
      .first<{ initialized: number }>();
    const job = await this.db
      .prepare(
        'SELECT next_at,default_pending,inventory_pending,error_code FROM tasks_sync_jobs WHERE account_id=?',
      )
      .bind(accountId)
      .first<{
        next_at: number;
        default_pending: number;
        inventory_pending: number;
        error_code: string | null;
      }>();
    const check =
      job && !job.default_pending && !job.inventory_pending
        ? await this.db
            .prepare(
              'SELECT kind FROM tasks_sync_checks WHERE account_id=? ORDER BY next_at,kind,resource_id LIMIT 1',
            )
            .bind(accountId)
            .first<{ kind: 'list' | 'task' }>()
        : null;
    const work =
      job && !job.default_pending && !job.inventory_pending
        ? await this.db
            .prepare('SELECT list_id FROM tasks_sync_list_work WHERE account_id=? LIMIT 1')
            .bind(accountId)
            .first()
        : null;
    return {
      initialized: state?.initialized === 1,
      pending: Boolean(job),
      nextAttemptAt: job && job.next_at < Number.MAX_SAFE_INTEGER ? job.next_at : null,
      phase: !job
        ? 'idle'
        : job.default_pending
          ? 'default'
          : job.inventory_pending
            ? 'inventory'
            : work
              ? 'tasks'
              : check?.kind === 'list'
                ? 'list_check'
                : check
                  ? 'task_check'
                  : 'idle',
      errorCode: job?.error_code ?? null,
    };
  }
  async requestRefresh(
    accountId: string,
    request: RefreshRequest,
  ): Promise<{ coalesced: boolean }> {
    identity(accountId);
    const parsed = RefreshRequestSchema.safeParse(request);
    if (!parsed.success) throw new AppError('validation_failed', 'check the refresh request', 422);
    const at = this.now();
    const state = await this.db
      .prepare('SELECT foreground_refresh_at FROM tasks_account_state WHERE account_id=?')
      .bind(accountId)
      .first<{ foreground_refresh_at: number | null }>();
    const job = await this.db
      .prepare('SELECT account_id FROM tasks_sync_jobs WHERE account_id=?')
      .bind(accountId)
      .first();
    const window =
      request.reason === 'manual'
        ? 5_000
        : request.reason === 'entry' || request.reason === 'stale'
          ? 60_000
          : 0;
    if (
      job ||
      (state?.foreground_refresh_at !== null &&
        state?.foreground_refresh_at !== undefined &&
        at - state.foreground_refresh_at < window)
    ) {
      if (job && (request.reason === 'reconnect' || request.reason === 'list_change'))
        await this.batch([
          this.db
            .prepare(
              'UPDATE tasks_sync_jobs SET next_at=?,error_code=NULL,attempts=0,default_pending=1,inventory_pending=1 WHERE account_id=? AND (claim_until IS NULL OR claim_until<=?)',
            )
            .bind(at, accountId, at),
          this.db
            .prepare(
              'UPDATE tasks_account_state SET inventory_scan_id=COALESCE(inventory_scan_id,?) WHERE account_id=?',
            )
            .bind(this.id(), accountId),
          this.enqueueLists(accountId, at, request.visibleListIds),
        ]);
      if (request.visibleListIds?.length)
        await this.db
          .prepare(
            'UPDATE tasks_sync_list_work SET priority=0 WHERE account_id=? AND list_id IN (SELECT value FROM json_each(?))',
          )
          .bind(accountId, JSON.stringify(request.visibleListIds))
          .run();
      return { coalesced: true };
    }
    await this.batch([
      this.db
        .prepare(
          'INSERT INTO tasks_account_state(account_id) VALUES (?) ON CONFLICT(account_id) DO NOTHING',
        )
        .bind(accountId),
      this.db.prepare('UPDATE tasks_sync_fairness SET turn=turn+1 WHERE singleton=1'),
      this.db
        .prepare(
          'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,manual_at,fairness_order) SELECT ?,?,?,?,turn FROM tasks_sync_fairness WHERE singleton=1 ON CONFLICT(account_id) DO NOTHING',
        )
        .bind(accountId, at, at, request.reason === 'manual' ? at : null),
      this.db
        .prepare(
          'UPDATE tasks_account_state SET foreground_refresh_at=?,inventory_scan_id=COALESCE(inventory_scan_id,?) WHERE account_id=?',
        )
        .bind(at, this.id(), accountId),
      this.enqueueLists(accountId, at, request.visibleListIds),
    ]);
    return { coalesced: false };
  }
  async requestTaskCheck(accountId: string, taskId: string): Promise<void> {
    identity(accountId);
    identity(taskId);
    const at = this.now();
    const task = await this.db
      .prepare('SELECT id FROM tasks_tasks WHERE account_id=? AND id=? AND deleted_at IS NULL')
      .bind(accountId, taskId)
      .first();
    if (!task)
      throw new AppError('not_found', 'the tracked task is not available in this account', 404);
    await this.batch([
      this.db
        .prepare(
          "INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) VALUES (?,'task',?,?) ON CONFLICT(account_id,kind,resource_id) DO UPDATE SET next_at=MIN(next_at,excluded.next_at)",
        )
        .bind(accountId, taskId, at),
      this.db.prepare('UPDATE tasks_sync_fairness SET turn=turn+1 WHERE singleton=1'),
      this.db
        .prepare(
          'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending,fairness_order) SELECT ?,?,?,0,0,turn FROM tasks_sync_fairness WHERE singleton=1 ON CONFLICT(account_id) DO UPDATE SET next_at=MIN(next_at,excluded.next_at)',
        )
        .bind(accountId, at, at),
    ]);
  }
  async advanceNext(): Promise<SyncAdvance> {
    const row = await this.db
      .prepare(
        'SELECT account_id FROM tasks_sync_jobs WHERE next_at<=? AND (claim_until IS NULL OR claim_until<=?) ORDER BY fairness_order,account_id LIMIT 1',
      )
      .bind(this.now(), this.now())
      .first<{ account_id: string }>();
    return row
      ? this.advance(row.account_id)
      : { accountId: null, phase: 'idle', continued: false };
  }
  async advance(accountId: string): Promise<SyncAdvance> {
    identity(accountId);
    const at = this.now();
    const claim = this.id();
    const job = await this.db
      .prepare(
        'UPDATE tasks_sync_jobs SET claim_id=?,claim_until=? WHERE account_id=? AND next_at<=? AND (claim_until IS NULL OR claim_until<=?) RETURNING *',
      )
      .bind(claim, at + leaseMs, accountId, at, at)
      .first<Job>();
    if (!job) {
      const exists = await this.db
        .prepare('SELECT account_id FROM tasks_sync_jobs WHERE account_id=?')
        .bind(accountId)
        .first();
      return { accountId, phase: exists ? 'coalesced' : 'idle', continued: Boolean(exists) };
    }
    let phase: SyncAdvance['phase'] = 'idle';
    let reader: SyncReader | undefined;
    try {
      const getReader = async () => (reader ??= await this.options.clientFor(accountId));
      const work = await this.db
        .prepare(
          `SELECT w.* FROM tasks_sync_list_work w WHERE w.account_id=? AND w.next_at<=? AND ${noCapturedCommand('w.account_id', 'w.list_id')} ORDER BY w.priority,w.next_at,w.list_id LIMIT 1`,
        )
        .bind(accountId, at)
        .first<Work>();
      if (job.default_pending) {
        phase = 'default';
        await this.defaultSlice(job, await getReader());
      } else if (job.inventory_pending && (!job.task_turn || !work)) {
        phase = 'inventory';
        await this.inventorySlice(job, await getReader());
      } else if (work) {
        phase = 'tasks';
        await this.taskSlice(job, await getReader(), work);
      } else {
        const check = await this.db
          .prepare(
            `SELECT c.kind,c.resource_id FROM tasks_sync_checks c WHERE c.account_id=? AND c.next_at<=? AND ${noCapturedCommand('c.account_id', "CASE WHEN c.kind='list' THEN c.resource_id ELSE (SELECT t.list_id FROM tasks_tasks t WHERE t.account_id=c.account_id AND t.id=c.resource_id) END")} ORDER BY c.next_at,c.kind,c.resource_id LIMIT 1`,
          )
          .bind(accountId, at)
          .first<{ kind: 'list' | 'task'; resource_id: string }>();
        if (check) {
          phase = check.kind === 'list' ? 'list_check' : 'task_check';
          await this.checkSlice(job, await getReader(), check);
        }
      }
      const pending = await this.db
        .prepare(
          `SELECT 1 AS n FROM tasks_sync_jobs WHERE account_id=? AND (default_pending=1 OR inventory_pending=1 OR EXISTS (SELECT 1 FROM tasks_sync_list_work WHERE account_id=?) OR EXISTS (SELECT 1 FROM tasks_sync_checks WHERE account_id=?))`,
        )
        .bind(accountId, accountId, accountId)
        .first();
      await this.commit(job, [
        this.db.prepare('UPDATE tasks_sync_fairness SET turn=turn+1 WHERE singleton=1'),
        pending
          ? this.db
              .prepare(
                'UPDATE tasks_sync_jobs SET claim_id=NULL,claim_until=NULL,next_at=?,requested_at=?,fairness_order=(SELECT turn FROM tasks_sync_fairness WHERE singleton=1),attempts=0,auth_refresh_attempted=0,error_code=NULL WHERE account_id=? AND claim_id=?',
              )
              .bind(phase === 'idle' ? at + 1_000 : at, at, accountId, claim)
          : this.db
              .prepare('DELETE FROM tasks_sync_jobs WHERE account_id=? AND claim_id=?')
              .bind(accountId, claim),
      ]);
      return { accountId, phase, continued: Boolean(pending) };
    } catch (initialError) {
      let error = initialError;
      if (
        error instanceof GoogleTasksError &&
        error.code === 'reconnect_required' &&
        reader &&
        this.options.refreshRejectedToken &&
        job.auth_refresh_attempted === 0
      ) {
        try {
          await this.options.refreshRejectedToken(accountId, reader);
          await this.db
            .prepare(
              'UPDATE tasks_sync_jobs SET claim_id=NULL,claim_until=NULL,next_at=?,auth_refresh_attempted=1,error_code=NULL WHERE account_id=? AND claim_id=?',
            )
            .bind(this.now() + 1_000, accountId, claim)
            .run();
          return { accountId, phase, continued: true };
        } catch (refreshError) {
          error = refreshError;
        }
      }
      const code =
        error instanceof AppError || error instanceof GoogleTasksError
          ? error.code
          : 'storage_unavailable';
      const retryable =
        error instanceof GoogleTasksError
          ? error.retryable
          : error instanceof AppError
            ? error.retryable || error.code === 'conflict'
            : true;
      const delay =
        error instanceof GoogleTasksError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1_000
          : Math.min(300_000, 1_000 * 2 ** Math.min(job.attempts, 8)) +
            Math.floor(Math.random() * 500);
      await this.db
        .prepare(
          'UPDATE tasks_sync_jobs SET claim_id=NULL,claim_until=NULL,next_at=?,attempts=attempts+1,error_code=? WHERE account_id=? AND claim_id=?',
        )
        .bind(retryable ? this.now() + delay : Number.MAX_SAFE_INTEGER, code, accountId, claim)
        .run();
      if (error instanceof AppError) throw error;
      if (error instanceof GoogleTasksError)
        throw new AppError(
          error.code,
          error.message,
          error.status === 404 ? 404 : error.code === 'reconnect_required' ? 401 : 503,
          error.retryable,
        );
      throw new AppError(
        'storage_unavailable',
        'sync could not advance; retained data and its checkpoint are unchanged',
        503,
        true,
      );
    }
  }
  private async inventoryGuard(accountId: string): Promise<D1PreparedStatement> {
    const row = await this.db
      .prepare(
        'SELECT COALESCE(SUM(projection_revision),0) AS total,COUNT(*) AS n FROM tasks_lists WHERE account_id=?',
      )
      .bind(accountId)
      .first<{ total: number; n: number }>();
    return this.db
      .prepare(
        `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE (SELECT COALESCE(SUM(projection_revision),0) FROM tasks_lists WHERE account_id=?)<>? OR (SELECT COUNT(*) FROM tasks_lists WHERE account_id=?)<>?`,
      )
      .bind(accountId, row?.total ?? 0, accountId, row?.n ?? 0);
  }
  private async prepareList(
    accountId: string,
    dto: GoogleTaskListDTO,
    scanId: string | null,
    isDefault?: boolean,
  ): Promise<D1PreparedStatement[]> {
    const old = await this.db
      .prepare(`SELECT ${listFields} FROM tasks_lists WHERE account_id=? AND provider_id=?`)
      .bind(accountId, dto.id)
      .first<ListRow>();
    const row: ListRow = old ?? {
      id: this.id(),
      account_id: accountId,
      provider_id: dto.id,
      provider_etag: null,
      title: '',
      is_default: 0,
      revision: 0,
      projection_revision: 0,
      tasks_complete_at: null,
      completed_complete_at: null,
      last_full_sync_at: null,
      sync_watermark: null,
      sync_cursor: null,
      deleted_at: null,
    };
    const defaultChanged = isDefault !== undefined && Boolean(row.is_default) !== isDefault;
    const changed =
      !old ||
      old.provider_etag !== (dto.etag ?? null) ||
      old.title !== (dto.title ?? '') ||
      defaultChanged ||
      old.deleted_at !== null;
    const mapped = {
      ...listModel(row),
      title: dto.title ?? '',
      providerEtag: dto.etag ?? null,
      isDefault: isDefault ?? Boolean(row.is_default),
      revision: row.revision + Number(changed),
    };
    const writes: D1PreparedStatement[] = [];
    if (isDefault)
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET is_default=0,revision=revision+1,projection_revision=projection_revision+1 WHERE account_id=? AND id<>? AND is_default=1',
          )
          .bind(accountId, row.id),
      );
    writes.push(
      this.db
        .prepare(
          `INSERT INTO tasks_lists(id,account_id,provider_id,provider_etag,title,title_key,is_default,revision,last_seen_scan,last_synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,provider_id) DO UPDATE SET provider_etag=excluded.provider_etag,title=excluded.title,title_key=excluded.title_key,is_default=excluded.is_default,revision=excluded.revision,projection_revision=tasks_lists.projection_revision+?,last_seen_scan=COALESCE(excluded.last_seen_scan,tasks_lists.last_seen_scan),provider_missing_at=NULL,deleted_at=NULL`,
        )
        .bind(
          row.id,
          accountId,
          dto.id,
          dto.etag ?? null,
          dto.title ?? '',
          normalizeTaskSearchText(dto.title ?? ''),
          Number(mapped.isDefault),
          mapped.revision,
          scanId,
          this.now(),
          Number(changed),
        ),
    );
    if (!old || old.deleted_at !== null || defaultChanged)
      writes.push(...(this.options.placementWrites?.(mapped, defaultChanged) ?? []));
    writes.push(
      this.db
        .prepare(
          'INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES (?,?,?) ON CONFLICT(account_id,list_id) DO NOTHING',
        )
        .bind(accountId, row.id, this.now()),
    );
    return writes;
  }
  private async defaultSlice(job: Job, reader: SyncReader): Promise<void> {
    const guard = await this.inventoryGuard(job.account_id);
    const dto = await reader.getTaskList('@default');
    await this.commit(job, [
      guard,
      ...(await this.prepareList(job.account_id, dto, null, true)),
      this.db
        .prepare('UPDATE tasks_sync_jobs SET default_pending=0 WHERE account_id=?')
        .bind(job.account_id),
    ]);
  }
  private async inventorySlice(job: Job, reader: SyncReader): Promise<void> {
    const guard = await this.inventoryGuard(job.account_id);
    const state = await this.db
      .prepare(
        'SELECT inventory_cursor,inventory_scan_id FROM tasks_account_state WHERE account_id=?',
      )
      .bind(job.account_id)
      .first<{ inventory_cursor: string | null; inventory_scan_id: string | null }>();
    const scanId = state?.inventory_scan_id ?? this.id();
    const page = await reader.listTaskLists({
      maxResults: 25,
      ...(state?.inventory_cursor ? { pageToken: state.inventory_cursor } : {}),
    });
    const writes: D1PreparedStatement[] = [guard];
    for (const dto of page.items)
      writes.push(...(await this.prepareList(job.account_id, dto, scanId)));
    writes.push(
      this.db
        .prepare(
          'UPDATE tasks_account_state SET inventory_cursor=?,inventory_scan_id=?,inventory_revision=inventory_revision+1,inventory_count=MAX(inventory_count,(SELECT COUNT(*) FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL)) WHERE account_id=?',
        )
        .bind(page.nextPageToken, scanId, job.account_id, job.account_id),
    );
    if (!page.nextPageToken) {
      writes.push(
        this.db
          .prepare(
            `INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) SELECT account_id,'list',id,? FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan<>?) ON CONFLICT(account_id,kind,resource_id) DO NOTHING`,
          )
          .bind(this.now(), job.account_id, scanId),
      );
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET provider_missing_at=? WHERE account_id=? AND deleted_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan<>?)',
          )
          .bind(this.now(), job.account_id, scanId),
      );
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_account_state SET inventory_count=(SELECT COUNT(*) FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL),inventory_complete_at=?,last_complete_scan_id=?,inventory_scan_id=NULL,inventory_cursor=NULL WHERE account_id=?',
          )
          .bind(job.account_id, this.now(), scanId, job.account_id),
      );
    }
    writes.push(
      this.db
        .prepare('UPDATE tasks_sync_jobs SET inventory_pending=?,task_turn=1 WHERE account_id=?')
        .bind(Number(Boolean(page.nextPageToken)), job.account_id),
    );
    await this.commit(job, writes);
  }
  private async resolveMovedTasks(
    accountId: string,
    reader: SyncReader,
    list: ListRow,
    records: GoogleTaskDTO[],
  ): Promise<{
    records: GoogleTaskDTO[];
    knownTaskIds: Map<string, string>;
    guards: D1PreparedStatement[];
    sourceWrites: D1PreparedStatement[];
  }> {
    const knownTaskIds = new Map<string, string>();
    const guards: D1PreparedStatement[] = [];
    const sources = new Set<string>();
    const retained: GoogleTaskDTO[] = [];
    for (const task of records) {
      const candidates = task.deleted
        ? []
        : (
            await this.db
              .prepare(
                `SELECT t.id,t.list_id,t.revision,l.provider_id AS provider_list_id,l.projection_revision
            FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
            WHERE t.account_id=? AND t.provider_id=? AND t.deleted_at IS NULL AND t.list_id<>? AND l.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM tasks_tasks current WHERE current.account_id=t.account_id AND current.list_id=? AND current.provider_id=t.provider_id)
            LIMIT 2`,
              )
              .bind(accountId, task.id, list.id, list.id)
              .all<{
                id: string;
                list_id: string;
                revision: number;
                provider_list_id: string;
                projection_revision: number;
              }>()
          ).results;
      const old = candidates.length === 1 ? candidates[0] : undefined;
      if (old) {
        let missing = false;
        try {
          await reader.getTask(old.provider_list_id, task.id);
        } catch (error) {
          if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
          missing = true;
        }
        if (!missing) {
          // A stale list page must not recreate the task at its previous address.
          try {
            const current = await reader.getTask(list.provider_id, task.id);
            if (current.deleted) continue;
          } catch (error) {
            if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
            continue;
          }
        } else {
          knownTaskIds.set(task.id, old.id);
          sources.add(old.list_id);
          guards.push(
            this.db
              .prepare(
                `INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(
              SELECT 1 FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id
              WHERE t.account_id=? AND t.id=? AND t.list_id=? AND t.provider_id=? AND t.revision=? AND t.deleted_at IS NULL
              AND l.deleted_at IS NULL AND l.projection_revision=? AND ${noCapturedCommand('t.account_id', 't.list_id')} AND ${noCapturedCommand('t.account_id', '?')})`,
              )
              .bind(
                accountId,
                old.id,
                old.list_id,
                task.id,
                old.revision,
                old.projection_revision,
                list.id,
              ),
          );
        }
      }
      retained.push(task);
    }
    const sourceWrites = [...sources].flatMap((source) => [
      this.db
        .prepare(
          'UPDATE tasks_lists SET projection_revision=projection_revision+1,tasks_complete_at=NULL,completed_complete_at=NULL WHERE account_id=? AND id=?',
        )
        .bind(accountId, source),
      this.db
        .prepare(
          `INSERT INTO tasks_sync_list_work(account_id,list_id,priority,next_at,mode) VALUES (?,?,0,?,'full')
        ON CONFLICT(account_id,list_id) DO UPDATE SET priority=0,next_at=MIN(next_at,excluded.next_at),
        mode='full',page_token=NULL,scan_id=NULL,started_at=NULL,updated_min=NULL`,
        )
        .bind(accountId, source, this.now()),
    ]);
    return { records: retained, knownTaskIds, guards, sourceWrites };
  }
  private async taskSlice(job: Job, reader: SyncReader, work: Work): Promise<void> {
    const list = await this.db
      .prepare(
        `SELECT ${listFields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(job.account_id, work.list_id)
      .first<ListRow>();
    if (!list) {
      await this.commit(job, [
        this.db
          .prepare('DELETE FROM tasks_sync_list_work WHERE account_id=? AND list_id=?')
          .bind(job.account_id, work.list_id),
      ]);
      return;
    }
    const full = work.mode
      ? work.mode === 'full'
      : list.last_full_sync_at === null ||
        this.now() - list.last_full_sync_at >= fullInterval ||
        list.tasks_complete_at === null;
    const startedAt = work.started_at ?? this.now();
    const scanId = work.scan_id ?? this.id();
    const updatedMin = full
      ? null
      : (work.updated_min ??
        (list.sync_watermark
          ? new Date(Date.parse(list.sync_watermark) - 120_000).toISOString()
          : null));
    let page;
    try {
      page = await reader.listTasks(list.provider_id, {
        // One page + at most two address checks per task + a token refresh fits ten requests.
        maxResults: 4,
        ...(work.page_token ? { pageToken: work.page_token } : {}),
        ...(updatedMin ? { updatedMin } : {}),
      });
    } catch (error) {
      if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
      await this.commit(
        job,
        [
          this.db
            .prepare(
              "INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) VALUES (?,'list',?,?) ON CONFLICT(account_id,kind,resource_id) DO NOTHING",
            )
            .bind(job.account_id, list.id, this.now()),
          this.db
            .prepare('DELETE FROM tasks_sync_list_work WHERE account_id=? AND list_id=?')
            .bind(job.account_id, list.id),
          this.db
            .prepare(
              'UPDATE tasks_lists SET provider_missing_at=?,tasks_complete_at=NULL,completed_complete_at=NULL WHERE account_id=? AND id=?',
            )
            .bind(this.now(), job.account_id, list.id),
        ],
        list,
      );
      return;
    }
    const moved = await this.resolveMovedTasks(job.account_id, reader, list, page.items);
    const projection = await this.projection.prepareConfirmedWrites(
      job.account_id,
      list.id,
      moved.records,
      {
        scanId,
        observed: true,
        baseline: list.tasks_complete_at === null,
        knownTaskIds: moved.knownTaskIds,
      },
    );
    const writes = [...moved.guards, ...projection.writes, ...moved.sourceWrites];
    if (page.nextPageToken)
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_sync_list_work SET mode=?,page_token=?,scan_id=?,started_at=?,updated_min=? WHERE account_id=? AND list_id=?',
          )
          .bind(
            full ? 'full' : 'delta',
            page.nextPageToken,
            scanId,
            startedAt,
            updatedMin,
            job.account_id,
            list.id,
          ),
      );
    else {
      writes.push(
        this.db
          .prepare('DELETE FROM tasks_sync_list_work WHERE account_id=? AND list_id=?')
          .bind(job.account_id, list.id),
      );
      writes.push(
        this.db
          .prepare('DELETE FROM tasks_recurrence_observations WHERE account_id=? AND list_id=?')
          .bind(job.account_id, list.id),
      );
      if (full) {
        writes.push(
          this.db
            .prepare(
              `INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) SELECT account_id,'task',id,? FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL AND provider_missing_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan<>?) ON CONFLICT(account_id,kind,resource_id) DO NOTHING`,
            )
            .bind(this.now(), job.account_id, list.id, scanId),
        );
        writes.push(
          this.db
            .prepare(
              `UPDATE tasks_tasks SET provider_missing_at=?,capabilities_json=json_set(capabilities_json,'$.canEdit',json('false'),'$.canEditNotes',json('false'),'$.canMove',json('false'),'$.canDelete',json('false'),'$.canHaveChildren',json('false'),'$.canNest',json('false'),'$.restriction',?),revision=revision+1 WHERE account_id=? AND list_id=? AND deleted_at IS NULL AND provider_missing_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan<>?)`,
            )
            .bind(
              this.now(),
              'google did not include this recorded address in its full scan; metadata is retained until identity is resolved',
              job.account_id,
              list.id,
              scanId,
            ),
        );
      }
    }
    writes.push(
      this.db
        .prepare(
          `UPDATE tasks_lists SET projection_revision=projection_revision+1,last_synced_at=?,sync_cursor=?,
      sync_watermark=CASE WHEN ? IS NULL THEN ? ELSE sync_watermark END,
      tasks_complete_at=CASE WHEN ? IS NULL THEN CASE WHEN NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL AND provider_missing_at IS NOT NULL) THEN ? ELSE NULL END ELSE tasks_complete_at END,
      completed_complete_at=CASE WHEN ? IS NULL THEN CASE WHEN NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL AND provider_missing_at IS NOT NULL) THEN ? ELSE NULL END ELSE completed_complete_at END,
      last_full_sync_at=CASE WHEN ?=1 AND ? IS NULL THEN ? ELSE last_full_sync_at END WHERE account_id=? AND id=?`,
        )
        .bind(
          this.now(),
          page.nextPageToken,
          page.nextPageToken,
          new Date(startedAt).toISOString(),
          page.nextPageToken,
          job.account_id,
          list.id,
          this.now(),
          page.nextPageToken,
          job.account_id,
          list.id,
          this.now(),
          Number(full),
          page.nextPageToken,
          this.now(),
          job.account_id,
          list.id,
        ),
    );
    writes.push(
      this.db
        .prepare('UPDATE tasks_sync_jobs SET task_turn=0 WHERE account_id=?')
        .bind(job.account_id),
    );
    await this.commit(job, writes, list);
  }
  private async checkSlice(
    job: Job,
    reader: SyncReader,
    check: { kind: 'list' | 'task'; resource_id: string },
  ): Promise<void> {
    const drop = this.db
      .prepare('DELETE FROM tasks_sync_checks WHERE account_id=? AND kind=? AND resource_id=?')
      .bind(job.account_id, check.kind, check.resource_id);
    if (check.kind === 'list') {
      const list = await this.db
        .prepare(
          `SELECT ${listFields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
        )
        .bind(job.account_id, check.resource_id)
        .first<ListRow>();
      if (!list) {
        await this.commit(job, [drop]);
        return;
      }
      try {
        const dto = await reader.getTaskList(list.provider_id);
        await this.commit(
          job,
          [...(await this.prepareList(job.account_id, dto, null)), drop],
          list,
        );
      } catch (error) {
        if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
        const count = await this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL',
          )
          .bind(job.account_id, list.id)
          .first<{ n: number }>();
        const providerVersion = await version({
          listId: list.provider_id,
          previousEtag: list.provider_etag,
          absent: true,
        });
        const event = this.options.history.eventWrite({
          id: this.id(),
          accountId: job.account_id,
          listId: list.id,
          kind: 'list_deleted',
          origin: 'observed',
          dedupKey: `sync:list:${list.id}:${providerVersion}:deleted`,
          recordedAt: new Date(this.now()).toISOString(),
          listTitle: [...list.title].slice(0, 1_024).join(''),
          summary: {
            providerVersion,
            knownTaskCount: count?.n ?? 0,
            coverageComplete:
              list.tasks_complete_at !== null &&
              list.completed_complete_at !== null &&
              list.sync_cursor === null,
          },
        });
        await this.commit(
          job,
          [
            this.db
              .prepare(
                'UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=? AND EXISTS(SELECT 1 FROM tasks_dependencies d WHERE d.account_id=? AND (d.task_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?) OR d.blocker_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?)))',
              )
              .bind(
                job.account_id,
                job.account_id,
                job.account_id,
                list.id,
                job.account_id,
                list.id,
              ),
            this.db
              .prepare(
                'UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id<>? AND id IN(SELECT t.list_id FROM tasks_tasks t JOIN tasks_dependencies d ON d.account_id=t.account_id AND d.task_id=t.id WHERE t.account_id=? AND t.deleted_at IS NULL AND d.blocker_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?))',
              )
              .bind(job.account_id, list.id, job.account_id, job.account_id, list.id),
            this.db
              .prepare(
                'UPDATE tasks_tasks SET revision=revision+1 WHERE account_id=? AND list_id<>? AND deleted_at IS NULL AND id IN(SELECT d.task_id FROM tasks_dependencies d WHERE d.account_id=? AND d.blocker_id IN(SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?))',
              )
              .bind(job.account_id, list.id, job.account_id, job.account_id, list.id),
            this.db
              .prepare(
                'DELETE FROM tasks_task_labels WHERE account_id=? AND task_id IN (SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?)',
              )
              .bind(job.account_id, job.account_id, list.id),
            this.db
              .prepare(
                'DELETE FROM tasks_dependencies WHERE account_id=? AND (task_id IN (SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?) OR blocker_id IN (SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?))',
              )
              .bind(job.account_id, job.account_id, list.id, job.account_id, list.id),
            this.db
              .prepare(
                'DELETE FROM tasks_schedule_pauses WHERE account_id=? AND task_id IN (SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?)',
              )
              .bind(job.account_id, job.account_id, list.id),
            this.db
              .prepare(
                "UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE account_id=? AND task_id IN (SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=?) AND state='pending'",
              )
              .bind(job.account_id, job.account_id, list.id),
            this.db
              .prepare(
                "UPDATE tasks_tasks SET deleted_at=?,repeat_rule_json=NULL,scheduled_time=NULL,time_zone=NULL,priority='none',starred=0,revision=revision+1 WHERE account_id=? AND list_id=? AND deleted_at IS NULL",
              )
              .bind(this.now(), job.account_id, list.id),
            this.db
              .prepare(
                'UPDATE tasks_lists SET deleted_at=?,projection_revision=projection_revision+1,revision=revision+1 WHERE account_id=? AND id=?',
              )
              .bind(this.now(), job.account_id, list.id),
            this.db
              .prepare('DELETE FROM tasks_sync_list_work WHERE account_id=? AND list_id=?')
              .bind(job.account_id, list.id),
            ...(this.options.removalWrites?.(job.account_id, list.id) ?? []),
            event,
            drop,
          ],
          list,
        );
      }
    } else {
      const task = await this.db
        .prepare(
          `SELECT t.id,t.list_id,t.provider_id,l.provider_id AS provider_list_id FROM tasks_tasks t JOIN tasks_lists l ON l.account_id=t.account_id AND l.id=t.list_id WHERE t.account_id=? AND t.id=? AND t.deleted_at IS NULL AND l.deleted_at IS NULL`,
        )
        .bind(job.account_id, check.resource_id)
        .first<{ id: string; list_id: string; provider_id: string; provider_list_id: string }>();
      if (!task) {
        await this.commit(job, [drop]);
        return;
      }
      const list = await this.db
        .prepare(`SELECT ${listFields} FROM tasks_lists WHERE account_id=? AND id=?`)
        .bind(job.account_id, task.list_id)
        .first<ListRow>();
      if (!list) throw new AppError('not_found', 'the tracked list is unavailable', 404);
      try {
        const dto = await reader.getTask(task.provider_list_id, task.provider_id);
        const projection = await this.projection.prepareConfirmedWrites(
          job.account_id,
          list.id,
          [dto],
          { observed: true, baseline: false },
        );
        await this.commit(
          job,
          [
            ...projection.writes,
            this.db
              .prepare(
                'UPDATE tasks_tasks SET last_provider_check_at=? WHERE account_id=? AND id=?',
              )
              .bind(this.now(), job.account_id, task.id),
            this.db
              .prepare(
                'UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=? AND id=?',
              )
              .bind(job.account_id, list.id),
            this.db
              .prepare('DELETE FROM tasks_recurrence_observations WHERE account_id=? AND list_id=?')
              .bind(job.account_id, list.id),
            drop,
          ],
          list,
        );
      } catch (error) {
        if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
        await this.commit(
          job,
          [
            this.db
              .prepare(
                `UPDATE tasks_tasks SET provider_missing_at=?,capabilities_json=json_set(capabilities_json,'$.canEdit',json('false'),'$.canEditNotes',json('false'),'$.canMove',json('false'),'$.canDelete',json('false'),'$.canHaveChildren',json('false'),'$.canNest',json('false'),'$.restriction',?),revision=revision+1 WHERE account_id=? AND id=?`,
              )
              .bind(
                this.now(),
                'google no longer returns this task at its recorded address; metadata is retained while identity is unresolved',
                job.account_id,
                task.id,
              ),
            this.db
              .prepare(
                'UPDATE tasks_lists SET tasks_complete_at=NULL,projection_revision=projection_revision+1 WHERE account_id=? AND id=?',
              )
              .bind(job.account_id, list.id),
            drop,
          ],
          list,
        );
      }
    }
  }
}
