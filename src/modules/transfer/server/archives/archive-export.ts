import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Coverage, Page } from '../../../../shared/contracts/http';
import {
  assertDisconnecting,
  assertLocalWritable,
  localWriteGuard,
} from '../../../accounts/server/connections/access';
import type { AccountsPortability } from '../../../accounts/server/connections/portability';
import type { BoardService } from '../../../boards/server/boards/service';
import type { BoardTemplateService } from '../../../boards/server/templates/definitions';
import type { TemplateScheduleService } from '../../../boards/server/templates/schedules';
import type { TemplateScheduleSummary } from '../../../boards/contracts/template';
import type { HistoryEvent } from '../../../history/contracts/events';
import type { HistoryService } from '../../../history/server/events/event-store';
import type { Task } from '../../../tasks/contracts/task';
import type { TaskQueries } from '../../../tasks/server/queries/tasks';
import type { TaskSnapshotReader } from '../../../tasks/server/queries/snapshot-reader';
import type { ListSnapshotStore } from '../../../tasks/server/templates/snapshots';
import type { ListTemplateService } from '../../../tasks/server/templates/definitions';
import {
  ArchiveExportSelectionSchema,
  ArchiveHeaderSchema,
  ArchiveRecordSchema,
  type ArchiveExportSelection,
  type ArchiveHeader,
  type ArchiveRecord,
} from '../../contracts/archive';
import type { ArchiveDownloadPage, ArchiveExportSummary } from '../../contracts/archive-export';
import { MAX_IMPORT_FILE_BYTES } from '../../contracts/parsing';

export interface ArchiveExportOptions {
  identity: AccountsPortability['identity'];
  boards: Pick<BoardService, 'getBoard' | 'listBoards' | 'listBoardLists'>;
  queries: Pick<TaskQueries, 'exportPage' | 'labels'>;
  references: Pick<TaskSnapshotReader, 'providerReferences'>;
  graphRevision(accountId: string): Promise<number>;
  listTemplates: Pick<ListTemplateService, 'list' | 'getVersion' | 'versionGuardWrite'>;
  boardTemplates: Pick<BoardTemplateService, 'list' | 'getVersion' | 'versionGuardWrite'>;
  snapshots: Pick<ListSnapshotStore, 'listLists' | 'listTasks' | 'pinWrite' | 'releasePinWrite'>;
  schedules: Pick<TemplateScheduleService, 'list'>;
  history: Pick<HistoryService, 'query'>;
  now?: () => number;
}
interface Run {
  id: string;
  account_id: string;
  request_json: string;
  request_hash: string;
  header_json: string;
  state: ArchiveExportSummary['state'];
  phase: ArchiveExportSummary['phase'];
  cursor: string | null;
  revision: number;
  record_count: number;
  bytes: number;
  task_count: number;
  list_count: number;
  unmatched_schedules: number;
  graph_revision: number | null;
  freshness_json: string | null;
  capture_hash: string;
  error_code: string | null;
  payload_pruned_at: number | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}
interface SavedRecord {
  item_key: string;
  position: number;
  kind: ArchiveRecord['kind'];
  source_id: string;
  input_json: string;
  input_hash: string;
  byte_count: number;
}
interface Job {
  item_key: string;
  kind: 'board_lists' | 'template' | 'schedule';
  source_id: string;
  source_kind: 'list' | 'board' | null;
  source_version: number | null;
  state: string;
  cursor: string | null;
  payload_json: string;
  snapshot_id: string | null;
  pin_owner: string | null;
  required: number;
}
interface NewJob {
  key: string;
  kind: Job['kind'];
  sourceId: string;
  sourceKind?: 'list' | 'board';
  version?: number;
  payload?: unknown;
  required?: boolean;
}
interface Captured {
  record: ArchiveRecord;
  sourceId: string;
}
interface Progress {
  phase?: Run['phase'];
  cursor?: string | null;
  graphRevision?: number;
  freshness?: Coverage;
  jobs?: NewJob[];
  job?: {
    key: string;
    state: string;
    cursor?: string | null;
    payload?: unknown;
    snapshotId?: string | null;
    pinOwner?: string | null;
  };
  extra?: D1PreparedStatement[];
  unmatched?: number;
}
const conflict = (
  message = 'the archive source changed while being captured; start a new export',
) => new AppError('conflict', message, 409);
const size = (value: string) => new TextEncoder().encode(value).byteLength;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function hash(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(canonical(value))),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
const groups = <T>(values: readonly T[]): T[][] => {
  const parts: T[][] = [];
  for (let index = 0; index < values.length; index += 100)
    parts.push(values.slice(index, index + 100));
  return parts;
};

/** Captures owner pages first; a ready download contains only validated declarative records. */
export class ArchiveExportService {
  constructor(
    private readonly db: D1Database,
    private readonly options: ArchiveExportOptions,
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private async run(accountId: string, id: string): Promise<Run> {
    const row = await this.db
      .prepare('SELECT * FROM transfer_archive_exports WHERE id=? AND account_id=?')
      .bind(id, accountId)
      .first<Run>();
    if (!row)
      throw new AppError(
        'not_found',
        'this archive export is not available in the selected account',
        404,
      );
    return row;
  }
  private async key(
    run: Pick<Run, 'id' | 'account_id'>,
    kind: string,
    source: unknown,
  ): Promise<string> {
    return kind + '_' + (await hash([run.id, run.account_id, kind, source]));
  }
  private async job(run: Run, kind: Job['kind']): Promise<Job | null> {
    return this.db
      .prepare(
        "SELECT * FROM transfer_archive_export_jobs WHERE export_id=? AND kind=? AND state NOT IN('done','unmatched') ORDER BY item_key LIMIT 1",
      )
      .bind(run.id, kind)
      .first<Job>();
  }
  private guard(condition: string, values: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT INTO transfer_archive_export_guards(valid) SELECT 0 WHERE NOT (' + condition + ')',
      )
      .bind(...values);
  }
  private templateSource(kind: string, id: string, version: number): string {
    return JSON.stringify([kind, id, version]);
  }

  async begin(input: ArchiveExportSelection): Promise<ArchiveExportSummary> {
    const parsed = ArchiveExportSelectionSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'choose an explicit account or board archive selection',
        422,
      );
    const selection = parsed.data,
      request = JSON.stringify(canonical(selection)),
      requestHash = await hash(selection);
    const existing = await this.db
      .prepare('SELECT account_id,request_hash FROM transfer_archive_exports WHERE id=?')
      .bind(selection.id)
      .first<{ account_id: string; request_hash: string }>();
    if (existing) {
      if (existing.account_id !== selection.accountId || existing.request_hash !== requestHash)
        throw conflict('this archive identity belongs to another selection');
      return this.get(selection.accountId, selection.id);
    }
    await assertLocalWritable(this.db, selection.accountId);
    const source = await this.options.identity(selection.accountId);
    if (selection.boardId)
      await this.options.boards.getBoard(selection.accountId, selection.boardId);
    const keySource = { id: selection.id, account_id: selection.accountId };
    const header = ArchiveHeaderSchema.parse({
      format: 'lanes-workspace',
      version: 1,
      id: selection.id,
      generatedAt: new Date(this.now()).toISOString(),
      source: {
        googleSubject: source.googleSubject,
        email: source.email,
        planningZone: source.planningZone,
        weekStart: source.weekStart,
      },
      scope: selection.boardId
        ? { kind: 'board', boardKey: await this.key(keySource, 'board', selection.boardId) }
        : { kind: 'account' },
      includesTaskSnapshots: selection.includeTaskSnapshots,
      generationNote:
        'paginated retained projections; provider changes can produce a mixed-time export.',
    });
    const headerJson = JSON.stringify(header),
      bytes = size('{"header":' + headerJson + ',"records":[]}');
    await this.db.batch([
      localWriteGuard(this.db, selection.accountId),
      this.db
        .prepare(
          'INSERT INTO transfer_archive_exports(id,account_id,request_json,request_hash,header_json,bytes,capture_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .bind(
          selection.id,
          selection.accountId,
          request,
          requestHash,
          headerJson,
          bytes,
          requestHash,
          this.now(),
          this.now(),
        ),
    ]);
    if ((await this.run(selection.accountId, selection.id)).request_hash !== requestHash)
      throw conflict();
    return this.get(selection.accountId, selection.id);
  }

  async get(accountId: string, id: string): Promise<ArchiveExportSummary> {
    const run = await this.run(accountId, id);
    return {
      id,
      accountId,
      header: ArchiveHeaderSchema.parse(JSON.parse(run.header_json)),
      state: run.state,
      phase: run.phase,
      recordCount: run.record_count,
      bytes: run.bytes,
      taskCount: run.task_count,
      listCount: run.list_count,
      unmatchedSchedules: run.unmatched_schedules,
      captureHash: run.state === 'ready' ? run.capture_hash : null,
      downloadAvailable:
        run.state === 'ready' &&
        run.payload_pruned_at === null &&
        run.finished_at !== null &&
        this.now() < run.finished_at + 86400000,
      payloadExpiresAt:
        run.finished_at === null ? null : new Date(run.finished_at + 86400000).toISOString(),
      freshness: run.freshness_json ? (JSON.parse(run.freshness_json) as Coverage) : null,
      error: run.error_code
        ? {
            code: run.error_code,
            message:
              run.error_code === 'validation_failed'
                ? 'this archive exceeds a supported size, shape, or reference bound. select a narrower scope.'
                : 'the source could not be captured completely. start a new export when it is available.',
          }
        : null,
    };
  }

  private async stage(run: Run, input: Captured[], progress: Progress = {}): Promise<void> {
    if (input.length > 10)
      throw new AppError(
        'validation_failed',
        'capture at most10 archive records in one owner page',
        422,
      );
    const encoded = await Promise.all(
      input.map(async (row) => {
        const parsed = ArchiveRecordSchema.safeParse(row.record);
        if (!parsed.success)
          throw new AppError(
            'validation_failed',
            'one source record cannot be represented by this archive version',
            422,
          );
        const json = JSON.stringify(parsed.data);
        if (size(json) > 60 * 1024)
          throw new AppError(
            'validation_failed',
            'one archive record exceeds its60 kib bounded payload; narrow or reduce that record',
            422,
          );
        return {
          ...row,
          record: parsed.data,
          json,
          hash: await hash(parsed.data),
          bytes: size(json),
        };
      }),
    );
    if (encoded.reduce((sum, row) => sum + row.bytes, 0) > 64 * 1024)
      throw new AppError(
        'validation_failed',
        'one source page exceeds64 kib; select a smaller source page',
        422,
      );
    const prior = encoded.length
      ? (
          await this.db
            .prepare(
              'SELECT item_key,input_hash FROM transfer_archive_export_records WHERE export_id=? AND item_key IN(SELECT value FROM json_each(?))',
            )
            .bind(run.id, JSON.stringify(encoded.map((row) => row.record.key)))
            .all<{ item_key: string; input_hash: string }>()
        ).results
      : [];
    for (const row of encoded)
      if (prior.some((saved) => saved.item_key === row.record.key && saved.input_hash !== row.hash))
        throw conflict();
    const fresh = encoded.filter(
      (row) => !prior.some((saved) => saved.item_key === row.record.key),
    );
    const bytes = fresh.reduce(
        (sum, row, index) => sum + row.bytes + (run.record_count + index ? 1 : 0),
        0,
      ),
      tasks = fresh.filter((row) => row.record.kind === 'task').length,
      lists = fresh.filter((row) => row.record.kind === 'list').length;
    const header = JSON.parse(run.header_json) as ArchiveHeader;
    if (
      run.bytes + bytes > MAX_IMPORT_FILE_BYTES ||
      run.record_count + fresh.length > 100000 ||
      (header.includesTaskSnapshots &&
        (run.task_count + tasks > 2000 || run.list_count + lists > 100))
    )
      throw new AppError(
        'validation_failed',
        'select a narrower archive scope: at most20 mib or100,000 records, and task snapshots at most2,000 tasks/100 lists',
        422,
      );
    let freshness = progress.freshness;
    if (freshness && run.freshness_json) {
      const previous = JSON.parse(run.freshness_json) as Coverage;
      freshness = {
        complete: previous.complete && freshness.complete,
        stale: previous.stale || freshness.stale,
        lastSyncedAt:
          previous.lastSyncedAt && freshness.lastSyncedAt
            ? [previous.lastSyncedAt, freshness.lastSyncedAt].sort()[0]!
            : null,
      };
    }
    const nonce = crypto.randomUUID(),
      captureHash = await hash([run.capture_hash, fresh.map((row) => [row.record.key, row.hash])]);
    const writes: D1PreparedStatement[] = [
      localWriteGuard(this.db, run.account_id),
      this.db
        .prepare(
          `UPDATE transfer_archive_exports SET nonce=?,revision=revision+1,phase=?,cursor=?,record_count=record_count+?,bytes=bytes+?,task_count=task_count+?,list_count=list_count+?,unmatched_schedules=unmatched_schedules+?,graph_revision=COALESCE(?,graph_revision),freshness_json=COALESCE(?,freshness_json),capture_hash=?,updated_at=? WHERE id=? AND state='capturing' AND revision=?`,
        )
        .bind(
          nonce,
          progress.phase ?? run.phase,
          progress.cursor === undefined ? run.cursor : progress.cursor,
          fresh.length,
          bytes,
          tasks,
          lists,
          progress.unmatched ?? 0,
          progress.graphRevision ?? null,
          freshness ? JSON.stringify(freshness) : null,
          captureHash,
          this.now(),
          run.id,
          run.revision,
        ),
      this.guard('EXISTS(SELECT 1 FROM transfer_archive_exports WHERE id=? AND nonce=?)', [
        run.id,
        nonce,
      ]),
      ...(progress.extra ?? []),
    ];
    fresh.forEach((row, index) =>
      writes.push(
        this.db
          .prepare(
            'INSERT INTO transfer_archive_export_records(export_id,item_key,position,kind,source_id,input_json,input_hash,byte_count) VALUES (?,?,?,?,?,?,?,?)',
          )
          .bind(
            run.id,
            row.record.key,
            run.record_count + index,
            row.record.kind,
            row.sourceId,
            row.json,
            row.hash,
            row.bytes,
          ),
      ),
    );
    for (const job of progress.jobs ?? [])
      writes.push(
        this.db
          .prepare(
            `INSERT INTO transfer_archive_export_jobs(export_id,item_key,kind,source_id,source_kind,source_version,payload_json,required) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(export_id,item_key) DO UPDATE SET required=MAX(required,excluded.required)`,
          )
          .bind(
            run.id,
            job.key,
            job.kind,
            job.sourceId,
            job.sourceKind ?? null,
            job.version ?? null,
            JSON.stringify(job.payload ?? {}),
            job.required ? 1 : 0,
          ),
      );
    if (progress.job) {
      const job = progress.job;
      writes.push(
        this.db
          .prepare(
            'UPDATE transfer_archive_export_jobs SET state=?,cursor=?,payload_json=COALESCE(?,payload_json),snapshot_id=COALESCE(?,snapshot_id),pin_owner=? WHERE export_id=? AND item_key=?',
          )
          .bind(
            job.state,
            job.cursor ?? null,
            job.payload === undefined ? null : JSON.stringify(job.payload),
            job.snapshotId ?? null,
            job.pinOwner ?? null,
            run.id,
            job.key,
          ),
      );
    }
    try {
      await this.db.batch(writes);
    } catch (error) {
      if ((await this.run(run.account_id, run.id)).revision !== run.revision) return;
      if (error instanceof AppError) throw error;
      throw conflict();
    }
  }

  private async taskRecords(run: Run, tasks: Task[]): Promise<Captured[]> {
    const labelIds = [...new Set(tasks.flatMap((task) => task.labelIds))],
      referenceIds = [...new Set(tasks.flatMap((task) => task.blockedBy))];
    const labels = (
        await Promise.all(
          groups(labelIds).map((ids) =>
            this.options.queries.labels.readLabelsByIds(run.account_id, ids),
          ),
        )
      ).flat(),
      references = (
        await Promise.all(
          groups(referenceIds).map((ids) =>
            this.options.references.providerReferences(run.account_id, ids),
          ),
        )
      ).flat();
    const labelMap = new Map(labels.map((label) => [label.id, label])),
      refMap = new Map(references.map((reference) => [reference.id, reference]));
    const header = JSON.parse(run.header_json) as ArchiveHeader;
    return Promise.all(
      tasks.map(async (task, index): Promise<Captured> => {
        if (
          task.labelIds.some((id) => !labelMap.has(id)) ||
          task.blockedBy.some((id) => !refMap.has(id))
        )
          throw conflict('a label or dependency changed during archive capture');
        const record = {
          kind: 'task' as const,
          key: await this.key(run, 'task', task.id),
          listKey: await this.key(run, 'list', task.listId),
          parentKey: task.parentId ? await this.key(run, 'task', task.parentId) : null,
          provider: {
            id: task.provider.id,
            listId: task.provider.listId,
            etag: task.provider.etag,
          },
          revision: task.revision,
          scheduledDay: task.scheduledDay,
          scheduledTime: task.scheduledTime,
          timeZone: task.timeZone,
          repeatRule: task.repeatRule,
          labels: await Promise.all(
            task.labelIds.map(async (id) => ({
              key: await this.key(run, 'label', id),
              name: labelMap.get(id)!.name,
              color: labelMap.get(id)!.color,
            })),
          ),
          priority: task.priority,
          starred: task.starred,
          dependencies: await Promise.all(
            task.blockedBy.map(async (id) => ({
              key: await this.key(run, 'task', id),
              provider: {
                id: refMap.get(id)!.providerId,
                listId: refMap.get(id)!.listProviderId,
                etag: refMap.get(id)!.providerEtag,
              },
            })),
          ),
          order: run.task_count + index,
          ...(header.includesTaskSnapshots
            ? {
                snapshot: {
                  title: task.title,
                  notes: task.notes,
                  completed: task.completed,
                  completedAt: task.completedAt,
                },
              }
            : {}),
        };
        return { sourceId: task.id, record };
      }),
    );
  }

  private async templateContent(run: Run, job: Job): Promise<void> {
    const templateKey = job.item_key;
    if (job.state === 'queued') {
      const owner =
        job.source_kind === 'list' ? this.options.listTemplates : this.options.boardTemplates;
      let template: Awaited<ReturnType<typeof owner.getVersion>>;
      try {
        template = await owner.getVersion(run.account_id, job.source_id, job.source_version!);
      } catch (error) {
        if (error instanceof AppError && error.code === 'not_found' && !job.required) {
          await this.stage(run, [], { job: { key: job.item_key, state: 'unmatched' } });
          return;
        }
        throw error;
      }
      const {
        id: snapshotId,
        accountId: _account,
        createdAt: _created,
        ...header
      } = template.snapshot;
      const pin = 'archive-export:' + run.id + ':' + job.item_key;
      await this.stage(
        run,
        [
          {
            sourceId: this.templateSource(template.kind, template.id, template.contentRevision),
            record: {
              kind: 'template',
              key: templateKey,
              templateKind: template.kind,
              name: template.name,
              description: template.description,
              contentRevision: template.contentRevision,
              header,
              ...(template.kind === 'board' ? { appearance: template.appearance } : {}),
            },
          },
        ],
        {
          job: { key: job.item_key, state: 'lists', snapshotId, pinOwner: pin },
          extra: [
            owner.versionGuardWrite(
              run.account_id,
              template.id,
              template.contentRevision,
              snapshotId,
            ),
            this.options.snapshots.pinWrite(run.account_id, snapshotId, pin),
          ],
        },
      );
    } else if (job.state === 'lists') {
      const page = await this.options.snapshots.listLists(run.account_id, job.snapshot_id!, {
        limit: 5,
        ...(job.cursor ? { cursor: job.cursor } : {}),
      });
      const records = await Promise.all(
        page.items.map(async (list) => ({
          sourceId: list.key,
          record: {
            kind: 'template_list' as const,
            key: await this.key(run, 'template_list', [templateKey, list.key]),
            templateKey,
            value: { ...list, key: await this.key(run, 'tl', [templateKey, list.key]) },
          },
        })),
      );
      await this.stage(run, records, {
        job: {
          key: job.item_key,
          state: page.nextCursor ? 'lists' : 'tasks',
          cursor: page.nextCursor,
          pinOwner: job.pin_owner,
        },
      });
    } else {
      const page = await this.options.snapshots.listTasks(run.account_id, job.snapshot_id!, {
        limit: 1,
        ...(job.cursor ? { cursor: job.cursor } : {}),
      });
      const records = await Promise.all(
        page.items.map(async (task) => ({
          sourceId: task.key,
          record: {
            kind: 'template_task' as const,
            key: await this.key(run, 'template_task', [templateKey, task.key]),
            templateKey,
            value: {
              ...task,
              key: await this.key(run, 'tt', [templateKey, task.key]),
              listKey: await this.key(run, 'tl', [templateKey, task.listKey]),
              parentKey: task.parentKey
                ? await this.key(run, 'tt', [templateKey, task.parentKey])
                : null,
              dependencyKeys: await Promise.all(
                task.dependencyKeys.map((key) => this.key(run, 'tt', [templateKey, key])),
              ),
            },
          },
        })),
      );
      await this.stage(run, records, {
        job: {
          key: job.item_key,
          state: page.nextCursor ? 'tasks' : 'done',
          cursor: page.nextCursor,
          pinOwner: page.nextCursor ? job.pin_owner : null,
        },
        ...(!page.nextCursor && job.pin_owner
          ? {
              extra: [
                this.options.snapshots.releasePinWrite(
                  run.account_id,
                  job.snapshot_id!,
                  job.pin_owner,
                ),
              ],
            }
          : {}),
      });
    }
  }

  private async historyRecord(run: Run, event: HistoryEvent): Promise<Captured> {
    const taskKey = (id: string) => this.key(run, 'task', id),
      listKey = (id: string) => this.key(run, 'list', id),
      labelKey = (id: string) => this.key(run, 'label', id);
    const summary: Record<string, unknown> = { ...event.summary };
    if (event.kind === 'task_created') {
      if (event.summary.sourceTaskId)
        summary.sourceTaskId = await taskKey(event.summary.sourceTaskId);
    }
    if (event.kind === 'task_created') {
      if (event.summary.sourceAccountId)
        summary.sourceAccountId =
          event.summary.sourceAccountId === run.account_id
            ? 'a1'
            : await this.key(run, 'account', event.summary.sourceAccountId);
      if (event.summary.templateId)
        summary.templateId = await this.key(run, 'historical_template', event.summary.templateId);
      if (event.summary.seriesId)
        summary.seriesId = await this.key(run, 'series', event.summary.seriesId);
      if (event.summary.occurrenceId)
        summary.occurrenceId = await this.key(run, 'occurrence', event.summary.occurrenceId);
    }
    if (event.kind === 'task_deleted' && event.summary.parentId)
      summary.parentId = await taskKey(event.summary.parentId);
    if (event.kind === 'task_moved')
      for (const side of ['from', 'to'] as const)
        summary[side] = {
          listId: await listKey(event.summary[side].listId),
          parentId: event.summary[side].parentId
            ? await taskKey(event.summary[side].parentId)
            : null,
        };
    if (event.kind === 'labels_changed' || event.kind === 'dependencies_changed')
      for (const side of ['before', 'after'] as const)
        summary[side] = await Promise.all(
          event.summary[side].map(event.kind === 'labels_changed' ? labelKey : taskKey),
        );
    const value: unknown = {
      kind: 'history',
      key: await this.key(run, 'history', event.id),
      event: {
        ...event,
        accountId: 'a1',
        taskId: event.taskId ? await taskKey(event.taskId) : null,
        listId: event.listId ? await listKey(event.listId) : null,
        summary,
      },
    };
    return { sourceId: event.id, record: ArchiveRecordSchema.parse(value) };
  }

  async captureNext(accountId: string, id: string): Promise<ArchiveExportSummary> {
    const run = await this.run(accountId, id);
    if (run.state !== 'capturing') return this.get(accountId, id);
    await assertLocalWritable(this.db, accountId);
    const selection = ArchiveExportSelectionSchema.parse(JSON.parse(run.request_json));
    try {
      if (run.phase === 'boards') {
        const page = selection.boardId
          ? {
              items: [await this.options.boards.getBoard(accountId, selection.boardId)],
              nextCursor: null,
            }
          : await this.options.boards.listBoards(accountId, {
              limit: 5,
              ...(run.cursor ? { cursor: run.cursor } : {}),
            });
        const rows = await Promise.all(
          page.items.map(async (board) => ({
            sourceId: board.id,
            record: {
              kind: 'board' as const,
              key: await this.key(run, 'board', board.id),
              title: board.title,
              isMain: board.isMain,
              emoji: board.emoji,
              color: board.color,
              backgroundUrl: board.backgroundUrl,
              position: board.position,
              revision: board.revision,
            },
          })),
        );
        await this.stage(run, rows, {
          phase: page.nextCursor ? 'boards' : 'lists',
          cursor: page.nextCursor,
          jobs: await Promise.all(
            page.items.map(async (board) => ({
              key: await this.key(run, 'board_lists', board.id),
              kind: 'board_lists' as const,
              sourceId: board.id,
            })),
          ),
        });
      } else if (run.phase === 'lists') {
        const job = await this.job(run, 'board_lists');
        if (!job)
          await this.stage(run, [], {
            phase: selection.boardId ? 'tasks' : 'labels',
            cursor: null,
          });
        else {
          const page = await this.options.boards.listBoardLists(accountId, job.source_id, {
            limit: 5,
            ...(job.cursor ? { cursor: job.cursor } : {}),
          });
          const rows = await Promise.all(
            page.items.map(async (list) => ({
              sourceId: list.id,
              record: {
                kind: 'list' as const,
                key: await this.key(run, 'list', list.id),
                boardKey: await this.key(run, 'board', list.boardId),
                providerId: list.providerId,
                title: list.title,
                color: list.color,
                position: list.position,
                revision: list.revision,
                membershipRevision: list.membershipRevision,
              },
            })),
          );
          await this.stage(run, rows, {
            job: {
              key: job.item_key,
              state: page.nextCursor ? 'queued' : 'done',
              cursor: page.nextCursor,
            },
            freshness: page.coverage,
          });
        }
      } else if (run.phase === 'labels') {
        const page = await this.options.queries.labels.readLabels(accountId, {
          limit: 5,
          ...(run.cursor ? { cursor: run.cursor } : {}),
        });
        await this.stage(
          run,
          await Promise.all(
            page.items.map(async (label) => ({
              sourceId: label.id,
              record: {
                kind: 'label' as const,
                key: await this.key(run, 'label', label.id),
                name: label.name,
                color: label.color,
                revision: label.revision,
              },
            })),
          ),
          { phase: page.nextCursor ? 'labels' : 'tasks', cursor: page.nextCursor },
        );
      } else if (run.phase === 'tasks') {
        if (run.graph_revision === null)
          await this.stage(run, [], { graphRevision: await this.options.graphRevision(accountId) });
        else {
          const lists = (
            await this.db
              .prepare(
                "SELECT source_id FROM transfer_archive_export_records WHERE export_id=? AND kind='list' ORDER BY position",
              )
              .bind(id)
              .all<{ source_id: string }>()
          ).results;
          const page = await this.options.queries.exportPage(
            accountId,
            {
              listIds: lists.map((list) => list.source_id),
              filter: { completion: 'all' },
              limit: 1,
              ...(run.cursor ? { cursor: run.cursor } : {}),
            },
            { today: selection.today, now: this.now() },
          );
          if (
            !page.nextCursor &&
            (await this.options.graphRevision(accountId)) !== run.graph_revision
          )
            throw conflict('task dependencies changed during archive capture');
          await this.stage(run, await this.taskRecords(run, page.items), {
            phase: page.nextCursor ? 'tasks' : 'schedules',
            cursor: page.nextCursor,
            freshness: page.providerCoverage,
          });
        }
      } else if (run.phase === 'schedules') {
        const page = await this.options.schedules.list(accountId, {
            limit: 5,
            ...(run.cursor ? { cursor: run.cursor } : {}),
          }),
          jobs: NewJob[] = [];
        for (const schedule of page.items.filter(
          (schedule) => !selection.boardId || schedule.boardId === selection.boardId,
        )) {
          const source = this.templateSource(
            schedule.template.kind,
            schedule.template.id,
            schedule.template.contentRevision,
          );
          jobs.push(
            {
              key: await this.key(run, 'schedule', schedule.id),
              kind: 'schedule',
              sourceId: schedule.id,
              payload: schedule,
            },
            {
              key: await this.key(run, 'template', source),
              kind: 'template',
              sourceId: schedule.template.id,
              sourceKind: schedule.template.kind,
              version: schedule.template.contentRevision,
            },
          );
        }
        await this.stage(run, [], {
          phase: page.nextCursor
            ? 'schedules'
            : selection.boardId
              ? 'template_content'
              : 'list_templates',
          cursor: page.nextCursor,
          jobs,
        });
      } else if (run.phase === 'list_templates' || run.phase === 'board_templates') {
        const owner =
            run.phase === 'list_templates'
              ? this.options.listTemplates
              : this.options.boardTemplates,
          page = await owner.list(accountId, {
            limit: 5,
            ...(run.cursor ? { cursor: run.cursor } : {}),
          });
        await this.stage(run, [], {
          phase: page.nextCursor
            ? run.phase
            : run.phase === 'list_templates'
              ? 'board_templates'
              : 'template_content',
          cursor: page.nextCursor,
          jobs: await Promise.all(
            page.items.map(async (template) => ({
              key: await this.key(
                run,
                'template',
                this.templateSource(template.kind, template.id, template.contentRevision),
              ),
              kind: 'template' as const,
              sourceId: template.id,
              sourceKind: template.kind,
              version: template.contentRevision,
              required: true,
            })),
          ),
        });
      } else if (run.phase === 'template_content') {
        const job = await this.job(run, 'template');
        if (job) await this.templateContent(run, job);
        else await this.stage(run, [], { phase: 'emit_schedules', cursor: null });
      } else if (run.phase === 'emit_schedules') {
        const job = await this.job(run, 'schedule');
        if (!job) await this.stage(run, [], { phase: 'history', cursor: null });
        else {
          const schedule = JSON.parse(job.payload_json) as TemplateScheduleSummary,
            templateKey = await this.key(
              run,
              'template',
              this.templateSource(
                schedule.template.kind,
                schedule.template.id,
                schedule.template.contentRevision,
              ),
            ),
            boardKey = await this.key(run, 'board', schedule.boardId);
          const present = (
              await this.db
                .prepare(
                  'SELECT item_key FROM transfer_archive_export_records WHERE export_id=? AND item_key IN(?,?)',
                )
                .bind(id, templateKey, boardKey)
                .all<{ item_key: string }>()
            ).results,
            has = new Set(present.map((row) => row.item_key)),
            unmatched = { template: !has.has(templateKey), board: !has.has(boardKey) };
          await this.stage(
            run,
            [
              {
                sourceId: schedule.id,
                record: {
                  kind: 'schedule',
                  key: job.item_key,
                  templateKey,
                  templateKind: schedule.template.kind,
                  boardKey,
                  timing: schedule.timing,
                  useRelativeDates: schedule.useRelativeDates,
                  listPrefix: schedule.listPrefix,
                  wasActive: schedule.state === 'active',
                  ...(unmatched.template || unmatched.board
                    ? { unmatchedReferences: unmatched }
                    : {}),
                },
              },
            ],
            {
              job: { key: job.item_key, state: 'done' },
              unmatched: unmatched.template || unmatched.board ? 1 : 0,
            },
          );
        }
      } else if (run.phase === 'history') {
        const page = await this.options.history.query(accountId, {
          limit: 1,
          ...(selection.boardId ? { boardId: selection.boardId } : {}),
          ...(run.cursor ? { cursor: run.cursor } : {}),
        });
        await this.stage(
          run,
          await Promise.all(page.items.map((event) => this.historyRecord(run, event))),
          { phase: page.nextCursor ? 'history' : 'validate', cursor: page.nextCursor },
        );
      } else await this.seal(run);
    } catch (error) {
      if (error instanceof AppError && !error.retryable)
        await this.db
          .prepare(
            "UPDATE transfer_archive_exports SET state='failed',error_code=?,finished_at=?,updated_at=? WHERE id=? AND state='capturing' AND revision=?",
          )
          .bind(error.code, this.now(), this.now(), id, run.revision)
          .run();
      if (error instanceof AppError) throw error;
      throw new AppError(
        'storage_unavailable',
        'the selected archive source could not be captured safely',
        503,
        true,
      );
    }
    return this.get(accountId, id);
  }

  private async seal(run: Run): Promise<void> {
    const header = JSON.parse(run.header_json) as ArchiveHeader;
    const malformed = await this.db
      .prepare(
        `SELECT 1 FROM transfer_archive_export_records r WHERE r.export_id=? AND (
      (r.kind='list' AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_records b WHERE b.export_id=r.export_id AND b.kind='board' AND b.item_key=json_extract(r.input_json,'$.boardKey')))
      OR(r.kind='task' AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_records l WHERE l.export_id=r.export_id AND l.kind='list' AND l.item_key=json_extract(r.input_json,'$.listKey') AND json_extract(l.input_json,'$.providerId')=json_extract(r.input_json,'$.provider.listId')))
      OR(r.kind='task' AND json_extract(r.input_json,'$.parentKey') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_records p WHERE p.export_id=r.export_id AND p.kind='task' AND p.item_key=json_extract(r.input_json,'$.parentKey') AND json_extract(p.input_json,'$.listKey')=json_extract(r.input_json,'$.listKey') AND json_extract(p.input_json,'$.parentKey') IS NULL))
      OR(r.kind='task' AND json_extract(r.input_json,'$.parentKey') IS NOT NULL AND json_type(r.input_json,'$.repeatRule')='object')
      OR(r.kind='task' AND EXISTS(SELECT 1 FROM json_each(r.input_json,'$.dependencies') d LEFT JOIN transfer_archive_export_records target ON target.export_id=r.export_id AND target.item_key=json_extract(d.value,'$.key') WHERE json_extract(d.value,'$.key')=r.item_key OR(target.item_key IS NOT NULL AND(target.kind<>'task' OR json_extract(target.input_json,'$.provider.id')<>json_extract(d.value,'$.provider.id') OR json_extract(target.input_json,'$.provider.listId')<>json_extract(d.value,'$.provider.listId')))))
      OR(r.kind='template' AND ((SELECT COUNT(*) FROM transfer_archive_export_records c WHERE c.export_id=r.export_id AND c.kind='template_list' AND json_extract(c.input_json,'$.templateKey')=r.item_key)<>json_extract(r.input_json,'$.header.listCount') OR (SELECT COUNT(*) FROM transfer_archive_export_records c WHERE c.export_id=r.export_id AND c.kind='template_task' AND json_extract(c.input_json,'$.templateKey')=r.item_key)<>json_extract(r.input_json,'$.header.taskCount')))
      ) LIMIT 1`,
      )
      .bind(run.id)
      .first();
    const main =
      header.scope.kind === 'account'
        ? await this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM transfer_archive_export_records WHERE export_id=? AND kind='board' AND json_extract(input_json,'$.isMain')=1",
            )
            .bind(run.id)
            .first<number>('n')
        : 1;
    if (malformed || main !== 1)
      throw conflict(
        'the captured organization or task hierarchy has missing or inconsistent references',
      );
    await this.db
      .prepare(
        "UPDATE transfer_archive_exports SET state='ready',finished_at=?,updated_at=? WHERE id=? AND state='capturing' AND revision=?",
      )
      .bind(this.now(), this.now(), run.id, run.revision)
      .run();
  }

  async downloadPage(
    accountId: string,
    id: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<ArchiveDownloadPage> {
    const run = await this.run(accountId, id);
    if (run.state !== 'ready')
      throw conflict('finish capturing this complete archive before downloading it');
    if (
      run.payload_pruned_at !== null ||
      run.finished_at === null ||
      this.now() >= run.finished_at + 86400000
    )
      throw conflict(
        'this archive payload expired after24 hours; generate a new export to download it',
      );
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError('validation_failed', 'download at most10 archive records per page', 422);
    let after = -1;
    if (input.cursor) {
      try {
        const cursor = z
          .object({
            id: z.string(),
            accountId: z.string(),
            hash: z.string(),
            position: z.number().int().min(-1),
          })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (cursor.id !== id || cursor.accountId !== accountId || cursor.hash !== run.capture_hash)
          throw new Error();
        after = cursor.position;
      } catch {
        throw new AppError(
          'validation_failed',
          'this archive download cursor belongs to another capture',
          422,
        );
      }
    }
    const candidates = (
      await this.db
        .prepare(
          'SELECT position,byte_count FROM transfer_archive_export_records WHERE export_id=? AND position>? ORDER BY position LIMIT ?',
        )
        .bind(id, after, limit + 1)
        .all<{ position: number; byte_count: number }>()
    ).results;
    let chunk = input.cursor ? '' : '{"header":' + run.header_json + ',"records":[',
      bytes = size(chunk);
    const positions: number[] = [];
    for (const row of candidates.slice(0, limit)) {
      if (bytes + row.byte_count + 3 > 65536) break;
      positions.push(row.position);
      bytes += row.byte_count + 1;
    }
    const records = positions.length
      ? (
          await this.db
            .prepare(
              'SELECT item_key,position,kind,source_id,input_json,input_hash,byte_count FROM transfer_archive_export_records WHERE export_id=? AND position IN(SELECT value FROM json_each(?)) ORDER BY position',
            )
            .bind(id, JSON.stringify(positions))
            .all<SavedRecord>()
        ).results
      : [];
    for (const record of records) {
      const parsed = ArchiveRecordSchema.safeParse(JSON.parse(record.input_json));
      if (!parsed.success || (await hash(parsed.data)) !== record.input_hash)
        throw new AppError(
          'storage_unavailable',
          'a frozen archive record could not be read safely',
          503,
        );
      chunk += (after >= 0 ? ',' : '') + record.input_json;
      after = record.position;
    }
    const more = candidates.some((row) => row.position > after);
    if (!more) chunk += ']}';
    if (more && !records.length)
      throw new AppError(
        'validation_failed',
        'one captured archive record exceeds its download bound',
        422,
      );
    return {
      chunk,
      nextCursor: more
        ? btoa(JSON.stringify({ id, accountId, hash: run.capture_hash, position: after }))
        : null,
      generatedAt: (JSON.parse(run.header_json) as ArchiveHeader).generatedAt,
      totalBytes: run.bytes,
      recordCount: run.record_count,
    };
  }
  async list(
    accountId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ArchiveExportSummary>> {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new AppError('validation_failed', 'read at most10 archive exports at once', 422);
    let anchor: { id: string; createdAt: number } | null = null;
    if (input.cursor) {
      try {
        const value = z
          .object({ accountId: z.string(), id: z.string(), createdAt: z.number().int() })
          .strict()
          .parse(JSON.parse(atob(input.cursor)));
        if (value.accountId !== accountId) throw new Error();
        anchor = value;
      } catch {
        throw new AppError(
          'validation_failed',
          'this archive list cursor belongs to another account',
          422,
        );
      }
    }
    const rows = (
        await this.db
          .prepare(
            `SELECT id,created_at FROM transfer_archive_exports WHERE account_id=? ${anchor ? 'AND(created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .bind(accountId, ...(anchor ? [anchor.createdAt, anchor.id] : []), limit + 1)
          .all<{ id: string; created_at: number }>()
      ).results,
      selected = rows.slice(0, limit),
      last = selected.at(-1);
    const items = await Promise.all(selected.map((row) => this.get(accountId, row.id)));
    if (size(JSON.stringify(items)) > 65536)
      throw new AppError('validation_failed', 'read fewer archive summaries at once', 422);
    return {
      items,
      nextCursor:
        last && rows.length > selected.length
          ? btoa(JSON.stringify({ accountId, id: last.id, createdAt: last.created_at }))
          : null,
      coverage: { complete: true, stale: false, lastSyncedAt: null },
    };
  }

  async advanceNext(): Promise<ArchiveExportSummary | null> {
    const row = await this.db
      .prepare(
        "SELECT id,account_id FROM transfer_archive_exports WHERE state='capturing' ORDER BY updated_at,id LIMIT 1",
      )
      .first<{ id: string; account_id: string }>();
    if (!row) return null;
    await this.db
      .prepare('UPDATE transfer_archive_exports SET updated_at=? WHERE id=?')
      .bind(this.now(), row.id)
      .run();
    return this.captureNext(row.account_id, row.id);
  }
  private async releasePins(accountId: string, id: string, limit = 10): Promise<number> {
    const jobs = (
      await this.db
        .prepare(
          'SELECT item_key,snapshot_id,pin_owner FROM transfer_archive_export_jobs WHERE export_id=? AND pin_owner IS NOT NULL ORDER BY item_key LIMIT ?',
        )
        .bind(id, limit)
        .all<{ item_key: string; snapshot_id: string; pin_owner: string }>()
    ).results;
    if (!jobs.length) return 0;
    const results = await this.db.batch(
      jobs.flatMap((job) => [
        this.options.snapshots.releasePinWrite(accountId, job.snapshot_id, job.pin_owner),
        this.db
          .prepare(
            'UPDATE transfer_archive_export_jobs SET pin_owner=NULL WHERE export_id=? AND item_key=? AND pin_owner=?',
          )
          .bind(id, job.item_key, job.pin_owner),
      ]),
    );
    return results.reduce((sum, result) => sum + result.meta.changes, 0);
  }
  private async releaseOnePin(accountId: string, id: string): Promise<number> {
    const job = await this.db
      .prepare(
        'SELECT item_key,snapshot_id,pin_owner FROM transfer_archive_export_jobs WHERE export_id=? AND pin_owner IS NOT NULL ORDER BY item_key LIMIT 1',
      )
      .bind(id)
      .first<{ item_key: string; snapshot_id: string; pin_owner: string }>();
    if (!job) return 0;
    const released = await this.options.snapshots
      .releasePinWrite(accountId, job.snapshot_id, job.pin_owner)
      .run();
    if (released.meta.changes) return released.meta.changes;
    return (
      await this.db
        .prepare(
          'UPDATE transfer_archive_export_jobs SET pin_owner=NULL WHERE export_id=? AND item_key=? AND pin_owner=?',
        )
        .bind(id, job.item_key, job.pin_owner)
        .run()
    ).meta.changes;
  }
  async cancel(accountId: string, id: string): Promise<ArchiveExportSummary> {
    await this.run(accountId, id);
    await this.db
      .prepare(
        "UPDATE transfer_archive_exports SET state='cancelled',finished_at=?,updated_at=? WHERE id=? AND account_id=? AND state='capturing'",
      )
      .bind(this.now(), this.now(), id, accountId)
      .run();
    await this.releasePins(accountId, id);
    return this.get(accountId, id);
  }
  async pauseAccount(accountId: string, limit = 100): Promise<{ done: boolean; pending: false }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'pause at most100 archive captures at a time', 422);
    const rows = (
      await this.db
        .prepare(
          "SELECT e.id FROM transfer_archive_exports e WHERE e.account_id=? AND(e.state='capturing' OR EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id AND j.pin_owner IS NOT NULL)) ORDER BY e.updated_at,e.id LIMIT ?",
        )
        .bind(accountId, Math.min(limit, 2))
        .all<{ id: string }>()
    ).results;
    for (const row of rows) await this.cancel(accountId, row.id);
    return {
      done:
        (await this.db
          .prepare(
            "SELECT 1 FROM transfer_archive_exports e WHERE e.account_id=? AND(e.state='capturing' OR EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id AND j.pin_owner IS NOT NULL)) LIMIT 1",
          )
          .bind(accountId)
          .first()) === null,
      pending: false,
    };
  }
  async removeAccountSlice(
    accountId: string,
    limit = 100,
  ): Promise<{ done: boolean; deleted: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'remove at most100 archive export rows at once', 422);
    await assertDisconnecting(this.db, accountId);
    let deleted = 0;
    const pinned = await this.db
      .prepare(
        'SELECT e.id FROM transfer_archive_exports e WHERE e.account_id=? AND EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id AND j.pin_owner IS NOT NULL) ORDER BY e.id LIMIT 1',
      )
      .bind(accountId)
      .first<{ id: string }>();
    if (pinned && limit === 1)
      return { done: false, deleted: await this.releaseOnePin(accountId, pinned.id) };
    if (pinned) deleted += await this.releasePins(accountId, pinned.id, Math.floor(limit / 2));
    if (deleted < limit)
      deleted += (
        await this.db
          .prepare(
            'DELETE FROM transfer_archive_export_jobs WHERE(export_id,item_key) IN(SELECT j.export_id,j.item_key FROM transfer_archive_export_jobs j JOIN transfer_archive_exports e ON e.id=j.export_id WHERE e.account_id=? AND j.pin_owner IS NULL ORDER BY j.export_id,j.item_key LIMIT ?)',
          )
          .bind(accountId, limit - deleted)
          .run()
      ).meta.changes;
    if (deleted < limit)
      deleted += (
        await this.db
          .prepare(
            'DELETE FROM transfer_archive_export_records WHERE(export_id,item_key) IN(SELECT r.export_id,r.item_key FROM transfer_archive_export_records r JOIN transfer_archive_exports e ON e.id=r.export_id WHERE e.account_id=? ORDER BY r.export_id,r.position LIMIT ?)',
          )
          .bind(accountId, limit - deleted)
          .run()
      ).meta.changes;
    if (deleted < limit)
      deleted += (
        await this.db
          .prepare(
            'DELETE FROM transfer_archive_exports WHERE id IN(SELECT e.id FROM transfer_archive_exports e WHERE e.account_id=? AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_records r WHERE r.export_id=e.id) ORDER BY e.id LIMIT ?)',
          )
          .bind(accountId, limit - deleted)
          .run()
      ).meta.changes;
    return {
      done:
        (await this.db
          .prepare('SELECT 1 FROM transfer_archive_exports WHERE account_id=? LIMIT 1')
          .bind(accountId)
          .first()) === null,
      deleted,
    };
  }
  async cleanup(limit = 100, now = this.now()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'clean at most100 archive export rows at once', 422);
    let changed = (
      await this.db
        .prepare(
          `UPDATE transfer_archive_exports SET payload_pruned_at=?,state=CASE WHEN state='capturing' THEN 'cancelled' ELSE state END,finished_at=COALESCE(finished_at,?),updated_at=? WHERE id IN(SELECT id FROM transfer_archive_exports WHERE payload_pruned_at IS NULL AND((state='capturing' AND created_at<=?) OR finished_at<=?) ORDER BY created_at,id LIMIT ?)`,
        )
        .bind(now, now, now, now - 86400000, now - 86400000, limit)
        .run()
    ).meta.changes;
    if (changed + 1 < limit) {
      const pinned = await this.db
        .prepare(
          'SELECT e.id,e.account_id FROM transfer_archive_exports e WHERE e.payload_pruned_at IS NOT NULL AND EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id AND j.pin_owner IS NOT NULL) ORDER BY e.created_at,e.id LIMIT 1',
        )
        .first<{ id: string; account_id: string }>();
      if (pinned)
        changed += await this.releasePins(
          pinned.account_id,
          pinned.id,
          Math.floor((limit - changed) / 2),
        );
    } else if (changed < limit) {
      const pinned = await this.db
        .prepare(
          'SELECT e.id,e.account_id FROM transfer_archive_exports e WHERE e.payload_pruned_at IS NOT NULL AND EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id AND j.pin_owner IS NOT NULL) ORDER BY e.created_at,e.id LIMIT 1',
        )
        .first<{ id: string; account_id: string }>();
      if (pinned) changed += await this.releaseOnePin(pinned.account_id, pinned.id);
    }
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'DELETE FROM transfer_archive_export_records WHERE(export_id,item_key) IN(SELECT r.export_id,r.item_key FROM transfer_archive_export_records r JOIN transfer_archive_exports e ON e.id=r.export_id WHERE e.payload_pruned_at IS NOT NULL ORDER BY e.created_at,r.export_id,r.position LIMIT ?)',
          )
          .bind(limit - changed)
          .run()
      ).meta.changes;
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'DELETE FROM transfer_archive_export_jobs WHERE(export_id,item_key) IN(SELECT j.export_id,j.item_key FROM transfer_archive_export_jobs j JOIN transfer_archive_exports e ON e.id=j.export_id WHERE e.finished_at<=? AND j.pin_owner IS NULL ORDER BY e.created_at,j.export_id,j.item_key LIMIT ?)',
          )
          .bind(now - 90 * 86400000, limit - changed)
          .run()
      ).meta.changes;
    if (changed < limit)
      changed += (
        await this.db
          .prepare(
            'DELETE FROM transfer_archive_exports WHERE id IN(SELECT e.id FROM transfer_archive_exports e WHERE e.finished_at<=? AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_records r WHERE r.export_id=e.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_export_jobs j WHERE j.export_id=e.id) ORDER BY e.created_at,e.id LIMIT ?)',
          )
          .bind(now - 90 * 86400000, limit - changed)
          .run()
      ).meta.changes;
    return changed;
  }
}
