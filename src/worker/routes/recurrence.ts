import { z } from 'zod';
import { ReopenRequestSchema } from '../../modules/tasks/contracts/recurrence';
import { AppError } from '../../shared/contracts/errors';
import type { Services } from '../composition/services';
import { jsonResponse, readJson } from '../protocol/http';
import type { AccountRouteContext } from './context';

export async function recurrenceRoute(
  context: AccountRouteContext,
  services: Pick<Services, 'recurrence'>,
): Promise<Response | null> {
  const { request, route, account, ownerSubject } = context;
  const accountId = account.id;
  if (route.length >= 6 && route[3] === 'tasks' && route[4] && route[5] === 'recurrence') {
    const taskId = route[4];
    if (route.length === 6 && request.method === 'GET')
      return jsonResponse(await services.recurrence.queries.status(accountId, taskId));
    if (route.length === 7 && route[6] === 'reopen-preview' && request.method === 'GET')
      return jsonResponse(await services.recurrence.reopening.previewReopen(accountId, taskId));
    if (request.method === 'POST' && route.length === 7) {
      if (account.state !== 'connected')
        throw new AppError(
          'reconnect_required',
          'reconnect this account before changing its repeat lifecycle.',
          409,
        );
      if (route[6] === 'reopen') {
        const value = await readJson(request, ReopenRequestSchema);
        if (value.taskId !== taskId)
          throw new AppError('validation_failed', 'this reopen belongs to another task.', 400);
        return jsonResponse(
          await services.recurrence.reopening.requestReopen(accountId, ownerSubject, value),
          202,
        );
      }
      if (route[6] === 'resume') {
        await readJson(request, z.object({}).strict());
        await services.recurrence.resume(accountId, taskId);
        return jsonResponse(await services.recurrence.queries.status(accountId, taskId));
      }
      if (route[6] === 'advance') {
        await readJson(request, z.object({}).strict());
        return jsonResponse(await services.recurrence.advance(accountId, taskId));
      }
    }
  }
  if (
    route.length === 5 &&
    route[3] === 'recurrence' &&
    route[4] === 'advance' &&
    request.method === 'POST'
  ) {
    await readJson(request, z.object({}).strict());
    return jsonResponse(await services.recurrence.advance(accountId));
  }
  return null;
}
