import type { D1Database } from '@cloudflare/workers-types';
import type { Configuration } from '../configuration/env';
import type { Services } from '../composition/services';
import { jsonResponse } from '../protocol/http';
import { lifecycleRoute } from './lifecycle';
import { transferRoute } from './transfer';
import { templateRoute } from './templates';
import { completedDeletionRoute } from './completed-deletion';
import { workspaceQueryRoute } from './queries';
import { commandRoute } from './commands';
import { operationRoute } from './operations';
import { recurrenceRoute } from './recurrence';
import { syncRoute } from './sync';

/** Lifecycle receipts are resolved before a connection that may already have been removed. */
export async function accountRoute(
  request: Request,
  url: URL,
  route: string[],
  ownerSubject: string,
  services: Services,
  db: D1Database,
  config: Configuration,
): Promise<Response | null> {
  if (route[0] !== 'api' || route[1] !== 'accounts' || !route[2]) return null;
  const accountId = route[2];
  if (route[3] === 'lifecycle') {
    const response = await lifecycleRoute(request, route, services.accounts, services.lifecycle);
    if (response) return response;
  }
  const account = await services.accounts.connections.getConnectionSummary(request, accountId);
  if (route.length === 3 && request.method === 'GET') return jsonResponse(account);
  const context = { request, url, route, account, ownerSubject };
  if (route[3] === 'lists' && route[5] === 'completed-deletions') {
    const response = await completedDeletionRoute(
      request,
      url,
      route,
      accountId,
      ownerSubject,
      services.completedDeletion,
    );
    if (response) return response;
  }
  if (route[3] === 'transfer')
    return transferRoute(request, url, route, account, ownerSubject, services);
  if (['templates', 'template-runs', 'template-schedules'].includes(route[3] ?? ''))
    return templateRoute(request, url, route, account, ownerSubject, services);
  if (route[3] === 'commands' || route[3] === 'copies')
    return commandRoute(context, services, db, config);
  if (route[3] === 'operations') return operationRoute(context, services, db, config);
  if (route[3] === 'sync') return syncRoute(context, services, db);
  if (route[3] === 'recurrence' || (route[3] === 'tasks' && route[5] === 'recurrence'))
    return recurrenceRoute(context, services);
  return workspaceQueryRoute(context, services, db);
}
