import type { D1Database } from '@cloudflare/workers-types';
import { maintainAccounts } from '../../modules/accounts/server/session/maintenance';
import { maintainAccountLifecycle } from '../../modules/accounts/server/lifecycle/link-fence';
import type { createServices } from '../composition/services';
/** Each invocation cleans one owner/payload family, keeping expensive cleanup out of a single tick. */
export async function runMaintenance(
  db: D1Database,
  services: ReturnType<typeof createServices>,
): Promise<void> {
  const row = await db
    .prepare(
      'UPDATE worker_scheduler SET maintenance_turn=maintenance_turn+1 WHERE singleton=1 RETURNING maintenance_turn',
    )
    .first<{ maintenance_turn: number }>();
  const work = [
    async () => {
      await maintainAccounts(db);
    },
    async () => {
      await maintainAccountLifecycle(db);
    },
    async () => {
      await services.history.cleanup();
    },
    async () => {
      await services.commands.cleanupCaptures(50);
    },
    async () => {
      await services.operations.pruneTerminalPayloads(50);
    },
    async () => {
      await services.operations.cleanup();
    },
    async () => {
      await services.templates.snapshots.cleanup(100);
    },
    async () => {
      await services.transfer.retention.cleanup(100);
    },
    async () => {
      await services.completedDeletion.cleanup(100);
    },
  ];
  await work[((row?.maintenance_turn ?? 1) - 1) % work.length]!();
}
