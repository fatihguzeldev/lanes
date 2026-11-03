import { z } from 'zod';
import { AppError } from '../contracts/errors';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import { LabelInputSchema, ResourceIdSchema } from '../modules/tasks/contracts';
import { normalizeLabelName } from '../modules/tasks/model';
import { OperationIdSchema } from '../modules/tasks/operation-contract';
import {
  BeginImportSchema,
  ConfirmImportSchema,
  ImportChunkSchema,
  ImportDestinationSchema,
} from '../modules/transfer/server-contract';
import {
  AdoptSheetsVerificationSchema,
  CsvExportRequestSchema,
  FreshSheetsAttemptSchema,
  SheetsExportRequestSchema,
  StartSheetsVerificationSchema,
} from '../modules/transfer/export-contract';
import {
  ArchiveCaptureChunkSchema,
  ArchiveChoiceChunkSchema,
  ArchiveExportSelectionSchema,
  ArchiveHeaderSchema,
  ArchiveImportModeSchema,
} from '../modules/transfer/archive-contract';
import { GOOGLE_SHEETS_IMPORT_SCOPE, parseSheetRange } from '../modules/transfer/server/sheets';
import type { createServices } from './services';
import { jsonResponse, parseValue, readJson } from './http';
const id = ResourceIdSchema.max(1024),
  empty = z.object({}).strict();
const BeginImportRequestSchema = z
  .object(BeginImportSchema.shape)
  .omit({ accountId: true, ownerSubject: true })
  .strict();
const BeginArchiveRequestSchema = z
  .object({
    id: OperationIdSchema,
    mode: ArchiveImportModeSchema,
    header: ArchiveHeaderSchema,
    recordCount: z.number().int().min(0).max(100000),
  })
  .strict();
const revision = z.number().int().nonnegative().safe();
function page(url: URL): { limit: number; cursor?: string } {
  const value = parseValue(
    z
      .object({
        limit: z.number().int().min(1).max(10).default(10),
        cursor: z.string().min(1).max(48000).optional(),
      })
      .strict(),
    {
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
    },
  );
  return { limit: value.limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
}
function after(url: URL, key = 'after'): { limit: number; after?: number } {
  const value = parseValue(
    z
      .object({
        limit: z.number().int().min(1).max(10).default(10),
        after: z.number().int().min(0).max(100000).optional(),
      })
      .strict(),
    {
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has(key) ? { after: Number(url.searchParams.get(key)) } : {}),
    },
  );
  return { limit: value.limit, ...(value.after === undefined ? {} : { after: value.after }) };
}

/** Resolves actors and account scope, then delegates parsing, staging and execution to transfer. */
export async function transferRoute(
  request: Request,
  url: URL,
  route: string[],
  account: ConnectionSummary,
  ownerSubject: string,
  services: ReturnType<typeof createServices>,
): Promise<Response | null> {
  const accountId = account.id,
    { transfer, operations } = services,
    method = request.method;
  if (route[3] !== 'transfer') return null;
  if (route.length === 5 && route[4] === 'capacity' && method === 'GET')
    return jsonResponse(await operations.listCapacity(accountId));
  if (route.length === 6 && route[4] === 'labels' && route[5] === 'compare' && method === 'POST') {
    const input = await readJson(
      request,
      z.object({ definitions: z.array(LabelInputSchema).max(200) }).strict(),
    );
    const current = new Map<string, string>();
    for (let offset = 0; offset < input.definitions.length; offset += 100) {
      const labels = await services.queries.readLabelsByNames(
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
      return jsonResponse(await transfer.imports.list(accountId, page(url)));
    if (route.length === 5 && method === 'POST') {
      const input = await readJson(request, BeginImportRequestSchema);
      return jsonResponse(await transfer.imports.begin({ ...input, accountId, ownerSubject }), 202);
    }
    const importId = route[5];
    if (importId && route.length === 6 && method === 'GET')
      return jsonResponse(await transfer.imports.get(importId, accountId));
    if (importId && route.length === 7 && method === 'GET') {
      if (route[6] === 'records') {
        const options = after(url, 'cursor');
        return jsonResponse(
          await transfer.imports.readPreviewRecords(importId, accountId, {
            kind: parseValue(z.enum(['list', 'task', 'issue']), url.searchParams.get('kind')),
            ...(options.after === undefined ? {} : { cursor: options.after }),
            limit: options.limit,
          }),
        );
      }
      if (route[6] === 'output')
        return jsonResponse(await transfer.imports.output(importId, accountId, page(url)));
    }
    if (importId && route.length === 7 && method === 'POST') {
      if (route[6] === 'chunks')
        return jsonResponse(
          await transfer.imports.append(
            importId,
            accountId,
            await readJson(request, ImportChunkSchema),
          ),
        );
      if (route[6] === 'confirm')
        return jsonResponse(
          await transfer.imports.confirm(
            importId,
            accountId,
            await readJson(request, ConfirmImportSchema),
          ),
          202,
        );
      if (['preview', 'advance', 'resume', 'cancel'].includes(route[6] ?? '')) {
        await readJson(request, empty);
        if (route[6] === 'preview')
          return jsonResponse(await transfer.imports.sealPreview(importId, accountId));
        if (route[6] === 'advance')
          return jsonResponse(await transfer.imports.advance(importId, accountId));
        if (route[6] === 'resume')
          return jsonResponse(await transfer.imports.resume(importId, accountId));
        return jsonResponse(await transfer.imports.cancel(importId, accountId));
      }
    }
  }
  if (route[4] === 'accounts') {
    if (route.length === 5 && method === 'POST') {
      const input = await readJson(
        request,
        z
          .object({
            id: OperationIdSchema,
            sourceAccountId: id,
            listIds: z.array(id).min(1).max(100),
            includeCompleted: z.boolean().default(true),
          })
          .strict(),
      );
      await services.accounts.getConnectionSummary(request, input.sourceAccountId);
      return jsonResponse(
        await transfer.accountTransfers.begin({
          ...input,
          ownerSubject,
          destinationAccountId: accountId,
        }),
        202,
      );
    }
    if (route.length === 7 && route[5] && route[6] === 'capture' && method === 'POST') {
      await readJson(request, empty);
      return jsonResponse(await transfer.accountTransfers.captureNext(route[5], accountId));
    }
  }
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
      const client = await services.sheetsClientFor(accountId, GOOGLE_SHEETS_IMPORT_SCOPE);
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
      const client = await services.sheetsClientFor(accountId, GOOGLE_SHEETS_IMPORT_SCOPE);
      return jsonResponse(
        await client.readRange(input.spreadsheetId, { sheet: input.sheet, range: input.range }),
      );
    }
  }
  if (route[4] === 'exports') {
    if (route.length === 7 && route[5] === 'csv' && route[6] === 'page' && method === 'POST') {
      const input = await readJson(
        request,
        z
          .object({
            request: CsvExportRequestSchema,
            cursor: z.string().min(1).max(48000).optional(),
          })
          .strict(),
      );
      return jsonResponse(await transfer.csv.page(accountId, input.request, input.cursor));
    }
    if (route[5] === 'sheets') {
      if (route.length === 6 && method === 'GET')
        return jsonResponse(await transfer.sheetsExports.list(accountId, page(url)));
      if (route.length === 6 && method === 'POST') {
        const input = await readJson(request, SheetsExportRequestSchema);
        return jsonResponse(
          await transfer.sheetsExports.begin({ ...input, accountId, ownerSubject }),
          202,
        );
      }
      const exportId = route[6];
      if (exportId && route.length === 7 && method === 'GET')
        return jsonResponse(await transfer.sheetsExports.get(accountId, exportId));
      if (exportId && route.length === 8 && method === 'POST') {
        if (route[7] === 'confirm')
          return jsonResponse(
            await transfer.sheetsExports.confirm(
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
          return jsonResponse(await transfer.sheetsExports.captureNext(accountId, exportId));
        }
        if (route[7] === 'advance') {
          await readJson(request, empty);
          return jsonResponse((await transfer.sheetsExports.advance(accountId, exportId)).run);
        }
        if (route[7] === 'resume') {
          await readJson(request, empty);
          return jsonResponse(await transfer.sheetsExports.resume(accountId, exportId));
        }
        if (route[7] === 'cancel') {
          await readJson(request, empty);
          return jsonResponse(await transfer.sheetsExports.cancel(accountId, exportId));
        }
      }
      if (exportId && route[7] === 'resolution' && route.length === 9 && method === 'POST') {
        if (route[8] === 'inspect') {
          const input = await readJson(
            request,
            z.object({ stepKey: z.string().min(1).max(256) }).strict(),
          );
          return jsonResponse(
            await transfer.sheetsExports.inspectUncertain(accountId, exportId, input.stepKey),
          );
        }
        if (route[8] === 'start')
          return jsonResponse(
            await transfer.sheetsExports.startVerification(
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
            await transfer.sheetsExports.advanceVerification(
              accountId,
              exportId,
              input.verificationId,
            ),
          );
        }
        if (route[8] === 'adopt')
          return jsonResponse(
            await transfer.sheetsExports.adoptVerified(
              accountId,
              exportId,
              await readJson(request, AdoptSheetsVerificationSchema),
            ),
          );
        if (route[8] === 'fresh-attempt')
          return jsonResponse(
            await transfer.sheetsExports.startFreshAttempt(
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
            await transfer.sheetsExports.resumeRecordedResponse(accountId, exportId, input.stepKey),
          );
        }
      }
    }
  }
  if (route[4] === 'archives') {
    if (route[5] === 'exports') {
      if (route.length === 6 && method === 'GET')
        return jsonResponse(await transfer.archiveExports.list(accountId, page(url)));
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
          await transfer.archiveExports.downloadPage(accountId, exportId, page(url)),
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
      return jsonResponse(await transfer.archives.list(accountId, page(url)));
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
        return jsonResponse(await transfer.archives.page(archiveId, accountId, after(url)));
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
