import { z } from 'zod';
import { AppError } from '../contracts/errors';
import { StartOAuthSchema } from '../modules/accounts/contracts';
import { initializeTaskWorkspace } from '../modules/tasks/server/workspace';
import { TaskQuerySchema, LabelQuerySchema } from '../modules/tasks/query-contract';
import { RefreshRequestSchema } from '../modules/tasks/sync-contract';
import { HistoryQuerySchema } from '../modules/history/contracts';
import { accountToday } from '../modules/tasks/planning';
import { createServices } from './services';
import { LocalSubmissionSchema, submitLocalCommand } from './local-commands';
import { ProviderCommandSchema } from '../modules/tasks/provider-command-contract';
import { OperationIdSchema } from '../modules/tasks/operation-contract';
import { readActiveList, readActiveLists } from '../modules/tasks/server/queries/lists';
import { ReopenRequestSchema } from '../modules/tasks/recurrence-contract';
import { parseConfiguration } from './env';
import type { Env } from './env';
import { errorResponse, jsonResponse, parseValue, readJson, requireSameOrigin } from './http';
import { templateRoute } from './template-routes';
import {
  ResolutionCandidatesRequestSchema,
  ResolutionConfirmSchema,
  ResolutionPreviewRequestSchema,
} from '../modules/tasks/resolution-contract';
import { lifecycleRoute } from './lifecycle-routes';
import { transferRoute } from './transfer-routes';
import { completedDeletionRoute } from './completed-deletion-routes';
import { advanceScheduledWork } from './scheduler';
import { runMaintenance } from './maintenance';
import { maintainAccounts } from '../modules/accounts/maintenance';

function pageOptions(url: URL) {
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    throw new AppError('validation_failed', 'choose a page size from 1 to 100.', 400);
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}
function parts(path: string): string[] {
  try {
    return path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new AppError('validation_failed', 'this resource address is invalid.', 400);
  }
}
function redirect(origin: string, path: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location: new URL(path, origin).href,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/'))
    return env.ASSETS.fetch(request);
  try {
    if (request.method === 'GET' && url.pathname === '/api/health')
      return jsonResponse({ service: 'lanes', apiVersion: 1 });
    let config;
    try {
      config = parseConfiguration(env);
    } catch (error) {
      if (
        request.method === 'GET' &&
        url.pathname === '/api/session' &&
        error instanceof AppError &&
        error.code === 'installation_unavailable'
      ) {
        return jsonResponse({ configured: false, authenticated: false, serverTime: Date.now() });
      }
      throw error;
    }
    const route = parts(url.pathname);
    const syncRead = route[0] === 'api' && route[1] === 'accounts' && route[3] === 'sync';
    const services = createServices(env, config, syncRead ? 10 : 4);
    const { accounts, boards, queries, history, operations, sync } = services;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      requireSameOrigin(request, config.origin);
      if (request.headers.get('x-lanes-api') !== '1')
        throw new AppError('conflict', 'reload lanes before submitting another change.', 409);
    }
    if (url.pathname === '/auth/google/start' && request.method === 'POST') {
      const result = await accounts.startOAuth(request, await readJson(request, StartOAuthSchema));
      return jsonResponse({ authorizationUrl: result.authorizationUrl }, 200, {
        'set-cookie': result.cookie,
      });
    }
    if (url.pathname === '/auth/google/callback' && request.method === 'GET') {
      try {
        const result = await accounts.finishOAuth(request);
        if (result.connectedAccountId) {
          try {
            await initializeTaskWorkspace(env.DB, result.connectedAccountId);
            await boards.ensureMainBoard(result.connectedAccountId);
            await sync.requestRefresh(result.connectedAccountId, { reason: 'reconnect' });
          } catch {
            // The grant has been saved. Keep it, and retry workspace initialization on entry.
            return redirect(config.origin, '/?connection_setup=pending', result.cookies);
          }
        }
        return redirect(config.origin, result.redirectPath, result.cookies);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'internal_error';
        return redirect(config.origin, '/?auth_error=' + encodeURIComponent(code));
      }
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      const session = await accounts.getSession(request);
      return jsonResponse({
        configured: true,
        authenticated: !!session,
        serverTime: Date.now(),
        ...(session ? { accounts: await accounts.listConnectionSummaries(request) } : {}),
      });
    }
    const owner = await accounts.requireSession(request);
    if (url.pathname === '/auth/signout' && request.method === 'POST') {
      await readJson(request, z.object({}).strict());
      const result = await accounts.signOut(request);
      const headers = new Headers();
      for (const cookie of result.cookies) headers.append('set-cookie', cookie);
      return jsonResponse({ signedOut: true }, 200, headers);
    }
    if (url.pathname === '/api/accounts' && request.method === 'GET')
      return jsonResponse(await accounts.listConnectionSummaries(request, pageOptions(url)));
    if (route[0] === 'api' && route[1] === 'accounts' && route[2]) {
      const accountId = route[2];
      if (route[3] === 'lifecycle') {
        const response = await lifecycleRoute(request, route, accounts, services.lifecycle);
        if (response) return response;
      }
      const account = await accounts.getConnectionSummary(request, accountId);
      if (route.length === 3 && request.method === 'GET') return jsonResponse(account);
      if (route[3] === 'lists' && route[5] === 'completed-deletions') {
        const response = await completedDeletionRoute(
          request,
          url,
          route,
          accountId,
          owner.subject,
          services.completedDeletion,
        );
        if (response) return response;
      }
      if (route[3] === 'transfer') {
        const response = await transferRoute(request, url, route, account, owner.subject, services);
        if (response) return response;
      }
      if (['templates', 'template-runs', 'template-schedules'].includes(route[3] ?? '')) {
        const response = await templateRoute(request, url, route, account, owner.subject, services);
        if (response) return response;
      }
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
        route[3] === 'commands' &&
        route[4] === 'local' &&
        request.method === 'POST'
      ) {
        const result = await submitLocalCommand(
          env.DB,
          config,
          request,
          accountId,
          owner.subject,
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
          ownerSubject: owner.subject,
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
        const input = await readJson(
          request,
          z.object({ command: ProviderCommandSchema }).strict(),
        );
        const [preview, capacity] = await Promise.all([
          services.commands.inspectDuplicate(accountId, input.command),
          operations.listCapacity(accountId),
        ]);
        return jsonResponse({ preview, capacity });
      }
      if (
        route.length === 6 &&
        route[3] === 'operations' &&
        route[4] &&
        route[5] === 'advance' &&
        request.method === 'POST'
      ) {
        await readJson(request, z.object({}).strict());
        const operation = await operations.get(route[4], accountId);
        if (!operation) throw new AppError('not_found', 'this operation was not found.', 404);
        if (operation.finished) {
          await services.templates.applications.reconcileOperation(accountId, route[4]);
          return jsonResponse(await operations.summary(route[4], accountId));
        }
        const captured = operation.input as { input?: unknown };
        const local = LocalSubmissionSchema.safeParse({
          operationId: operation.id,
          command: captured.input,
        });
        if (local.success)
          await submitLocalCommand(
            env.DB,
            config,
            request,
            accountId,
            owner.subject,
            local.data,
            Date.now(),
            { templateOwners: services.templateOwners },
          );
        else await services.commands.advance(accountId, route[4]);
        await services.templates.applications.reconcileOperation(accountId, route[4]);
        return jsonResponse(await operations.summary(route[4], accountId));
      }
      if (route[3] === 'operations' && route[4] && route[5] === 'resolution') {
        if (route.length === 6 && request.method === 'GET')
          return jsonResponse(await services.commands.resolutions.inspect(accountId, route[4]));
        if (route.length === 7 && request.method === 'POST') {
          if (route[6] === 'candidates') {
            const input = await readJson(request, ResolutionCandidatesRequestSchema);
            return jsonResponse(
              await services.commands.resolutions.candidates(accountId, route[4], input.cursor),
            );
          }
          if (route[6] === 'preview')
            return jsonResponse(
              await services.commands.resolutions.preview(
                accountId,
                route[4],
                await readJson(request, ResolutionPreviewRequestSchema),
              ),
            );
          if (route[6] === 'confirm') {
            await services.commands.resolutions.confirm(
              accountId,
              route[4],
              await readJson(request, ResolutionConfirmSchema),
            );
            return jsonResponse(await operations.summary(route[4], accountId));
          }
        }
      }
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
            ? await services.metadata.getLabelDeletion(
                accountId,
                url.searchParams.get('jobId') ?? '',
              )
            : await services.metadata.listPendingLabelDeletions(accountId, pageOptions(url)),
        );
      if (route.length === 5 && route[3] === 'lists' && route[4] && request.method === 'GET') {
        const list = await readActiveList(env.DB, accountId, route[4]);
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
      if (route.length >= 6 && route[3] === 'tasks' && route[4] && route[5] === 'recurrence') {
        const taskId = route[4];
        if (route.length === 6 && request.method === 'GET')
          return jsonResponse(await services.recurrence.status(accountId, taskId));
        if (route.length === 7 && route[6] === 'reopen-preview' && request.method === 'GET')
          return jsonResponse(await services.recurrence.previewReopen(accountId, taskId));
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
              await services.recurrence.requestReopen(accountId, owner.subject, value),
              202,
            );
          }
          if (route[6] === 'resume') {
            await readJson(request, z.object({}).strict());
            await services.recurrence.resume(accountId, taskId);
            return jsonResponse(await services.recurrence.status(accountId, taskId));
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
          readActiveLists(env.DB, accountId, value.ids),
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
      if (route.length === 4 && route[3] === 'operations' && request.method === 'GET')
        return jsonResponse(
          await operations.list(accountId, {
            ...pageOptions(url),
            activeOnly: url.searchParams.get('active') === '1',
          }),
        );
      if (route.length === 5 && route[3] === 'operations' && route[4] && request.method === 'GET') {
        const summary = await operations.summary(route[4], accountId);
        if (!summary) throw new AppError('not_found', 'this operation was not found.', 404);
        return jsonResponse(summary);
      }
      if (
        route.length === 6 &&
        route[3] === 'operations' &&
        route[4] &&
        route[5] === 'steps' &&
        request.method === 'GET'
      )
        return jsonResponse(await operations.steps(route[4], accountId, pageOptions(url)));
      if (
        route.length === 6 &&
        route[3] === 'operations' &&
        route[4] &&
        route[5] === 'progress' &&
        request.method === 'GET'
      )
        return jsonResponse(await operations.progress(route[4], accountId));
      if (
        route.length === 6 &&
        route[3] === 'operations' &&
        route[4] &&
        route[5] === 'unresolved-step' &&
        request.method === 'GET'
      )
        return jsonResponse({ step: await operations.firstUnresolvedStep(route[4], accountId) });
      if (
        route.length === 6 &&
        route[3] === 'operations' &&
        route[4] &&
        request.method === 'POST' &&
        ['cancel', 'resume'].includes(route[5] ?? '')
      ) {
        await readJson(request, z.object({}).strict());
        if (route[5] === 'cancel') await operations.cancel(route[4], accountId);
        else await operations.resume(route[4], accountId);
        await services.templates.applications.reconcileOperation(accountId, route[4]);
        return jsonResponse(await operations.summary(route[4], accountId));
      }
      if (route.length === 4 && route[3] === 'sync' && request.method === 'POST') {
        const input = await readJson(request, RefreshRequestSchema);
        if (['disconnected', 'disconnecting'].includes(account.state))
          throw new AppError(
            'reconnect_required',
            'reconnect this account to refresh its retained workspace.',
            409,
          );
        await initializeTaskWorkspace(env.DB, accountId);
        await boards.ensureMainBoard(accountId);
        await sync.requestRefresh(accountId, {
          reason: input.reason,
          ...(input.visibleListIds ? { visibleListIds: input.visibleListIds } : {}),
        });
        const result = await sync.advance(accountId);
        if ((await sync.getStatus(accountId)).initialized)
          await services.access.markWorkspaceInitialized(accountId);
        return jsonResponse(result);
      }
      if (
        route.length === 5 &&
        route[3] === 'sync' &&
        route[4] === 'advance' &&
        request.method === 'POST'
      ) {
        await readJson(request, z.object({}).strict());
        const result = await sync.advance(accountId);
        if ((await sync.getStatus(accountId)).initialized)
          await services.access.markWorkspaceInitialized(accountId);
        return jsonResponse(result);
      }
      if (route.length === 4 && route[3] === 'sync' && request.method === 'GET')
        return jsonResponse(await sync.getStatus(accountId));
    }
    throw new AppError('not_found', 'this lanes action is not available at this address.', 404);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export default {
  fetch: handleRequest,
  async scheduled(_controller: { scheduledTime: number }, env: Env): Promise<void> {
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
  },
};
