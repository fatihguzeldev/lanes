import type { Services } from '../../services';
import type { AccountRouteContext } from '../context';

import { z } from 'zod';
import { OperationIdSchema } from '../../../modules/tasks/operation-contract';
import { ImportDestinationSchema } from '../../../modules/transfer/server-contract';
import {
  ArchiveCaptureChunkSchema,
  ArchiveChoiceChunkSchema,
  ArchiveExportSelectionSchema,
  ArchiveHeaderSchema,
  ArchiveImportModeSchema,
} from '../../../modules/transfer/archive-contract';
import { jsonResponse, readJson } from '../../http';
import { transferPage, recordPage } from './pagination';
const BeginArchiveRequestSchema = z
  .object({
    id: OperationIdSchema,
    mode: ArchiveImportModeSchema,
    header: ArchiveHeaderSchema,
    recordCount: z.number().int().min(0).max(100000),
  })
  .strict();
const empty = z.object({}).strict(),
  revision = z.number().int().nonnegative().safe();
export async function archiveTransferRoute(
  context: AccountRouteContext,
  transfer: Pick<Services['transfer'], 'archives' | 'archiveExports' | 'archiveCopy' | 'restore'>,
): Promise<Response | null> {
  const { request, url, route, account, ownerSubject } = context;
  const accountId = account.id,
    method = request.method;
  if (route[4] === 'archives') {
    if (route[5] === 'exports') {
      if (route.length === 6 && method === 'GET')
        return jsonResponse(await transfer.archiveExports.list(accountId, transferPage(url)));
      if (route.length === 6 && method === 'POST') {
        const input = await readJson(
          request,
          ArchiveExportSelectionSchema.omit({ accountId: true }),
        );
        return jsonResponse(await transfer.archiveExports.begin({ ...input, accountId }), 202);
      }
      const exportId = route[6];
      if (exportId && route.length === 7 && method === 'GET')
        return jsonResponse(await transfer.archiveExports.get(accountId, exportId));
      if (exportId && route.length === 8 && route[7] === 'download' && method === 'GET')
        return jsonResponse(
          await transfer.archiveExports.downloadPage(accountId, exportId, transferPage(url)),
        );
      if (
        exportId &&
        route.length === 8 &&
        method === 'POST' &&
        (route[7] === 'capture' || route[7] === 'cancel')
      ) {
        await readJson(request, empty);
        return jsonResponse(
          route[7] === 'capture'
            ? await transfer.archiveExports.captureNext(accountId, exportId)
            : await transfer.archiveExports.cancel(accountId, exportId),
        );
      }
      return null;
    }
    if (route.length === 5 && method === 'GET')
      return jsonResponse(await transfer.archives.list(accountId, transferPage(url)));
    if (route.length === 5 && method === 'POST') {
      const input = await readJson(request, BeginArchiveRequestSchema);
      return jsonResponse(
        await transfer.archives.begin({ ...input, accountId, ownerSubject }),
        202,
      );
    }
    if (
      route.length === 8 &&
      route[5] === 'copies' &&
      route[6] &&
      route[7] === 'capture' &&
      method === 'POST'
    ) {
      await readJson(request, empty);
      return jsonResponse(await transfer.archiveCopy.captureNext(route[6], accountId));
    }
    const archiveId = route[5];
    if (archiveId && route.length === 6 && method === 'GET')
      return jsonResponse(await transfer.archives.get(archiveId, accountId));
    if (archiveId && route.length === 7 && method === 'GET') {
      if (route[6] === 'records')
        return jsonResponse(await transfer.archives.page(archiveId, accountId, recordPage(url)));
      if (route[6] === 'preview')
        return jsonResponse(await transfer.restore.preview(archiveId, accountId));
    }
    if (archiveId && route.length === 7 && method === 'POST') {
      if (route[6] === 'chunks')
        return jsonResponse(
          await transfer.archives.append(
            archiveId,
            accountId,
            await readJson(request, ArchiveCaptureChunkSchema),
          ),
        );
      if (route[6] === 'choices')
        return jsonResponse(
          await transfer.restore.choose(
            archiveId,
            accountId,
            await readJson(request, ArchiveChoiceChunkSchema),
          ),
        );
      if (route[6] === 'preferences') {
        const input = await readJson(request, z.object({ selected: z.boolean() }).strict());
        return jsonResponse(
          await transfer.restore.choosePreferences(archiveId, accountId, input.selected),
        );
      }
      if (route[6] === 'confirm') {
        const input = await readJson(
          request,
          z.object({ previewHash: z.string().regex(/^[a-f0-9]{64}$/), revision }).strict(),
        );
        return jsonResponse(await transfer.restore.confirm(archiveId, accountId, input), 202);
      }
      if (route[6] === 'copy') {
        const input = await readJson(
          request,
          z.object({ id: OperationIdSchema, destination: ImportDestinationSchema }).strict(),
        );
        return jsonResponse(
          await transfer.archiveCopy.begin(archiveId, accountId, { ...input, ownerSubject }),
          202,
        );
      }
      if (['seal', 'preview-next', 'advance', 'resume', 'cancel'].includes(route[6] ?? '')) {
        await readJson(request, empty);
        if (route[6] === 'seal')
          return jsonResponse(await transfer.archives.seal(archiveId, accountId));
        if (route[6] === 'preview-next')
          return jsonResponse(await transfer.restore.previewNext(archiveId, accountId));
        if (route[6] === 'advance')
          return jsonResponse(await transfer.restore.advance(archiveId, accountId));
        if (route[6] === 'resume')
          return jsonResponse(await transfer.restore.resume(archiveId, accountId));
        return jsonResponse(await transfer.restore.cancel(archiveId, accountId));
      }
    }
  }
  return null;
}
