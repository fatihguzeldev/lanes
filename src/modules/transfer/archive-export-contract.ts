import { z } from 'zod';
import { ArchiveHeaderSchema } from './archive-contract';
export const ArchiveExportPhaseSchema = z.enum([
  'boards',
  'lists',
  'labels',
  'tasks',
  'schedules',
  'list_templates',
  'board_templates',
  'template_content',
  'emit_schedules',
  'history',
  'validate',
]);
export const ArchiveExportSummarySchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    header: ArchiveHeaderSchema,
    state: z.enum(['capturing', 'ready', 'failed', 'cancelled']),
    phase: ArchiveExportPhaseSchema,
    recordCount: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    listCount: z.number().int().nonnegative(),
    unmatchedSchedules: z.number().int().nonnegative(),
    captureHash: z.string().length(64).nullable(),
    downloadAvailable: z.boolean(),
    payloadExpiresAt: z.iso.datetime().nullable(),
    freshness: z
      .object({
        complete: z.boolean(),
        stale: z.boolean(),
        lastSyncedAt: z.iso.datetime().nullable(),
      })
      .strict()
      .nullable(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  })
  .strict();
export type ArchiveExportSummary = z.infer<typeof ArchiveExportSummarySchema>;
export const ArchiveExportPageSchema = z
  .object({
    items: z.array(ArchiveExportSummarySchema).max(10),
    nextCursor: z.string().nullable(),
    coverage: z
      .object({
        complete: z.boolean(),
        stale: z.boolean(),
        lastSyncedAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export const ArchiveDownloadPageSchema = z
  .object({
    chunk: z.string(),
    nextCursor: z.string().nullable(),
    generatedAt: z.iso.datetime(),
    totalBytes: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative(),
  })
  .strict();
export type ArchiveDownloadPage = z.infer<typeof ArchiveDownloadPageSchema>;
