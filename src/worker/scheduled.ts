import { parseConfiguration, type Env } from './env';
import { createServices } from './services';
import { advanceScheduledWork } from './scheduler';
import { runMaintenance } from './maintenance';
import { maintainAccounts } from '../modules/accounts/server/session/maintenance';
export async function handleScheduled(
  _controller: { scheduledTime: number },
  env: Env,
): Promise<void> {
  // Invalid/incomplete installations remain closed and perform no scheduled work.
  let config;
  try {
    config = parseConfiguration(env);
  } catch {
    return;
  }
  const services = createServices(env, config, 10);
  const row = await env.DB.prepare(
    'UPDATE worker_scheduler SET turn=turn+1 WHERE singleton=1 RETURNING turn',
  ).first<{ turn: number }>();
  const work = [
    async () => {
      const result = await services.commands.advanceNext();
      if (!result) return false;
      await services.templates.applications.reconcileOperation(
        result.operation.accountId,
        result.operation.id,
      );
      return true;
    },
    async () => (await services.sync.advanceNext()).accountId !== null,
    async () => (await services.recurrence.advanceNext()).advanced,
    async () => (await services.templates.schedules.advanceOne()).kind !== 'idle',
    async () => !!(await services.transfer.imports.advanceNext()),
    async () => !!(await services.transfer.sheetsExports.advanceNext()),
    async () => !!(await services.transfer.restore.advanceNext()),
    async () => !!(await services.transfer.archiveExports.advanceNext()),
    async () => services.labelWork.advanceNext(),
    async () => !!(await services.completedDeletion.advanceNext()),
    async () => !!(await services.lifecycle.advanceNextDisconnect()),
    async () => !!(await services.lifecycle.advanceNextRemoval()),
  ];
  await advanceScheduledWork(
    row?.turn ?? 1,
    work,
    () => runMaintenance(env.DB, services),
    () => maintainAccounts(env.DB),
  );
}
