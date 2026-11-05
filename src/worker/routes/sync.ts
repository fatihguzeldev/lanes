import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import type { Services } from '../composition/services';
import type { AccountRouteContext } from './context';
import { jsonResponse, readJson } from '../protocol/http';
import { initializeTaskWorkspace } from '../../modules/tasks/server/lifecycle/workspace';
import { RefreshRequestSchema } from '../../modules/tasks/contracts/sync';
import type { D1Database } from '@cloudflare/workers-types';

export async function syncRoute(
  context: AccountRouteContext,
  services: Pick<Services, 'sync' | 'boards' | 'access'>,
  db: D1Database,
): Promise<Response | null> {
  const { request, route, account, url } = context;
  const accountId = account.id;
  const { sync, boards } = services;
  if (route.length === 4 && route[3] === 'sync' && request.method === 'POST') {
    const input = await readJson(request, RefreshRequestSchema);
    if (['disconnected', 'disconnecting'].includes(account.state))
      throw new AppError(
        'reconnect_required',
        'reconnect this account to refresh its retained workspace.',
        409,
      );
    await initializeTaskWorkspace(db, accountId);
    await boards.ensureMainBoard(accountId);
    await sync.requestRefresh(accountId, {
      reason: input.reason,
      ...(input.visibleListIds ? { visibleListIds: input.visibleListIds } : {}),
    });
    const result = await sync.advance(accountId);
    const status = await sync.getStatus(accountId);
    if (status.initialized) await services.access.markWorkspaceInitialized(accountId);
    return jsonResponse(url.searchParams.get('status') === '1' ? { ...result, status } : result);
  }
  if (
    route.length === 5 &&
    route[3] === 'sync' &&
    route[4] === 'advance' &&
    request.method === 'POST'
  ) {
    await readJson(request, z.object({}).strict());
    const result = await sync.advance(accountId);
    const status = await sync.getStatus(accountId);
    if (status.initialized) await services.access.markWorkspaceInitialized(accountId);
    return jsonResponse(url.searchParams.get('status') === '1' ? { ...result, status } : result);
  }
  if (route.length === 4 && route[3] === 'sync' && request.method === 'GET')
    return jsonResponse(await sync.getStatus(accountId));
  return null;
}
