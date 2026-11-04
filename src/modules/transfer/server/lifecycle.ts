import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../shared/contracts/errors';
import { assertDisconnecting, disconnectWorkGuard } from '../../accounts/server/connections/access';
import { accountRemovalGuard, type LifecycleOwner } from '../../accounts/server/lifecycle/removal';
import type { OperationStore } from '../../tasks/server/operations';
import type { TaskSnapshotReader } from '../../tasks/server/queries/snapshot-reader';
import type { TemplateDocumentStore } from '../../tasks/server/template-documents';
import type { ArchiveHeader } from '../archive-contract';
import { transferDigest } from './content-hash';
export interface TransferProviderLifecycle {
  pauseAccount(accountId: string, limit?: number): Promise<{ done: boolean; pending: boolean }>;
  removeAccountSlice(
    accountId: string,
    limit?: number,
  ): Promise<{ done: boolean; deleted: number }>;
  hasUnresolved?(accountId: string): Promise<boolean>;
  pendingProviderWork?(accountId: string): Promise<boolean>;
}
export interface TransferLifecycleOptions {
  operations: Pick<OperationStore, 'hasUnresolvedProviderWork'>;
  snapshots: Pick<TaskSnapshotReader, 'removeAccountSlice'>;
  documents?: Pick<TemplateDocumentStore, 'releaseCapturePins'>;
  sheets?: TransferProviderLifecycle;
  archiveExports?: TransferProviderLifecycle;
  now?: () => number;
}
/** Transfer settles before boards/tasks: its captures and document pins refer to their retained identities. */
export class TransferLifecycle implements LifecycleOwner {
  readonly name = 'transfer';
  constructor(
    private readonly db: D1Database,
    private readonly options: TransferLifecycleOptions,
  ) {}
  async hasUnresolved(accountId: string): Promise<boolean> {
    return (
      (await this.options.operations.hasUnresolvedProviderWork(accountId)) ||
      !!(await this.options.sheets?.hasUnresolved?.(accountId)) ||
      !!(await this.options.archiveExports?.hasUnresolved?.(accountId))
    );
  }
  async pendingProviderWork(accountId: string): Promise<boolean> {
    return (
      !!(await this.options.sheets?.pendingProviderWork?.(accountId)) ||
      !!(await this.options.archiveExports?.pendingProviderWork?.(accountId))
    );
  }
  async pause(accountId: string): Promise<{ done: boolean; pending: boolean }> {
    await assertDisconnecting(this.db, accountId);
    const now = this.options.now?.() ?? Date.now();
    const sheets = (await this.options.sheets?.pauseAccount(accountId, 10)) ?? {
        done: true,
        pending: false,
      },
      archives = (await this.options.archiveExports?.pauseAccount(accountId, 10)) ?? {
        done: true,
        pending: false,
      };
    const results = await this.db.batch([
      disconnectWorkGuard(this.db, accountId),
      this.db
        .prepare(
          `UPDATE transfer_imports SET paused=1,error_code='reconnect_required',updated_at=? WHERE id IN(SELECT id FROM transfer_imports WHERE account_id=? AND paused=0 AND state NOT IN('finished','cancelled') ORDER BY id LIMIT 10)`,
        )
        .bind(now, accountId),
      this.db
        .prepare(
          `UPDATE transfer_imports SET paused=1,error_code='reconnect_required',updated_at=? WHERE id IN(SELECT capture.import_id FROM transfer_account_captures capture JOIN transfer_imports job ON job.id=capture.import_id WHERE capture.source_account_id=? AND capture.state='capturing' AND job.paused=0 AND job.state='staging' ORDER BY capture.import_id LIMIT 10)`,
        )
        .bind(now, accountId),
      this.db
        .prepare(
          `UPDATE transfer_archives SET paused=1,updated_at=? WHERE id IN(SELECT id FROM transfer_archives WHERE account_id=? AND paused=0 AND state NOT IN('finished','cancelled') ORDER BY id LIMIT 10)`,
        )
        .bind(now, accountId),
      this.db
        .prepare(
          `SELECT 1 WHERE EXISTS(SELECT 1 FROM transfer_imports WHERE account_id=? AND paused=0 AND state NOT IN('finished','cancelled')) OR EXISTS(SELECT 1 FROM transfer_account_captures capture JOIN transfer_imports job ON job.id=capture.import_id WHERE capture.source_account_id=? AND capture.state='capturing' AND job.paused=0 AND job.state='staging') OR EXISTS(SELECT 1 FROM transfer_archives WHERE account_id=? AND paused=0 AND state NOT IN('finished','cancelled'))`,
        )
        .bind(accountId, accountId, accountId),
    ]);
    return {
      done: sheets.done && archives.done && !results[4]?.results.length,
      pending: sheets.pending || archives.pending,
    };
  }
  async remove(accountId: string, limit = 100): Promise<{ done: boolean; deleted: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'remove at most100 transfer records per slice.', 422);
    await accountRemovalGuard(this.db, accountId).run();
    if (await this.hasUnresolved(accountId))
      throw new AppError(
        'outcome_uncertain',
        'resolve issued provider outcomes before discarding their transfer evidence.',
        409,
      );
    let deleted = 0,
      componentsDone = true;
    for (const owner of [this.options.sheets, this.options.archiveExports]) {
      if (owner && deleted < limit) {
        const result = await owner.removeAccountSlice(accountId, limit - deleted);
        deleted += result.deleted;
        componentsDone &&= result.done;
      }
    }
    if (this.options.documents && deleted < limit) {
      const templates = (
        await this.db
          .prepare(
            "SELECT record.item_key,archive.id,archive.header_json FROM transfer_archive_records record JOIN transfer_archives archive ON archive.id=record.archive_id WHERE archive.account_id=? AND record.kind='template' ORDER BY record.rowid LIMIT ?",
          )
          .bind(accountId, Math.min(10, limit - deleted))
          .all<{ item_key: string; id: string; header_json: string }>()
      ).results;
      const ids = await Promise.all(
        templates.map(async (record) => {
          const header = JSON.parse(record.header_json) as ArchiveHeader;
          return (
            'archive-snapshot-' +
            (
              await transferDigest(
                header.source.googleSubject +
                  ':' +
                  header.id +
                  ':' +
                  record.item_key +
                  ':' +
                  record.id,
              )
            ).slice(0, 32)
          );
        }),
      );
      deleted += await this.options.documents.releaseCapturePins(accountId, ids);
    }
    const cleanup = [
      [
        'transfer_import_graph_edges',
        'import_id IN(SELECT id FROM transfer_imports WHERE account_id=?)',
      ],
      [
        'transfer_import_graph_nodes',
        'import_id IN(SELECT id FROM transfer_imports WHERE account_id=?)',
      ],
      [
        'transfer_archive_graph_edges',
        'archive_id IN(SELECT id FROM transfer_archives WHERE account_id=?)',
      ],
      [
        'transfer_archive_graph_nodes',
        'archive_id IN(SELECT id FROM transfer_archives WHERE account_id=?)',
      ],
      [
        'transfer_archive_template_labels',
        'archive_id IN(SELECT id FROM transfer_archives WHERE account_id=?)',
      ],
      [
        'transfer_archive_actions',
        'archive_id IN(SELECT id FROM transfer_archives WHERE account_id=?)',
      ],
      [
        'transfer_archive_copies',
        'import_id IN(SELECT id FROM transfer_imports WHERE account_id=?)',
      ],
      [
        'transfer_account_captures',
        'import_id IN(SELECT id FROM transfer_imports WHERE account_id=?)',
      ],
      [
        'transfer_import_records',
        'import_id IN(SELECT id FROM transfer_imports WHERE account_id=?)',
      ],
      [
        'transfer_archive_records',
        'archive_id IN(SELECT id FROM transfer_archives WHERE account_id=?)',
      ],
      [
        'transfer_imports',
        `account_id=? AND NOT EXISTS(SELECT 1 FROM transfer_import_graph_edges child WHERE child.import_id=transfer_imports.id) AND NOT EXISTS(SELECT 1 FROM transfer_import_graph_nodes child WHERE child.import_id=transfer_imports.id) AND NOT EXISTS(SELECT 1 FROM transfer_import_records child WHERE child.import_id=transfer_imports.id) AND NOT EXISTS(SELECT 1 FROM transfer_account_captures child WHERE child.import_id=transfer_imports.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_copies child WHERE child.import_id=transfer_imports.id)`,
      ],
      [
        'transfer_archives',
        `account_id=? AND NOT EXISTS(SELECT 1 FROM transfer_archive_graph_edges child WHERE child.archive_id=transfer_archives.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_graph_nodes child WHERE child.archive_id=transfer_archives.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_template_labels child WHERE child.archive_id=transfer_archives.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_records child WHERE child.archive_id=transfer_archives.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_actions child WHERE child.archive_id=transfer_archives.id) AND NOT EXISTS(SELECT 1 FROM transfer_archive_copies child WHERE child.archive_id=transfer_archives.id)`,
      ],
    ] as const;
    for (const [table, condition] of cleanup) {
      if (deleted === limit) break;
      const result = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE ${condition} LIMIT ?)`,
        )
        .bind(accountId, limit - deleted)
        .run();
      deleted += result.meta.changes;
    }
    const snapshots =
      deleted < limit
        ? await this.options.snapshots.removeAccountSlice(accountId, limit - deleted)
        : { done: false, deleted: 0 };
    deleted += snapshots.deleted;
    const pending = await this.db
      .prepare(
        'SELECT 1 FROM transfer_imports WHERE account_id=? UNION ALL SELECT 1 FROM transfer_archives WHERE account_id=? LIMIT 1',
      )
      .bind(accountId, accountId)
      .first();
    return { done: componentsDone && !pending && snapshots.done, deleted };
  }
}
