import type { Services } from '../../composition/services';
import type { AccountRouteContext } from '../context';

import { z } from 'zod';
import { LabelInputSchema } from '../../../modules/tasks/contracts/task';
import { normalizeLabelName } from '../../../modules/tasks/model/task';
import {
  BeginImportSchema,
  ConfirmImportSchema,
  ImportChunkSchema,
} from '../../../modules/transfer/contracts/import';
import { jsonResponse, parseValue, readJson } from '../../protocol/http';
import { transferPage, recordPage } from './pagination';
const BeginImportRequestSchema = z
  .object(BeginImportSchema.shape)
  .omit({ accountId: true, ownerSubject: true })
  .strict();
const empty = z.object({}).strict();
export async function transferImportRoute(
  context: AccountRouteContext,
  imports: Services['transfer']['imports'],
  queries: Services['queries'],
): Promise<Response | null> {
  const { request, url, route, account, ownerSubject } = context;
  const accountId = account.id,
    method = request.method;
  if (route.length === 6 && route[4] === 'labels' && route[5] === 'compare' && method === 'POST') {
    const input = await readJson(
      request,
      z.object({ definitions: z.array(LabelInputSchema).max(200) }).strict(),
    );
    const current = new Map<string, string>();
    for (let offset = 0; offset < input.definitions.length; offset += 100) {
      const labels = await queries.labels.readLabelsByNames(
        accountId,
        input.definitions.slice(offset, offset + 100).map((label) => label.name),
      );
      for (const label of labels) current.set(normalizeLabelName(label.name), label.color);
    }
    return jsonResponse({
      items: input.definitions.map((label) => {
        const currentColor = current.get(normalizeLabelName(label.name)) ?? null;
        return {
          name: label.name,
          incomingColor: label.color,
          currentColor,
          conflict: currentColor !== null && currentColor !== label.color,
        };
      }),
    });
  }
  if (route[4] === 'imports') {
    if (route.length === 5 && method === 'GET')
      return jsonResponse(await imports.list(accountId, transferPage(url)));
    if (route.length === 5 && method === 'POST') {
      const input = await readJson(request, BeginImportRequestSchema);
      return jsonResponse(await imports.begin({ ...input, accountId, ownerSubject }), 202);
    }
    const importId = route[5];
    if (importId && route.length === 6 && method === 'GET')
      return jsonResponse(await imports.get(importId, accountId));
    if (importId && route.length === 7 && method === 'GET') {
      if (route[6] === 'records') {
        const options = recordPage(url, 'cursor');
        return jsonResponse(
          await imports.readPreviewRecords(importId, accountId, {
            kind: parseValue(z.enum(['list', 'task', 'issue']), url.searchParams.get('kind')),
            ...(options.after === undefined ? {} : { cursor: options.after }),
            limit: options.limit,
          }),
        );
      }
      if (route[6] === 'output')
        return jsonResponse(await imports.output(importId, accountId, transferPage(url)));
    }
    if (importId && route.length === 7 && method === 'POST') {
      if (route[6] === 'chunks')
        return jsonResponse(
          await imports.append(importId, accountId, await readJson(request, ImportChunkSchema)),
        );
      if (route[6] === 'confirm')
        return jsonResponse(
          await imports.confirm(importId, accountId, await readJson(request, ConfirmImportSchema)),
          202,
        );
      if (['preview', 'advance', 'resume', 'cancel'].includes(route[6] ?? '')) {
        await readJson(request, empty);
        if (route[6] === 'preview')
          return jsonResponse(await imports.sealPreview(importId, accountId));
        if (route[6] === 'advance') return jsonResponse(await imports.advance(importId, accountId));
        if (route[6] === 'resume') return jsonResponse(await imports.resume(importId, accountId));
        return jsonResponse(await imports.cancel(importId, accountId));
      }
    }
  }
  return null;
}
