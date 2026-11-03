import { z } from 'zod';
import {
  ArchiveFieldSchema,
  ArchiveHeaderSchema,
  ArchiveImportModeSchema,
  ArchiveRecordSchema,
} from '../modules/transfer/archive-contract';
import {
  ImportDestinationSchema,
  ImportIssueSchema,
  ImportSourceSchema,
} from '../modules/transfer/server-contract';
import {
  NormalizedImportListSchema,
  NormalizedImportTaskSchema,
} from '../modules/transfer/parse-contract';
import { LabelInputSchema } from '../modules/tasks/contracts';
export const TransferCoverageSchema = z
  .object({ complete: z.boolean(), stale: z.boolean(), lastSyncedAt: z.string().nullable() })
  .strict();
export const transferPage = <S extends z.ZodType>(item: S) =>
  z
    .object({
      items: z.array(item).max(100),
      nextCursor: z.string().nullable(),
      coverage: TransferCoverageSchema,
    })
    .strict();
const count = z.number().int().nonnegative(),
  id = z.string().min(1),
  time = z.iso.datetime({ offset: true });
export const ImportSummarySchema = z
  .object({
    id,
    accountId: id,
    state: z.enum(['staging', 'preview', 'capturing', 'running', 'finished', 'cancelled']),
    paused: z.boolean().optional(),
    pauseReason: z.string().nullable().optional(),
    validation: z
      .object({ checkedRecords: count, totalRecords: count, remainingGraphNodes: count })
      .strict()
      .nullable()
      .optional(),
    revision: count,
    source: ImportSourceSchema,
    destination: ImportDestinationSchema,
    totalLists: count,
    totalTasks: count,
    capturedLists: count,
    capturedTasks: count,
    capturedIssues: count,
    warningCount: count,
    errorCount: count,
    completedCount: count,
    subtaskCount: count,
    repeatingCount: count,
    requiredListSlots: count,
    skippedBlankRows: count,
    skippedCompletedTasks: count,
    parentContextCount: count,
    previewHash: z.string().nullable(),
    operationId: z.string().nullable(),
    createdAt: time,
    freshnessNote: z.string(),
  })
  .strict();
export type ImportSummary = z.infer<typeof ImportSummarySchema>;
export const ImportRecordPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            position: count,
            value: z
              .union([NormalizedImportTaskSchema, NormalizedImportListSchema, ImportIssueSchema])
              .nullable(),
            payloadRetained: z.boolean().optional(),
            labelDefinitions: z.array(LabelInputSchema).nullable().optional(),
          })
          .strict(),
      )
      .max(10),
    nextCursor: count.nullable(),
  })
  .strict();
export const ImportOutputPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            key: id,
            taskId: id,
            revision: count,
            providerEtag: z.string().nullable(),
            sourceCompletion: z
              .object({
                completed: z.boolean(),
                completedAt: z.string().nullable(),
                providerTimeMayDiffer: z.boolean(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(100),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const ListCapacitySchema = z
  .object({
    known: count.nullable(),
    reserved: count,
    available: count.nullable(),
    stale: z.boolean(),
  })
  .strict();
export const CsvPageSchema = z
  .object({
    chunk: z.string(),
    nextCursor: z.string().nullable(),
    generatedAt: time,
    freshness: z
      .object({
        source: z.literal('retained_projection'),
        complete: z.boolean(),
        stale: z.boolean(),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
    consistencyExplanation: z.string(),
    formulaEscapeExplanation: z.string(),
    counts: z
      .object({
        tasks: count,
        parentContext: count,
        omittedDependencies: count,
        missingParents: count,
        missingLabels: count,
        unsupportedHierarchy: count,
      })
      .strict(),
  })
  .strict();
export const ArchiveSummarySchema = z
  .object({
    id,
    accountId: id,
    mode: ArchiveImportModeSchema,
    header: ArchiveHeaderSchema,
    recordCount: count,
    expectedRecords: count,
    bytes: count,
    state: z.enum(['staging', 'preview', 'restoring', 'finished', 'cancelled']),
    previewHash: z.string().nullable(),
    revision: count,
    paused: z.boolean().optional(),
    validation: z
      .object({ checkedRecords: count, totalRecords: count, remainingGraphNodes: count })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const preferences = z.object({
  planningZone: z.string(),
  weekStart: z.union([z.literal(1), z.literal(7)]),
});
export const ArchivePreviewSchema = z
  .object({
    archive: ArchiveSummarySchema,
    pendingMatches: count,
    matched: count,
    newRecords: count,
    conflicts: count,
    unmatched: count,
    selected: count,
    restored: count,
    skipped: count,
    preferences: z
      .object({
        current: preferences.extend({ revision: count }).strict(),
        incoming: preferences.strict(),
        selected: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const ArchiveMatchSchema = z
  .object({
    key: id,
    kind: z.enum([
      'board',
      'list',
      'task',
      'label',
      'template',
      'template_list',
      'template_task',
      'schedule',
      'history',
    ]),
    status: z.enum(['matched', 'new', 'unmatched', 'conflict']),
    message: z.string(),
    destinationId: id.optional(),
    destinationRevision: count.optional(),
    fields: z.array(ArchiveFieldSchema),
    blockedFields: z.partialRecord(ArchiveFieldSchema, z.string()),
    changes: z.partialRecord(
      ArchiveFieldSchema,
      z.object({ current: z.unknown(), incoming: z.unknown() }).strict(),
    ),
    defaultIncomingFields: z.array(ArchiveFieldSchema),
    dependencyIds: z.array(id).optional(),
    missingDependencyCount: count.optional(),
  })
  .strict();
export const ArchiveRecordPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            position: count,
            value: ArchiveRecordSchema.nullable(),
            payloadRetained: z.boolean().optional(),
            match: ArchiveMatchSchema.nullable(),
            incoming: z.boolean(),
            restoreState: z.string(),
            fields: z.array(ArchiveFieldSchema).optional(),
            acceptOmittedReferences: z.boolean().optional(),
          })
          .strict(),
      )
      .max(10),
    nextCursor: count.nullable(),
  })
  .strict();
export const ImportTableSchema = z
  .object({
    name: z.string(),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(256))
      .max(10000),
    startRow: z.number().int().positive().optional(),
    rowNumbers: z.array(z.number().int().positive()).optional(),
    cellIssues: z.array(ImportIssueSchema).optional(),
  })
  .strict();
