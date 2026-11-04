import { z } from 'zod';
import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import {
  ApplyTemplateSchema,
  TemplateReferenceSchema,
} from '../../modules/boards/contracts/template';
import {
  BoardTemplateSourceSchema,
  ListTemplateSourceSchema,
} from '../../modules/boards/contracts/template-commands';
import {
  SnapshotPageOptionsSchema,
  TemplateApplicationOptionsSchema,
  TemplatePageOptionsSchema,
} from '../../modules/tasks/contracts/template';
import { OperationIdSchema } from '../../modules/operations/contracts/receipt';
import { accountToday } from '../../modules/tasks/model/planning';
import type { createServices } from '../services';
import { jsonResponse, parseValue, readJson } from '../http';

/** Authenticated HTTP composition; template rules and storage stay with their owners. */
export async function templateRoute(
  request: Request,
  url: URL,
  route: string[],
  account: ConnectionSummary,
  ownerSubject: string,
  services: ReturnType<typeof createServices>,
): Promise<Response | null> {
  const accountId = account.id,
    { templates, operations } = services;
  const method = request.method;
  const page = () =>
    parseValue(TemplatePageOptionsSchema, {
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
    });
  if (route[3] === 'templates') {
    if (route.length === 5 && route[4] === 'gallery' && method === 'GET') {
      const kind = parseValue(z.enum(['list', 'board']), url.searchParams.get('kind'));
      return jsonResponse({
        items:
          kind === 'list' ? templates.listTemplates.gallery() : templates.boardTemplates.gallery(),
      });
    }
    const kind = route[4];
    if (kind === 'list' || kind === 'board') {
      const owner = kind === 'list' ? templates.listTemplates : templates.boardTemplates;
      if (route.length === 5 && method === 'GET')
        return jsonResponse(await owner.list(accountId, page()));
      if (route.length === 6 && route[5] === 'source-preview' && method === 'POST') {
        const value = await readJson(
          request,
          z
            .object({
              input: kind === 'list' ? ListTemplateSourceSchema : BoardTemplateSourceSchema,
            })
            .strict(),
        );
        return jsonResponse(
          await owner.previewSource(accountId, value.input, {
            operationId: 'preview',
            stepKey: 'preview',
            origin: 'owner',
            recordedAt: new Date().toISOString(),
            saveDay: accountToday(account.planningZone),
            zone: account.planningZone,
          }),
        );
      }
      if (route.length === 6 && route[5] && method === 'GET')
        return jsonResponse(await owner.get(accountId, route[5]));
    }
    if (
      route.length === 7 &&
      route[4] === 'snapshots' &&
      route[5] &&
      method === 'GET' &&
      (route[6] === 'lists' || route[6] === 'tasks')
    ) {
      const options = parseValue(SnapshotPageOptionsSchema, {
        ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
        ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
      });
      return jsonResponse(
        await templates.snapshots[route[6] === 'lists' ? 'listLists' : 'listTasks'](
          accountId,
          route[5],
          options,
        ),
      );
    }
    if (route.length === 5 && route[4] === 'application-preview' && method === 'POST') {
      const value = await readJson(
        request,
        z
          .object({ template: TemplateReferenceSchema, options: TemplateApplicationOptionsSchema })
          .strict(),
      );
      const [preview, capacity] = await Promise.all([
        templates.applications.preview(accountId, value.template, value.options),
        operations.listCapacity(accountId),
      ]);
      return jsonResponse({ preview, capacity });
    }
    if (route.length === 5 && route[4] === 'label-conflicts' && method === 'POST') {
      const value = await readJson(
        request,
        TemplatePageOptionsSchema.extend({ template: TemplateReferenceSchema }).strict(),
      );
      const { template, ...options } = value;
      return jsonResponse(
        await templates.applications.labelColorConflicts(accountId, template, options),
      );
    }
  }
  if (route[3] === 'template-runs') {
    if (route.length === 4 && method === 'GET')
      return jsonResponse(await templates.applications.list(accountId, page()));
    if (route.length === 4 && method === 'POST') {
      const value = await readJson(
        request,
        z.object({ operationId: OperationIdSchema, input: ApplyTemplateSchema }).strict(),
      );
      return jsonResponse(
        await templates.applications.begin(accountId, value.input, {
          operationId: value.operationId,
          ownerSubject,
        }),
        202,
      );
    }
    if (route.length === 5 && route[4] && method === 'GET')
      return jsonResponse(await templates.applications.get(accountId, route[4]));
    if (
      route.length === 6 &&
      route[4] &&
      method === 'POST' &&
      (route[5] === 'advance' || route[5] === 'resume' || route[5] === 'cancel')
    ) {
      await readJson(request, z.object({}).strict());
      return jsonResponse(await templates.applications[route[5]](accountId, route[4]));
    }
  }
  if (route[3] === 'template-schedules' && method === 'GET') {
    if (route.length === 4) return jsonResponse(await templates.schedules.list(accountId, page()));
    if (route.length === 5 && route[4])
      return jsonResponse(await templates.schedules.get(accountId, route[4]));
  }
  return null;
}
