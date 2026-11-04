import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import type { Services } from '../composition/services';
import type { AccountRouteContext } from './context';
import { jsonResponse, readJson, pageOptions } from '../protocol/http';
import { LocalSubmissionSchema, submitLocalCommand } from '../composition/local-commands';
import {
  ResolutionCandidatesRequestSchema,
  ResolutionConfirmSchema,
  ResolutionPreviewRequestSchema,
} from '../../modules/tasks/contracts/resolution';
import type { D1Database } from '@cloudflare/workers-types';
import type { Configuration } from '../configuration/env';

export async function operationRoute(
  context: AccountRouteContext,
  services: Pick<Services, 'commands' | 'operations' | 'templates' | 'templateOwners'>,
  db: D1Database,
  config: Configuration,
): Promise<Response | null> {
  const { request, url, route, account, ownerSubject } = context;
  const accountId = account.id;
  const { operations } = services;
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
      return jsonResponse(await operations.queries.summary(route[4], accountId));
    }
    const captured = operation.input as { input?: unknown };
    const local = LocalSubmissionSchema.safeParse({
      operationId: operation.id,
      command: captured.input,
    });
    if (local.success)
      await submitLocalCommand(
        db,
        config,
        request,
        accountId,
        ownerSubject,
        local.data,
        Date.now(),
        { templateOwners: services.templateOwners },
      );
    else await services.commands.advance(accountId, route[4]);
    await services.templates.applications.reconcileOperation(accountId, route[4]);
    return jsonResponse(await operations.queries.summary(route[4], accountId));
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
        return jsonResponse(await operations.queries.summary(route[4], accountId));
      }
    }
  }
  if (route.length === 4 && route[3] === 'operations' && request.method === 'GET')
    return jsonResponse(
      await operations.queries.list(accountId, {
        ...pageOptions(url),
        activeOnly: url.searchParams.get('active') === '1',
      }),
    );
  if (route.length === 5 && route[3] === 'operations' && route[4] && request.method === 'GET') {
    const summary = await operations.queries.summary(route[4], accountId);
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
    return jsonResponse(await operations.queries.steps(route[4], accountId, pageOptions(url)));
  if (
    route.length === 6 &&
    route[3] === 'operations' &&
    route[4] &&
    route[5] === 'progress' &&
    request.method === 'GET'
  )
    return jsonResponse(await operations.queries.progress(route[4], accountId));
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
    return jsonResponse(await operations.queries.summary(route[4], accountId));
  }
  return null;
}
