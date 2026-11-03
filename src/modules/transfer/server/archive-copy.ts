import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../contracts/errors';
import { OperationIdSchema } from '../../tasks/operation-contract';
import { ImportDestinationSchema, type ImportSummary } from '../server-contract';
import type { ArchiveRecord } from '../archive-contract';
import type { WorkspaceArchiveStore } from './archive-store';
import { canonicalJson, transferDigest, type TransferImportService } from './imports';
const schema = z
  .object({
    id: OperationIdSchema,
    ownerSubject: z.string().min(1).max(1024),
    destination: ImportDestinationSchema,
  })
  .strict();
interface CopyRow {
  archive_id: string;
  import_id: string;
  list_position: number;
  task_position: number;
  omitted_dependencies: number;
  state: string;
}
/** Snapshot copy uses normalized import; archived history is never attached to its new task identities. */
export class ArchiveSnapshotCopyService {
  constructor(
    private readonly db: D1Database,
    private readonly options: { store: WorkspaceArchiveStore; imports: TransferImportService },
  ) {}
  async begin(
    archiveId: string,
    accountId: string,
    input: z.input<typeof schema>,
  ): Promise<ImportSummary> {
    const selected = schema.safeParse(input);
    if (!selected.success)
      throw new AppError(
        'validation_failed',
        'choose a new explicit snapshot-copy operation and destination.',
        422,
      );
    const requestHash = await transferDigest(
      canonicalJson({ archiveId, accountId, ...selected.data }),
    );
    const prior = await this.db
      .prepare('SELECT archive_id,request_hash FROM transfer_archive_copies WHERE import_id=?')
      .bind(selected.data.id)
      .first<{ archive_id: string; request_hash: string | null }>();
    if (prior) {
      if (prior.archive_id !== archiveId || prior.request_hash !== requestHash)
        throw new AppError(
          'conflict',
          'this snapshot-copy identity belongs to a different captured archive or destination.',
          409,
        );
      return this.options.imports.get(selected.data.id, accountId);
    }
    const archive = await this.options.store.get(archiveId, accountId);
    if (
      archive.mode !== 'copy_task_snapshots' ||
      !['preview', 'finished'].includes(archive.state) ||
      !archive.header.includesTaskSnapshots
    )
      throw new AppError(
        'validation_failed',
        'validate an archive with included task snapshots and select snapshot-copy mode.',
        422,
      );
    const counts = await this.db
      .prepare(
        "SELECT SUM(kind='list') AS lists,SUM(kind='task') AS tasks FROM transfer_archive_records WHERE archive_id=?",
      )
      .bind(archiveId)
      .first<{ lists: number; tasks: number }>();
    const result = await this.options.imports.begin({
      id: selected.data.id,
      ownerSubject: selected.data.ownerSubject,
      accountId,
      source: { kind: 'archive', name: archive.header.id + '.json', version: 1 },
      destination: selected.data.destination,
      totalLists: counts?.lists ?? 0,
      totalTasks: counts?.tasks ?? 0,
      issueCount: null,
    });
    await this.db
      .prepare(
        'INSERT INTO transfer_archive_copies(archive_id,import_id,request_hash)VALUES(?,?,?) ON CONFLICT(import_id) DO NOTHING',
      )
      .bind(archiveId, selected.data.id, requestHash)
      .run();
    const copy = await this.db
      .prepare('SELECT archive_id FROM transfer_archive_copies WHERE import_id=?')
      .bind(selected.data.id)
      .first<{ archive_id: string }>();
    if (copy?.archive_id !== archiveId)
      throw new AppError(
        'conflict',
        'this copy identity belongs to a different frozen archive.',
        409,
      );
    return result;
  }
  async captureNext(importId: string, accountId: string): Promise<ImportSummary> {
    const summary = await this.options.imports.get(importId, accountId),
      copy = await this.db
        .prepare('SELECT * FROM transfer_archive_copies WHERE import_id=?')
        .bind(importId)
        .first<CopyRow>();
    if (!copy) throw new AppError('not_found', 'this snapshot-copy capture is not available.', 404);
    await this.options.store.row(copy.archive_id, accountId);
    if (copy.state === 'ready' || summary.state !== 'staging') return summary;
    const keys = (
      await this.db
        .prepare(
          "SELECT item_key,kind,ROW_NUMBER() OVER(PARTITION BY kind ORDER BY position)-1 AS ordinal FROM transfer_archive_records WHERE archive_id=? AND kind IN('list','task') ORDER BY position",
        )
        .bind(copy.archive_id)
        .all<{ item_key: string; kind: 'list' | 'task'; ordinal: number }>()
    ).results;
    const listKeys = new Map(
        keys
          .filter((row) => row.kind === 'list')
          .map((row) => [row.item_key, 'l' + (row.ordinal + 1)]),
      ),
      taskKeys = new Map(
        keys
          .filter((row) => row.kind === 'task')
          .map((row) => [row.item_key, 't' + (row.ordinal + 1)]),
      );
    if (copy.list_position < summary.totalLists) {
      const rows = (
        await this.db
          .prepare(
            "WITH selected AS(SELECT input_json,ROW_NUMBER() OVER(ORDER BY position)-1 AS ordinal FROM transfer_archive_records WHERE archive_id=? AND kind='list')SELECT * FROM selected WHERE ordinal>=? ORDER BY ordinal LIMIT 10",
          )
          .bind(copy.archive_id, copy.list_position)
          .all<{ input_json: string; ordinal: number }>()
      ).results;
      await this.options.imports.append(importId, accountId, {
        lists: rows.map((row) => {
          const record = JSON.parse(row.input_json) as Extract<ArchiveRecord, { kind: 'list' }>;
          return {
            position: row.ordinal,
            value: { key: listKeys.get(record.key)!, title: record.title },
          };
        }),
      });
      await this.db
        .prepare(
          'UPDATE transfer_archive_copies SET list_position=? WHERE import_id=? AND list_position=?',
        )
        .bind(copy.list_position + rows.length, importId, copy.list_position)
        .run();
      return this.options.imports.get(importId, accountId);
    }
    if (copy.task_position < summary.totalTasks) {
      const rows = (
        await this.db
          .prepare(
            "WITH selected AS(SELECT input_json,ROW_NUMBER() OVER(ORDER BY position)-1 AS ordinal FROM transfer_archive_records WHERE archive_id=? AND kind='task')SELECT * FROM selected WHERE ordinal>=? ORDER BY ordinal LIMIT 10",
          )
          .bind(copy.archive_id, copy.task_position)
          .all<{ input_json: string; ordinal: number }>()
      ).results;
      const selected: typeof rows = [];
      for (const row of rows) {
        if (
          selected.length &&
          new TextEncoder().encode(JSON.stringify([...selected, row])).byteLength > 60000
        )
          break;
        selected.push(row);
      }
      let omitted = 0;
      await this.options.imports.append(importId, accountId, {
        tasks: selected.map((row) => {
          const record = JSON.parse(row.input_json) as Extract<ArchiveRecord, { kind: 'task' }>;
          if (!record.snapshot)
            throw new AppError(
              'validation_failed',
              'a selected task has no captured task snapshot; choose metadata restore.',
              422,
            );
          omitted += record.dependencies.filter(
            (dependency) => !taskKeys.has(dependency.key),
          ).length;
          return {
            position: row.ordinal,
            labelDefinitions: record.labels.map(({ name, color }) => ({ name, color })),
            value: {
              key: taskKeys.get(record.key)!,
              listKey: listKeys.get(record.listKey)!,
              parentKey: record.parentKey ? taskKeys.get(record.parentKey)! : null,
              title: record.snapshot.title,
              notes: record.snapshot.notes,
              completed: record.snapshot.completed,
              completedAt: record.snapshot.completedAt,
              scheduledDay: record.scheduledDay,
              scheduledTime: record.scheduledTime,
              timeZone: record.timeZone,
              repeatRule: record.repeatRule,
              labels: record.labels.map((label) => label.name),
              priority: record.priority,
              starred: record.starred,
              dependencies: record.dependencies.flatMap((dependency) =>
                taskKeys.has(dependency.key) ? [taskKeys.get(dependency.key)!] : [],
              ),
              order: record.order,
            },
          };
        }),
      });
      await this.db
        .prepare(
          'UPDATE transfer_archive_copies SET task_position=?,omitted_dependencies=omitted_dependencies+? WHERE import_id=? AND task_position=?',
        )
        .bind(copy.task_position + selected.length, omitted, importId, copy.task_position)
        .run();
      return this.options.imports.get(importId, accountId);
    }
    if (copy.omitted_dependencies)
      await this.options.imports.append(importId, accountId, {
        issues: [
          {
            position: 0,
            value: {
              severity: 'warning',
              code: 'outside_dependencies',
              message: `${copy.omitted_dependencies} dependency references outside the included snapshots are omitted. original records and history remain unchanged.`,
            },
          },
        ],
      });
    const result = await this.options.imports.sealPreview(importId, accountId, [
      this.options.store.guard(
        "EXISTS(SELECT 1 FROM transfer_archives WHERE id=? AND account_id=? AND mode='copy_task_snapshots' AND state IN('preview','finished'))",
        [copy.archive_id, accountId],
      ),
    ]);
    if (result.state === 'preview')
      await this.db
        .prepare("UPDATE transfer_archive_copies SET state='ready' WHERE import_id=?")
        .bind(importId)
        .run();
    return result;
  }
}
