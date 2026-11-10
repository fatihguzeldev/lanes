import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { HistoryService } from '../../../history/server/events/event-store';
import type { TaskList } from '../../contracts/task';
import { normalizeTaskSearchText } from '../../model/task';
import { captureTaskPage, retainedTaskPage, providerPageSize } from './captured-page';
import { unchangedTaskPrefixWrites } from './unchanged-page';
import {
  RefreshRequestSchema,
  type RefreshRequest,
  type SyncAdvance,
  type SyncStatus,
  type SyncForeground,
  type SyncChanges,
} from '../../contracts/sync';
export type { RefreshRequest, SyncAdvance, SyncStatus } from '../../contracts/sync';
import {
  GoogleTasksError,
  type GoogleTaskDTO,
  type GoogleTaskListDTO,
  type GoogleTasksClient,
} from '../provider/google-tasks';
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
  databaseQueries?: () => number;
  providerRequests?: () => number;
}

import {
  TaskProjectionStore,
  assertProjectionIdentity,
  providerProjectionVersion,
  projectionListFields,
  type ProjectionListRow,
} from '../projection/store';

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
  page_json: string | null;
  page_offset: number;
  page_projection_revision: number | null;
}
const leaseMs = 45_000;
const fullInterval = 30 * 60_000;
interface ForegroundRun {
  changes: SyncChanges;
  projectedRecords: number;
  maxRecords: number;
  inventoryPageSize: number;
  yielded: boolean;
  coalesced: boolean;
}
const noCapturedCommand = (account: string, list: string): string =>
  `NOT EXISTS(SELECT 1 FROM tasks_command_resources resources JOIN tasks_operations operation ON operation.id=resources.operation_id WHERE operation.account_id=${account} AND resources.list_id=${list} AND operation.state IN ('accepted','running','partial','reconnect_required','blocked_by_limit','uncertain'))`;
function listModel(row: ProjectionListRow): TaskList {
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
  private async batch(writes: D1PreparedStatement[]) {
    try {
      const results = await this.db.batch(writes);
      if (results.some((result) => !result.success)) throw new Error();
      return results;
    } catch {
      throw new AppError(
        'storage_unavailable',
        'the sync page could not be committed; its checkpoint was retained',
        503,
        true,
      );
    }
  }
  private guard(job: Job, list?: ProjectionListRow): D1PreparedStatement {
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
  private async commit(job: Job, writes: D1PreparedStatement[], list?: ProjectionListRow) {
    try {
      return await this.batch([this.guard(job, list), ...writes]);
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
    assertProjectionIdentity(accountId);
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
  /** Positioning can resequence siblings; queue their read with the confirmed write. */
  providerOrderRefreshWrites(
    accountId: string,
    listIds: readonly string[],
    reason: 'create' | 'move' = 'move',
  ): D1PreparedStatement[] {
    assertProjectionIdentity(accountId);
    const lists = [...new Set(listIds)];
    if (!lists.length || lists.length > 2)
      throw new AppError('validation_failed', 'refresh only the affected task lists.', 422);
    for (const list of lists) assertProjectionIdentity(list);
    const at = this.now();
    return [
      ...lists.flatMap((list) => [
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL)',
          )
          .bind(accountId, list),
        // A confirmed insert adds one known task; only sibling order needs repair.
        ...(reason === 'move'
          ? [
              this.db
                .prepare(
                  'UPDATE tasks_lists SET tasks_complete_at=NULL,completed_complete_at=NULL WHERE account_id=? AND id=?',
                )
                .bind(accountId, list),
            ]
          : []),
        this.db
          .prepare(
            `INSERT INTO tasks_sync_list_work(account_id,list_id,priority,next_at,mode) VALUES (?,?,0,?,'full')
          ON CONFLICT(account_id,list_id) DO UPDATE SET priority=0,next_at=MIN(next_at,excluded.next_at),
          mode='full',page_token=NULL,scan_id=NULL,started_at=NULL,updated_min=NULL,
          page_json=NULL,page_offset=0,page_projection_revision=NULL`,
          )
          .bind(accountId, list, at),
      ]),
      this.db.prepare('UPDATE tasks_sync_fairness SET turn=turn+1 WHERE singleton=1'),
      this.db
        .prepare(
          `INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending,fairness_order)
        SELECT ?,?,?,0,0,turn FROM tasks_sync_fairness WHERE singleton=1
        ON CONFLICT(account_id) DO UPDATE SET next_at=MIN(next_at,excluded.next_at),attempts=0,error_code=NULL`,
        )
        .bind(accountId, at, at),
    ];
  }
  async requestRefresh(
    accountId: string,
    request: RefreshRequest,
  ): Promise<{ coalesced: boolean }> {
    assertProjectionIdentity(accountId);
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
    assertProjectionIdentity(accountId);
    assertProjectionIdentity(taskId);
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
  async advanceForeground(accountId: string): Promise<SyncForeground> {
    assertProjectionIdentity(accountId);
    const run: ForegroundRun = {
      changes: { topology: false, tasks: false },
      projectedRecords: 0,
      maxRecords: 4,
      inventoryPageSize: 25,
      yielded: false,
      coalesced: false,
    };
    let result: SyncAdvance = { accountId, phase: 'idle', continued: false };
    const measured = Boolean(this.options.databaseQueries && this.options.providerRequests);
    const startedAt = Date.now();
    for (let step = 0; step < (measured ? 3 : 1); step++) {
      if (measured && !(await this.planForegroundStep(accountId, run))) break;
      const next = await this.advanceStep(accountId, run);
      if (next.phase !== 'idle' || result.phase === 'idle') result = next;
      if (
        !next.continued ||
        ['idle', 'coalesced'].includes(next.phase) ||
        run.yielded ||
        run.projectedRecords >= 4 ||
        Date.now() - startedAt >= 2_000
      )
        break;
    }
    if (run.coalesced && result.phase === 'idle')
      result = { accountId, phase: 'coalesced', continued: true };
    const status = await this.getStatus(accountId);
    return { ...result, status, changes: run.changes };
  }

  private async planForegroundStep(accountId: string, run: ForegroundRun): Promise<boolean> {
    const at = this.now();
    const job = await this.db
      .prepare(
        `SELECT j.default_pending,j.inventory_pending,j.task_turn,j.next_at,j.claim_until,
      EXISTS(SELECT 1 FROM tasks_sync_list_work w WHERE w.account_id=j.account_id AND w.next_at<=? AND ${noCapturedCommand('w.account_id', 'w.list_id')}) AS has_work,
      (SELECT c.kind FROM tasks_sync_checks c WHERE c.account_id=j.account_id AND c.next_at<=? AND ${noCapturedCommand('c.account_id', "CASE WHEN c.kind='list' THEN c.resource_id ELSE (SELECT t.list_id FROM tasks_tasks t WHERE t.account_id=c.account_id AND t.id=c.resource_id) END")} ORDER BY c.next_at,c.kind,c.resource_id LIMIT 1) AS check_kind
      FROM tasks_sync_jobs j WHERE j.account_id=?`,
      )
      .bind(at, at, accountId)
      .first<Job & { next_at: number; has_work: number; check_kind: 'list' | 'task' | null }>();
    if (!job) return false;
    if (job.claim_until !== null && job.claim_until > at) {
      run.coalesced = true;
      return false;
    }
    if (job.next_at > at) return false;
    // Includes credential validation/refresh, failed-commit recovery, and the final status/route tail.
    const database = 50 - this.options.databaseQueries!() - 8;
    const provider = 10 - this.options.providerRequests!();
    if (job.default_pending) return database >= 18 && provider >= 2;
    if (job.inventory_pending && (!job.task_turn || !job.has_work)) {
      run.inventoryPageSize = Math.min(25, database - 19);
      return run.inventoryPageSize >= 1 && provider >= 2;
    }
    if (job.has_work) {
      run.maxRecords = Math.max(
        0,
        Math.min(4 - run.projectedRecords, Math.floor((provider - 2) / 2), database - 24),
      );
      return provider >= 2 && database >= (run.maxRecords ? 24 + run.maxRecords : 19);
    }
    if (job.check_kind === 'task')
      return run.projectedRecords < 4 && provider >= 2 && database >= 26;
    if (job.check_kind === 'list') return provider >= 2 && database >= 19;
    return database >= 5;
  }

  async advance(accountId: string): Promise<SyncAdvance> {
    return this.advanceStep(accountId);
  }

  private async advanceStep(accountId: string, foreground?: ForegroundRun): Promise<SyncAdvance> {
    assertProjectionIdentity(accountId);
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
        await this.defaultSlice(job, await getReader(), foreground);
      } else if (job.inventory_pending && (!job.task_turn || !work)) {
        phase = 'inventory';
        await this.inventorySlice(job, await getReader(), foreground);
      } else if (work) {
        phase = 'tasks';
        await this.taskSlice(job, await getReader(), work, foreground);
      } else {
        const check = await this.db
          .prepare(
            `SELECT c.kind,c.resource_id FROM tasks_sync_checks c WHERE c.account_id=? AND c.next_at<=? AND ${noCapturedCommand('c.account_id', "CASE WHEN c.kind='list' THEN c.resource_id ELSE (SELECT t.list_id FROM tasks_tasks t WHERE t.account_id=c.account_id AND t.id=c.resource_id) END")} ORDER BY c.next_at,c.kind,c.resource_id LIMIT 1`,
          )
          .bind(accountId, at)
          .first<{ kind: 'list' | 'task'; resource_id: string }>();
        if (check) {
          phase = check.kind === 'list' ? 'list_check' : 'task_check';
          await this.checkSlice(job, await getReader(), check, foreground);
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
          if (
            foreground &&
            this.options.databaseQueries &&
            this.options.providerRequests &&
            (this.options.databaseQueries() + 17 > 50 || this.options.providerRequests() >= 10)
          ) {
            await this.db
              .prepare(
                'UPDATE tasks_sync_jobs SET claim_id=NULL,claim_until=NULL,next_at=? WHERE account_id=? AND claim_id=?',
              )
              .bind(this.now() + 1_000, accountId, claim)
              .run();
            foreground.yielded = true;
            return { accountId, phase, continued: true };
          }
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
  ): Promise<{ writes: D1PreparedStatement[]; changed: boolean }> {
    const old = await this.db
      .prepare(
        `SELECT ${projectionListFields},provider_missing_at FROM tasks_lists WHERE account_id=? AND provider_id=?`,
      )
      .bind(accountId, dto.id)
      .first<ProjectionListRow & { provider_missing_at: number | null }>();
    const row: ProjectionListRow = old ?? {
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
      old.provider_missing_at !== null ||
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
    if (
      !old ||
      changed ||
      old.tasks_complete_at === null ||
      old.completed_complete_at === null ||
      old.sync_cursor !== null
    )
      writes.push(
        this.db
          .prepare(
            'INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES (?,?,?) ON CONFLICT(account_id,list_id) DO NOTHING',
          )
          .bind(accountId, row.id, this.now()),
      );
    return { writes, changed };
  }
  private async defaultSlice(
    job: Job,
    reader: SyncReader,
    foreground?: ForegroundRun,
  ): Promise<void> {
    const guard = await this.inventoryGuard(job.account_id);
    const dto = await reader.getTaskList('@default');
    const prepared = await this.prepareList(job.account_id, dto, null, true);
    await this.commit(job, [
      guard,
      ...prepared.writes,
      this.db
        .prepare('UPDATE tasks_sync_jobs SET default_pending=0 WHERE account_id=?')
        .bind(job.account_id),
    ]);
    if (foreground && prepared.changed) foreground.changes.topology = true;
  }
  private async inventorySlice(
    job: Job,
    reader: SyncReader,
    foreground?: ForegroundRun,
  ): Promise<void> {
    const guard = await this.inventoryGuard(job.account_id);
    const state = await this.db
      .prepare(
        'SELECT inventory_cursor,inventory_scan_id,inventory_complete_at FROM tasks_account_state WHERE account_id=?',
      )
      .bind(job.account_id)
      .first<{
        inventory_cursor: string | null;
        inventory_scan_id: string | null;
        inventory_complete_at: number | null;
      }>();
    const scanId = state?.inventory_scan_id ?? this.id();
    const page = await reader.listTaskLists({
      maxResults: foreground?.inventoryPageSize ?? 25,
      ...(state?.inventory_cursor ? { pageToken: state.inventory_cursor } : {}),
    });
    const writes: D1PreparedStatement[] = [guard];
    const beforeComplete = state?.inventory_complete_at != null;
    const afterComplete = beforeComplete || !page.nextPageToken;
    // The sync control owns scan progress and freshness; an unchanged retained baseline stays usable.
    let changed = beforeComplete !== afterComplete;
    for (const dto of page.items) {
      const prepared = await this.prepareList(job.account_id, dto, scanId);
      writes.push(...prepared.writes);
      changed ||= prepared.changed;
    }
    writes.push(
      this.db
        .prepare(
          'UPDATE tasks_account_state SET inventory_cursor=?,inventory_scan_id=?,inventory_revision=inventory_revision+1,inventory_count=MAX(inventory_count,(SELECT COUNT(*) FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL)) WHERE account_id=?',
        )
        .bind(page.nextPageToken, scanId, job.account_id, job.account_id),
    );
    if (!page.nextPageToken) {
      if (foreground)
        changed ||= Boolean(
          await this.db
            .prepare(
              `SELECT 1 FROM tasks_lists WHERE account_id=? AND deleted_at IS NULL AND provider_missing_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan<>?) AND provider_id NOT IN(SELECT value FROM json_each(?)) LIMIT 1`,
            )
            .bind(job.account_id, scanId, JSON.stringify(page.items.map((item) => item.id)))
            .first(),
        );
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
    if (foreground && changed) foreground.changes.topology = true;
  }
  private async resolveMovedTasks(
    accountId: string,
    reader: SyncReader,
    list: ProjectionListRow,
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
        mode='full',page_token=NULL,scan_id=NULL,started_at=NULL,updated_min=NULL,
        page_json=NULL,page_offset=0,page_projection_revision=NULL`,
        )
        .bind(accountId, source, this.now()),
    ]);
    return { records: retained, knownTaskIds, guards, sourceWrites };
  }
  private async taskSlice(
    job: Job,
    reader: SyncReader,
    work: Work,
    foreground?: ForegroundRun,
  ): Promise<void> {
    const list = await this.db
      .prepare(
        `SELECT ${projectionListFields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
      )
      .bind(job.account_id, work.list_id)
      .first<ProjectionListRow>();
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
    const retained = retainedTaskPage(work, list.projection_revision);
    let page = retained?.page;
    const offset = retained?.offset ?? 0;
    try {
      page ??= captureTaskPage(
        await reader.listTasks(list.provider_id, {
          maxResults: providerPageSize,
          ...(work.page_token ? { pageToken: work.page_token } : {}),
          ...(updatedMin ? { updatedMin } : {}),
        }),
      );
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
      if (foreground) foreground.changes.tasks = true;
      return;
    }
    const remaining = page.items.slice(offset);
    const unchanged = await unchangedTaskPrefixWrites(
      this.db,
      job.account_id,
      list.id,
      remaining,
      scanId,
    );
    // Even a collision at every address needs at most eight checks plus this page and a refresh.
    const records = unchanged
      ? remaining.slice(0, unchanged.count)
      : remaining.slice(0, foreground?.maxRecords ?? 4);
    const writes: D1PreparedStatement[] = [];
    let changed = false;
    let missingWrite: number | undefined;
    if (unchanged) writes.push(...unchanged.writes);
    else if (records.length) {
      if (foreground) foreground.projectedRecords += records.length;
      const moved = await this.resolveMovedTasks(job.account_id, reader, list, records);
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
      writes.push(...moved.guards, ...projection.writes, ...moved.sourceWrites);
      changed = projection.changed || moved.sourceWrites.length > 0;
    } else if (remaining.length && foreground) {
      foreground.yielded = true;
    }
    const nextOffset = offset + records.length;
    const partialPage = nextOffset < page.items.length;
    if (partialPage || page.nextPageToken)
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_sync_list_work SET mode=?,page_token=?,scan_id=?,started_at=?,updated_min=?,page_json=?,page_offset=?,page_projection_revision=? WHERE account_id=? AND list_id=?',
          )
          .bind(
            full ? 'full' : 'delta',
            partialPage ? work.page_token : page.nextPageToken,
            scanId,
            startedAt,
            updatedMin,
            partialPage ? JSON.stringify(page) : null,
            partialPage ? nextOffset : 0,
            partialPage ? list.projection_revision + 1 : null,
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
        missingWrite = writes.length;
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
    // A retained last page has no provider next token, but its coverage is not complete yet.
    const cursor = partialPage ? scanId : page.nextPageToken;
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
          cursor,
          cursor,
          new Date(startedAt).toISOString(),
          cursor,
          job.account_id,
          list.id,
          this.now(),
          cursor,
          job.account_id,
          list.id,
          this.now(),
          Number(full),
          cursor,
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
    const committed = await this.commit(job, writes, list);
    if (foreground) {
      const after = await this.db
        .prepare(
          'SELECT tasks_complete_at,completed_complete_at,sync_cursor FROM tasks_lists WHERE account_id=? AND id=?',
        )
        .bind(job.account_id, list.id)
        .first<
          Pick<ProjectionListRow, 'tasks_complete_at' | 'completed_complete_at' | 'sync_cursor'>
        >();
      foreground.changes.tasks ||=
        changed ||
        (work.mode === 'full' && cursor === null) ||
        (missingWrite !== undefined && (committed[missingWrite + 1]?.meta.changes ?? 0) > 0) ||
        !after ||
        (list.tasks_complete_at !== null) !== (after.tasks_complete_at !== null) ||
        (list.completed_complete_at !== null) !== (after.completed_complete_at !== null) ||
        (list.sync_cursor !== null) !== (after.sync_cursor !== null);
    }
  }
  private async checkSlice(
    job: Job,
    reader: SyncReader,
    check: { kind: 'list' | 'task'; resource_id: string },
    foreground?: ForegroundRun,
  ): Promise<void> {
    const drop = this.db
      .prepare('DELETE FROM tasks_sync_checks WHERE account_id=? AND kind=? AND resource_id=?')
      .bind(job.account_id, check.kind, check.resource_id);
    if (check.kind === 'list') {
      const list = await this.db
        .prepare(
          `SELECT ${projectionListFields} FROM tasks_lists WHERE account_id=? AND id=? AND deleted_at IS NULL`,
        )
        .bind(job.account_id, check.resource_id)
        .first<ProjectionListRow>();
      if (!list) {
        await this.commit(job, [drop]);
        return;
      }
      try {
        const dto = await reader.getTaskList(list.provider_id);
        const prepared = await this.prepareList(job.account_id, dto, null);
        await this.commit(job, [...prepared.writes, drop], list);
        if (foreground && prepared.changed) foreground.changes.topology = true;
      } catch (error) {
        if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
        const count = await this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND list_id=? AND deleted_at IS NULL',
          )
          .bind(job.account_id, list.id)
          .first<{ n: number }>();
        const providerVersion = await providerProjectionVersion({
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
        if (foreground) foreground.changes.topology = foreground.changes.tasks = true;
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
        .prepare(`SELECT ${projectionListFields} FROM tasks_lists WHERE account_id=? AND id=?`)
        .bind(job.account_id, task.list_id)
        .first<ProjectionListRow>();
      if (!list) throw new AppError('not_found', 'the tracked list is unavailable', 404);
      try {
        const dto = await reader.getTask(task.provider_list_id, task.provider_id);
        if (foreground) foreground.projectedRecords++;
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
        if (foreground && projection.changed) foreground.changes.tasks = true;
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
        if (foreground) foreground.changes.tasks = true;
      }
    }
  }
}
