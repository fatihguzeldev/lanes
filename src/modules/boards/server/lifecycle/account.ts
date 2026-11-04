import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import {
  assertDisconnecting,
  disconnectWorkGuard,
} from '../../../accounts/server/connections/access';
import { accountRemovalGuard } from '../../../accounts/server/lifecycle/write-guards';
import { type LifecycleOwner } from '../../../accounts/server/lifecycle/coordinator';
import type { ListSnapshotStore } from '../../../tasks/server/templates/lists';

/** Board/template metadata settles before task-list removal; neither path deletes google content. */
export class BoardLifecycle implements LifecycleOwner {
  readonly name = 'boards';
  constructor(
    private readonly db: D1Database,
    private readonly snapshots: Pick<ListSnapshotStore, 'removeAccountSlice'>,
  ) {}
  async hasUnresolved(_accountId: string): Promise<boolean> {
    // The task operation journal owns every issued template create and its uncertainty.
    return false;
  }
  async pause(accountId: string): Promise<{ done: boolean; pending: boolean }> {
    await assertDisconnecting(this.db, accountId);
    const results = await this.db.batch([
      disconnectWorkGuard(this.db, accountId),
      this.db
        .prepare(
          `UPDATE boards_template_schedules SET state='paused',pause_reason='account_disconnected',catch_up_required=1,next_run_at=NULL,revision=revision+1
        WHERE id IN(SELECT id FROM boards_template_schedules WHERE account_id=? AND state='active' ORDER BY id LIMIT 25)`,
        )
        .bind(accountId),
      this.db
        .prepare(
          `UPDATE boards_template_runs SET state='paused',error_code='reconnect_required'
        WHERE id IN(SELECT id FROM boards_template_runs WHERE account_id=? AND state IN ('capturing','running','partial') ORDER BY id LIMIT 25)`,
        )
        .bind(accountId),
      this.db
        .prepare(
          `SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM boards_template_schedules WHERE account_id=? AND state='active')
        OR EXISTS(SELECT 1 FROM boards_template_runs WHERE account_id=? AND state IN ('capturing','running','partial'))`,
        )
        .bind(accountId, accountId),
    ]);
    return { done: !results[3]?.results.length, pending: false };
  }
  async remove(accountId: string, limit = 100): Promise<{ done: boolean; deleted: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('validation_failed', 'remove at most100 board records per slice.', 400);
    await accountRemovalGuard(this.db, accountId).run();
    let remaining = limit,
      deleted = 0;
    const remove = async (table: string, condition: string) => {
      if (!remaining) return;
      const result = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE ${condition} LIMIT ?)`,
        )
        .bind(accountId, remaining)
        .run();
      deleted += result.meta.changes;
      remaining -= result.meta.changes;
    };
    await remove(
      'boards_template_skips',
      'schedule_id IN(SELECT id FROM boards_template_schedules WHERE account_id=?)',
    );
    await remove('boards_template_runs', 'account_id=?');
    await remove(
      'boards_template_schedules',
      'account_id=? AND NOT EXISTS(SELECT 1 FROM boards_template_skips s WHERE s.schedule_id=boards_template_schedules.id)',
    );
    await remove(
      'boards_template_versions',
      'template_id IN(SELECT id FROM boards_templates WHERE account_id=?)',
    );
    await remove(
      'boards_templates',
      'account_id=? AND NOT EXISTS(SELECT 1 FROM boards_template_versions v WHERE v.template_id=boards_templates.id)',
    );
    const definitions = await this.db
      .prepare(
        `SELECT 1 WHERE EXISTS(SELECT 1 FROM boards_templates WHERE account_id=?)
      OR EXISTS(SELECT 1 FROM boards_template_schedules WHERE account_id=?) OR EXISTS(SELECT 1 FROM boards_template_runs WHERE account_id=?)`,
      )
      .bind(accountId, accountId, accountId)
      .first();
    if (definitions || !remaining) return { done: false, deleted };
    const snapshots = await this.snapshots.removeAccountSlice(accountId, remaining);
    deleted += snapshots.deleted;
    remaining -= snapshots.deleted;
    if (!snapshots.done || !remaining) return { done: false, deleted };
    await remove('boards_memberships', 'account_id=?');
    await remove(
      'boards_boards',
      'account_id=? AND NOT EXISTS(SELECT 1 FROM boards_memberships m WHERE m.account_id=boards_boards.account_id AND m.board_id=boards_boards.id)',
    );
    const boards = await this.db
      .prepare('SELECT 1 FROM boards_boards WHERE account_id=? LIMIT 1')
      .bind(accountId)
      .first();
    return { done: boards === null, deleted };
  }
}
