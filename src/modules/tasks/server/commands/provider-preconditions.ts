import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import type { CapturedStep } from './provider-command-state';
import type { GoogleTaskDTO, GoogleTasksClient } from '../provider';
import type { TaskQueries } from '../queries/tasks';

function conflict(
  message = 'this resource changed. refresh its confirmed values before reapplying the draft.',
): AppError {
  return new AppError('conflict', message, 409);
}

async function rebaseMove(
  db: D1Database,
  queries: TaskQueries,
  accountId: string,
  step: CapturedStep,
  current: GoogleTaskDTO,
): Promise<CapturedStep | null> {
  if (
    step.action !== 'task.move' ||
    !step.task ||
    !current.etag ||
    current.position === undefined ||
    current.position === step.task.provider.position ||
    current.deleted ||
    current.assignmentInfo ||
    step.task.capabilities.assignmentSource
  )
    return null;
  const cached = await queries.getTask(accountId, step.task.id);
  if (cached.revision !== step.task.revision) throw conflict();
  const address = await db
    .prepare(
      'SELECT provider_parent_id,provider_hidden FROM tasks_tasks WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL',
    )
    .bind(accountId, cached.id, cached.revision)
    .first<{ provider_parent_id: string | null; provider_hidden: number }>();
  if (
    !address ||
    current.id !== cached.provider.id ||
    current.title !== cached.title ||
    (current.notes ?? '') !== cached.notes ||
    current.status !== (cached.completed ? 'completed' : 'needsAction') ||
    (current.completed ?? null) !== cached.completedAt ||
    (current.due?.slice(0, 10) ?? null) !== cached.scheduledDay ||
    (current.parent ?? null) !== address.provider_parent_id ||
    Boolean(current.hidden) !== Boolean(address.provider_hidden)
  )
    return null;
  return {
    ...step,
    task: {
      ...step.task,
      provider: {
        ...step.task.provider,
        etag: current.etag,
        position: current.position,
        updatedAt: current.updated ?? null,
      },
    },
  };
}
export async function verifyProviderPreconditions(
  db: D1Database,
  queries: TaskQueries,
  accountId: string,
  client: GoogleTasksClient,
  step: CapturedStep,
): Promise<CapturedStep> {
  if (step.task) {
    const current = await client.getTask(step.list.providerId, step.task.provider.id);
    if (
      step.action === 'task.move' &&
      current.hidden &&
      current.status === 'completed' &&
      (step.parent || step.previous)
    )
      throw new AppError(
        'validation_failed',
        'google only permits a hidden completed task at the first top-level position.',
        422,
      );
    if (
      current.id !== step.task.provider.id ||
      (step.task.provider.etag !== null && current.etag !== step.task.provider.etag)
    ) {
      const rebased = await rebaseMove(db, queries, accountId, step, current);
      if (rebased) return rebased;
      throw conflict(
        'google changed this task after the editor captured it. refresh before reapplying.',
      );
    }
  }
  if (step.action === 'list.rename' || step.action === 'list.delete') {
    const current = await client.getTaskList(step.list.providerId);
    if (
      current.id !== step.list.providerId ||
      (step.list.providerEtag !== null && current.etag !== step.list.providerEtag)
    )
      throw conflict(
        'google changed this list after the editor captured it. refresh before reapplying.',
      );
  }
  return step;
}
