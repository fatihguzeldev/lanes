import { z } from 'zod';
import { OperationIdSchema } from '../tasks/operation-contract';
import { LabelInputSchema, ResourceIdSchema } from '../tasks/contracts';
import { NormalizedImportListSchema, NormalizedImportTaskSchema } from './parse-contract';
const identity = ResourceIdSchema.max(1024);
export const DEFAULT_IMPORTED_LABEL_COLOR = '#7a8178';
export const ImportDestinationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('new'),
      boardId: identity,
      boardRevision: z.number().int().nonnegative().safe().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('existing'),
      listId: identity,
      revision: z.number().int().nonnegative().safe(),
    })
    .strict(),
]);
export const ImportSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      name: z.string().min(1).max(255),
      format: z.string().min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sheets'),
      accountId: identity,
      spreadsheetId: z.string().regex(/^[a-zA-Z0-9_-]{10,256}$/),
      ranges: z
        .array(
          z
            .object({ sheet: z.string().min(1).max(256), range: z.string().min(1).max(100) })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z.object({ kind: z.literal('account'), accountId: identity, snapshotId: identity }).strict(),
  z
    .object({ kind: z.literal('archive'), name: z.string().min(1).max(255), version: z.literal(1) })
    .strict(),
]);
export const BeginImportSchema = z
  .object({
    id: OperationIdSchema,
    ownerSubject: identity,
    accountId: identity,
    source: ImportSourceSchema,
    destination: ImportDestinationSchema,
    totalLists: z.number().int().min(0).max(100),
    totalTasks: z.number().int().min(0).max(2000),
    issueCount: z.number().int().min(0).max(10_000).nullable().default(0),
    mapping: z
      .array(
        z
          .object({
            sheet: z.string().max(256),
            headerRow: z.number().int().min(1).max(10000),
            fields: z.record(z.string().max(32), z.number().int().min(0).max(255)),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    skippedBlankRows: z.number().int().nonnegative().safe().default(0),
    skippedCompletedTasks: z.number().int().nonnegative().safe().default(0),
    parentContextCount: z.number().int().min(0).max(2000).default(0),
    labelDefinitions: z.array(LabelInputSchema).max(1000).default([]),
  })
  .strict()
  .refine(
    (input) => !input.totalTasks || input.totalLists > 0,
    'tasks need at least one source list',
  )
  .refine(
    (input) => input.source.kind !== 'account' || input.source.accountId !== input.accountId,
    'choose distinct source and destination accounts',
  );
export type BeginImport = z.input<typeof BeginImportSchema>;
export type ImportManifest = z.output<typeof BeginImportSchema>;
export const ImportIssueSchema = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1024),
    source: z
      .object({
        sheet: z.string().max(256),
        row: z.number().int().min(1).max(1000000),
        column: z.number().int().min(0).max(255).optional(),
      })
      .strict()
      .optional(),
    field: z.string().max(128).optional(),
    taskKey: z.string().max(256).optional(),
  })
  .strict();
const positioned = <T extends z.ZodType>(schema: T) =>
  z.object({ position: z.number().int().nonnegative().max(10_000), value: schema }).strict();
export const ImportChunkSchema = z
  .object({
    lists: z.array(positioned(NormalizedImportListSchema)).max(10).default([]),
    tasks: z
      .array(
        positioned(NormalizedImportTaskSchema)
          .extend({ labelDefinitions: z.array(LabelInputSchema).max(20).optional() })
          .strict()
          .refine(
            (row) =>
              !row.labelDefinitions ||
              (row.labelDefinitions.length === row.value.labels.length &&
                row.labelDefinitions.every((definition) =>
                  row.value.labels.some(
                    (name) => name.toLowerCase() === definition.name.toLowerCase(),
                  ),
                )),
            'captured label definitions must match the task labels',
          ),
      )
      .max(10)
      .default([]),
    issues: z.array(positioned(ImportIssueSchema)).max(10).default([]),
  })
  .strict()
  .refine((chunk) => {
    const n = chunk.lists.length + chunk.tasks.length + chunk.issues.length;
    return n > 0 && n <= 10;
  }, 'capture one to ten normalized records');
export type ImportChunk = z.input<typeof ImportChunkSchema>;
export interface ImportSummary {
  validation?: { checkedRecords: number; totalRecords: number; remainingGraphNodes: number } | null;
  paused?: boolean;
  pauseReason?: string | null;
  id: string;
  accountId: string;
  state: 'staging' | 'preview' | 'capturing' | 'running' | 'finished' | 'cancelled';
  revision: number;
  source: ImportManifest['source'];
  destination: ImportManifest['destination'];
  totalLists: number;
  totalTasks: number;
  capturedLists: number;
  capturedTasks: number;
  capturedIssues: number;
  warningCount: number;
  errorCount: number;
  completedCount: number;
  subtaskCount: number;
  repeatingCount: number;
  requiredListSlots: number;
  skippedBlankRows: number;
  skippedCompletedTasks: number;
  parentContextCount: number;
  previewHash: string | null;
  operationId: string | null;
  createdAt: string;
  freshnessNote: string;
}
export const ConfirmImportSchema = z
  .object({
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptWarnings: z.boolean().default(false),
    confirmIndependentRepeat: z.boolean().default(false),
  })
  .strict();
