import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import type { Services } from '../services';
import type { AccountRouteContext } from './context';
import { jsonResponse, readJson } from '../http';
import { LocalSubmissionSchema, submitLocalCommand } from '../local-commands';
import { ProviderCommandSchema } from '../../modules/tasks/provider-command-contract';
import { OperationIdSchema } from '../../modules/tasks/operation-contract';
import type { D1Database } from '@cloudflare/workers-types';
import type { Configuration } from '../env';

export async function commandRoute(
  context: AccountRouteContext,
  services: Pick<Services, 'commands' | 'operations' | 'queries' | 'recurrence' | 'templateOwners'>,
  db: D1Database,
  config: Configuration,
): Promise<Response | null> {
  const { request, route, account, ownerSubject } = context;
  const accountId = account.id;
  const { operations, queries } = services;
  if (
    route.length === 5 &&
    route[3] === 'commands' &&
    route[4] === 'local' &&
    request.method === 'POST'
  ) {
    const result = await submitLocalCommand(
      db,
      config,
      request,
      accountId,
      ownerSubject,
      await readJson(request, LocalSubmissionSchema),
      Date.now(),
      { templateOwners: services.templateOwners },
    );
    return jsonResponse(result);
  }
  if (
    route.length === 5 &&
    route[3] === 'commands' &&
    route[4] === 'provider' &&
    request.method === 'POST'
  ) {
    const input = await readJson(
      request,
      z.object({ operationId: OperationIdSchema, command: ProviderCommandSchema }).strict(),
    );
    if (input.command.kind === 'task.reopen') {
      const task = await queries.getTask(accountId, input.command.taskId);
      const recurrence =
        task.repeatRule || task.seriesId
          ? await services.recurrence.status(accountId, task.id)
          : null;
      if (recurrence?.occurrenceId)
        throw new AppError(
          'conflict',
          'review the repeat occurrence and its successor before reopening it.',
          409,
        );
    }
    await services.commands.prepare({
      operationId: input.operationId,
      ownerSubject,
      accountId,
      command: input.command,
    });
    return jsonResponse(await operations.summary(input.operationId, accountId), 202);
  }
  if (
    route.length === 5 &&
    route[3] === 'copies' &&
    route[4] === 'preview' &&
    request.method === 'POST'
  ) {
    const input = await readJson(request, z.object({ command: ProviderCommandSchema }).strict());
    const [preview, capacity] = await Promise.all([
      services.commands.inspectDuplicate(accountId, input.command),
      operations.listCapacity(accountId),
    ]);
    return jsonResponse({ preview, capacity });
  }
  return null;
}
