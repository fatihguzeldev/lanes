import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import {
  BeginCompletedDeletionSchema,
  ConfirmCompletedDeletionSchema,
} from '../../modules/tasks/completed-deletion-contract';
import type { CompletedTaskDeletionService } from '../../modules/tasks/server/completed-deletion';
import { jsonResponse, parseValue, readJson } from '../http';

const empty = z.object({}).strict();
const pageSchema = z
  .object({
    limit: z.number().int().min(1).max(10).default(10),
    cursor: z.string().min(1).max(48000).optional(),
  })
  .strict();

/** The composition owner already checked the owner session and account connection. */
export async function completedDeletionRoute(
  request: Request,
  url: URL,
  route: string[],
  accountId: string,
  ownerSubject: string,
  service: CompletedTaskDeletionService,
): Promise<Response | null> {
  if (route[3] !== 'lists' || !route[4] || route[5] !== 'completed-deletions') return null;
  const listId = route[4];
  const page = () => {
    const value = parseValue(pageSchema, {
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
    });
    return { limit: value.limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
  };
  if (route.length === 6) {
    if (request.method === 'GET')
      return jsonResponse(await service.list(accountId, listId, page()));
    if (request.method === 'POST') {
      const input = await readJson(request, BeginCompletedDeletionSchema);
      return jsonResponse(await service.begin({ ...input, accountId, listId, ownerSubject }), 202);
    }
    return null;
  }
  const id = route[6];
  if (!id) return null;
  const summary = await service.get(accountId, id);
  if (summary.listId !== listId)
    throw new AppError(
      'not_found',
      'this completed-task deletion was not found in this list.',
      404,
    );
  if (route.length === 7 && request.method === 'GET') return jsonResponse(summary);
  if (route.length !== 8) return null;
  if (route[7] === 'preview' && request.method === 'GET')
    return jsonResponse(await service.readPreview(accountId, id, page()));
  if (request.method !== 'POST') return null;
  if (route[7] === 'confirm')
    return jsonResponse(
      await service.confirm(accountId, id, await readJson(request, ConfirmCompletedDeletionSchema)),
    );
  if (!['capture', 'advance', 'resume', 'cancel'].includes(route[7] ?? '')) return null;
  await readJson(request, empty);
  if (route[7] === 'capture') return jsonResponse(await service.captureNext(accountId, id));
  if (route[7] === 'advance') return jsonResponse(await service.advance(accountId, id));
  if (route[7] === 'resume') return jsonResponse(await service.resume(accountId, id));
  return jsonResponse(await service.cancel(accountId, id));
}
