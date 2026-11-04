import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import type { Services } from '../composition/services';
import type { AccountRouteContext } from './context';
import { jsonResponse, parseValue, readJson, pageOptions } from '../protocol/http';
import { TaskQuerySchema, LabelQuerySchema } from '../../modules/tasks/contracts/query';
import { HistoryQuerySchema } from '../../modules/history/contracts/query';
import { accountToday } from '../../modules/tasks/model/planning';
import { readActiveList, readActiveLists } from '../../modules/tasks/server/queries/lists';
import type { D1Database } from '@cloudflare/workers-types';

export async function workspaceQueryRoute(
  context: AccountRouteContext,
  services: Pick<
    Services,
    'boards' | 'queries' | 'history' | 'metadata' | 'boardProjection' | 'commands'
  >,
  db: D1Database,
): Promise<Response | null> {
  const { request, url, route, account } = context;
  const accountId = account.id;
  const { boards, queries, history } = services;
  if (route.length === 4 && route[3] === 'boards' && request.method === 'GET')
    return jsonResponse(await boards.listBoards(accountId, pageOptions(url)));
  if (route.length === 5 && route[3] === 'boards' && route[4] && request.method === 'GET')
    return jsonResponse(await boards.getBoard(accountId, route[4]));
  if (
    route.length === 6 &&
    route[3] === 'boards' &&
    route[4] &&
    route[5] === 'lists' &&
    request.method === 'GET'
  )
    return jsonResponse(await boards.listBoardLists(accountId, route[4], pageOptions(url)));
  if (
    route.length === 5 &&
    route[3] === 'tasks' &&
    route[4] === 'query' &&
    request.method === 'POST'
  ) {
    return jsonResponse(
      await queries.listTasks(accountId, await readJson(request, TaskQuerySchema), {
        today: accountToday(account.planningZone),
      }),
    );
  }
  if (
    route.length === 6 &&
    route[3] === 'tasks' &&
    route[4] &&
    route[5] === 'dependants' &&
    request.method === 'GET'
  )
    return jsonResponse(await queries.readDependants(accountId, route[4], pageOptions(url)));
  if (route.length === 5 && route[3] === 'tasks' && route[4] && request.method === 'GET')
    return jsonResponse(await queries.getTask(accountId, route[4]));
  if (route.length === 4 && route[3] === 'labels' && request.method === 'GET') {
    return jsonResponse(
      await queries.readLabels(
        accountId,
        parseValue(LabelQuerySchema, {
          ...pageOptions(url),
          query: url.searchParams.get('query') ?? '',
        }),
      ),
    );
  }
  if (
    route.length === 5 &&
    route[3] === 'labels' &&
    route[4] === 'deletions' &&
    request.method === 'GET'
  )
    return jsonResponse(
      url.searchParams.has('jobId')
        ? await services.metadata.labelDeletions.getLabelDeletion(
            accountId,
            url.searchParams.get('jobId') ?? '',
          )
        : await services.metadata.labelDeletions.listPendingLabelDeletions(
            accountId,
            pageOptions(url),
          ),
    );
  if (route.length === 5 && route[3] === 'lists' && route[4] && request.method === 'GET') {
    const list = await readActiveList(db, accountId, route[4]);
    if (!list) throw new AppError('not_found', 'this list was not found.', 404);
    return jsonResponse(list);
  }
  if (
    route.length === 6 &&
    route[3] === 'lists' &&
    route[4] &&
    route[5] === 'placement' &&
    request.method === 'GET'
  )
    return jsonResponse(await boards.getMembership(accountId, route[4]));
  if (
    route.length === 6 &&
    route[3] === 'tasks' &&
    route[4] &&
    route[5] === 'consequences' &&
    request.method === 'GET'
  )
    return jsonResponse(await services.commands.inspectTask(accountId, route[4]));
  if (
    route.length === 6 &&
    route[3] === 'lists' &&
    route[4] &&
    route[5] === 'consequences' &&
    request.method === 'GET'
  )
    return jsonResponse(await services.commands.inspectList(accountId, route[4]));
  if (route.length === 4 && route[3] === 'dependency-graph' && request.method === 'GET')
    return jsonResponse({ revision: await services.metadata.getGraphRevision(accountId) });
  if (
    route.length === 5 &&
    route[3] === 'tasks' &&
    route[4] === 'resolve' &&
    request.method === 'POST'
  ) {
    const value = await readJson(
      request,
      z.object({ ids: z.array(z.string().min(1).max(1024)).max(100) }).strict(),
    );
    return jsonResponse({ items: await queries.getTasksByIds(accountId, value.ids) });
  }
  if (
    route.length === 5 &&
    route[3] === 'labels' &&
    route[4] === 'resolve' &&
    request.method === 'POST'
  ) {
    const value = await readJson(
      request,
      z.object({ ids: z.array(z.string().min(1).max(1024)).max(100) }).strict(),
    );
    return jsonResponse({ items: await queries.readLabelsByIds(accountId, value.ids) });
  }
  if (
    route.length === 5 &&
    route[3] === 'lists' &&
    route[4] === 'resolve' &&
    request.method === 'POST'
  ) {
    const value = await readJson(
      request,
      z.object({ ids: z.array(z.string().min(1).max(1024)).max(100) }).strict(),
    );
    const [items, contexts] = await Promise.all([
      readActiveLists(db, accountId, value.ids),
      services.boardProjection.listContexts(accountId, value.ids),
    ]);
    return jsonResponse({ items, contexts });
  }
  if (route.length === 4 && route[3] === 'history' && request.method === 'GET') {
    const input = parseValue(HistoryQuerySchema, {
      ...pageOptions(url),
      ...(url.searchParams.has('boardId') ? { boardId: url.searchParams.get('boardId') } : {}),
      ...(url.searchParams.has('listId') ? { listId: url.searchParams.get('listId') } : {}),
      ...(url.searchParams.has('taskId') ? { taskId: url.searchParams.get('taskId') } : {}),
    });
    return jsonResponse(await history.query(accountId, input));
  }
  return null;
}
