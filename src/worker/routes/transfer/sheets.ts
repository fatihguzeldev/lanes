import type { Services } from '../../composition/services';
import type { AccountRouteContext } from '../context';

import { z } from 'zod';
import { AppError } from '../../../shared/contracts/errors';
import {
  GOOGLE_SHEETS_IMPORT_SCOPE,
  parseSheetRange,
} from '../../../modules/transfer/server/sheets/provider';
import {
  AdoptSheetsVerificationSchema,
  FreshSheetsAttemptSchema,
  SheetsExportRequestSchema,
  StartSheetsVerificationSchema,
} from '../../../modules/transfer/contracts/export';
import { jsonResponse, readJson } from '../../protocol/http';
import { transferPage } from './pagination';
const empty = z.object({}).strict();
export async function sheetsTransferRoute(
  context: AccountRouteContext,
  clientFor: Services['sheetsClientFor'],
  sheetsExports: Services['transfer']['sheetsExports'],
): Promise<Response | null> {
  const { request, url, route, account, ownerSubject } = context;
  const accountId = account.id,
    method = request.method;
  if (route[4] === 'sheets' && route.length === 6 && method === 'POST') {
    if (route[5] === 'metadata') {
      const input = await readJson(
        request,
        z
          .object({
            spreadsheetId: z.string().min(1).max(4096).optional(),
            url: z.string().min(1).max(4096).optional(),
          })
          .strict()
          .refine(
            (value) => !!value.spreadsheetId !== !!value.url,
            'select one spreadsheet id or url',
          ),
      );
      const client = await clientFor(accountId, GOOGLE_SHEETS_IMPORT_SCOPE);
      return jsonResponse(await client.metadata(input.spreadsheetId ?? input.url!));
    }
    if (route[5] === 'range') {
      const input = await readJson(
        request,
        z
          .object({
            spreadsheetId: z.string().min(1).max(256),
            sheet: z.string().min(1).max(100),
            range: z.string().min(1).max(100),
          })
          .strict(),
      );
      if (parseSheetRange(input.range).rowCount > 100)
        throw new AppError(
          'validation_failed',
          'read at most 100 selected sheet rows per request.',
          400,
        );
      const client = await clientFor(accountId, GOOGLE_SHEETS_IMPORT_SCOPE);
      return jsonResponse(
        await client.readRange(input.spreadsheetId, { sheet: input.sheet, range: input.range }),
      );
    }
  }
  if (route[4] === 'exports') {
    if (route[5] === 'sheets') {
      if (route.length === 6 && method === 'GET')
        return jsonResponse(await sheetsExports.list(accountId, transferPage(url)));
      if (route.length === 6 && method === 'POST') {
        const input = await readJson(request, SheetsExportRequestSchema);
        return jsonResponse(await sheetsExports.begin({ ...input, accountId, ownerSubject }), 202);
      }
      const exportId = route[6];
      if (exportId && route.length === 7 && method === 'GET')
        return jsonResponse(await sheetsExports.get(accountId, exportId));
      if (exportId && route.length === 8 && method === 'POST') {
        if (route[7] === 'confirm')
          return jsonResponse(
            await sheetsExports.confirm(
              accountId,
              exportId,
              await readJson(
                request,
                z.object({ captureHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
              ),
            ),
            202,
          );
        if (route[7] === 'capture') {
          await readJson(request, empty);
          return jsonResponse(await sheetsExports.captureNext(accountId, exportId));
        }
        if (route[7] === 'advance') {
          await readJson(request, empty);
          return jsonResponse((await sheetsExports.advance(accountId, exportId)).run);
        }
        if (route[7] === 'resume') {
          await readJson(request, empty);
          return jsonResponse(await sheetsExports.resume(accountId, exportId));
        }
        if (route[7] === 'cancel') {
          await readJson(request, empty);
          return jsonResponse(await sheetsExports.cancel(accountId, exportId));
        }
      }
      if (exportId && route[7] === 'resolution' && route.length === 9 && method === 'POST') {
        if (route[8] === 'inspect') {
          const input = await readJson(
            request,
            z.object({ stepKey: z.string().min(1).max(256) }).strict(),
          );
          return jsonResponse(
            await sheetsExports.inspectUncertain(accountId, exportId, input.stepKey),
          );
        }
        if (route[8] === 'start')
          return jsonResponse(
            await sheetsExports.startVerification(
              accountId,
              exportId,
              await readJson(request, StartSheetsVerificationSchema),
            ),
          );
        if (route[8] === 'advance') {
          const input = await readJson(
            request,
            z.object({ verificationId: z.string().min(1).max(128) }).strict(),
          );
          return jsonResponse(
            await sheetsExports.advanceVerification(accountId, exportId, input.verificationId),
          );
        }
        if (route[8] === 'adopt')
          return jsonResponse(
            await sheetsExports.adoptVerified(
              accountId,
              exportId,
              await readJson(request, AdoptSheetsVerificationSchema),
            ),
          );
        if (route[8] === 'fresh-attempt')
          return jsonResponse(
            await sheetsExports.startFreshAttempt(
              accountId,
              exportId,
              await readJson(request, FreshSheetsAttemptSchema),
            ),
            202,
          );
        if (route[8] === 'repair') {
          const input = await readJson(
            request,
            z.object({ stepKey: z.string().min(1).max(256) }).strict(),
          );
          return jsonResponse(
            await sheetsExports.resumeRecordedResponse(accountId, exportId, input.stepKey),
          );
        }
      }
    }
  }
  return null;
}
