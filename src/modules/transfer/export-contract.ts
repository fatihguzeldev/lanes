import { z } from 'zod';
import { TaskFilterSchema } from '../tasks/contracts/task';
import { ResourceIdSchema } from '../../shared/contracts/identity';
import { CalendarDateSchema } from '../tasks/contracts/planning';
import {
  OperationIdSchema,
  OperationStateSchema,
  OperationSummarySchema,
} from '../operations/contracts/receipt';

export const CsvExportScopeSchema = z
  .object({
    boardId: ResourceIdSchema.max(1024).optional(),
    listIds: z
      .array(ResourceIdSchema.max(1024))
      .max(2000)
      .refine((ids) => new Set(ids).size === ids.length, 'select each list once')
      .optional(),
    query: z.string().max(512).default(''),
    filter: TaskFilterSchema.safeExtend({ completion: z.never().optional() }).default({}),
  })
  .strict();
export const CsvExportRequestSchema = z
  .object({
    exportId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    scope: CsvExportScopeSchema,
    includeCompleted: z.boolean(),
    today: CalendarDateSchema,
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict();
export type CsvExportRequest = z.input<typeof CsvExportRequestSchema>;
export interface CsvExportPage {
  chunk: string;
  nextCursor: string | null;
  generatedAt: string;
  freshness: {
    source: 'retained_projection';
    complete: boolean;
    stale: boolean;
    lastSyncedAt: string | null;
  };
  consistencyExplanation: string;
  formulaEscapeExplanation: string;
  counts: {
    tasks: number;
    parentContext: number;
    omittedDependencies: number;
    missingParents: number;
    missingLabels: number;
    unsupportedHierarchy: number;
  };
}

export const SheetsExportRequestSchema = z
  .object({
    operationId: OperationIdSchema,
    title: z.string().trim().min(1).max(1024),
    export: CsvExportRequestSchema,
  })
  .strict();
export const SheetsExportSummarySchema = z
  .object({
    id: OperationIdSchema,
    accountId: ResourceIdSchema,
    title: z.string().optional(),
    selection: CsvExportRequestSchema.nullable().optional(),
    state: z.union([OperationStateSchema, z.enum(['capturing', 'ready'])]),
    captureHash: z.string().length(64).nullable(),
    generatedAt: z.iso.datetime().nullable(),
    totalRows: z.number().int().nonnegative(),
    confirmedRows: z.number().int().nonnegative(),
    totalChunks: z.number().int().nonnegative(),
    capturedBytes: z.number().int().nonnegative(),
    spreadsheet: z.object({ id: z.string(), url: z.string().url() }).strict().nullable(),
    retryOf: z
      .object({
        operationId: OperationIdSchema,
        stepKey: z.string(),
        duplicateRiskAccepted: z.literal(true),
        spreadsheet: z.object({ id: z.string(), url: z.string().url() }).strict().nullable(),
      })
      .strict()
      .nullable(),
    duplicateRiskExplanation: z.string().nullable(),
    freshness: z
      .object({
        source: z.literal('retained_projection'),
        complete: z.boolean(),
        stale: z.boolean(),
        lastSyncedAt: z.iso.datetime().nullable(),
      })
      .strict()
      .nullable(),
    counts: z
      .object({
        tasks: z.number().int().nonnegative(),
        parentContext: z.number().int().nonnegative(),
        omittedDependencies: z.number().int().nonnegative(),
        missingParents: z.number().int().nonnegative(),
        missingLabels: z.number().int().nonnegative(),
        unsupportedHierarchy: z.number().int().nonnegative(),
      })
      .strict(),
    operation: OperationSummarySchema.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  })
  .strict();
export type SheetsExportSummary = z.infer<typeof SheetsExportSummarySchema>;
export const SheetsExportPageSchema = z
  .object({
    items: z.array(SheetsExportSummarySchema).max(10),
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
export const SheetsUncertainStepSchema = z
  .object({
    stepKey: z.string(),
    expectedClaimId: z.string(),
    action: z.enum(['sheets.create', 'sheets.rows']),
    knownSpreadsheet: z.object({ id: z.string(), url: z.string().url() }).strict().nullable(),
    explanation: z.string(),
  })
  .strict();
export const StartSheetsVerificationSchema = z
  .object({
    stepKey: z.string().min(1).max(256),
    expectedClaimId: z.string().min(1).max(256),
    candidateId: z.string().min(1).max(4096).optional(),
    restart: z.boolean().optional(),
  })
  .strict();
export type StartSheetsVerification = z.input<typeof StartSheetsVerificationSchema>;
export const SheetsVerificationSummarySchema = z
  .object({
    id: z.string(),
    exportId: OperationIdSchema,
    stepKey: z.string(),
    candidateId: z.string(),
    status: z.enum(['verifying', 'matched', 'mismatch', 'adopted', 'cancelled']),
    checkedRows: z.number().int().nonnegative(),
    totalRows: z.number().int().positive(),
    proofDigest: z.string().length(64).nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    mismatchCode: z.string().nullable(),
    explanation: z.string(),
  })
  .strict();
export type SheetsVerificationSummary = z.infer<typeof SheetsVerificationSummarySchema>;
export const AdoptSheetsVerificationSchema = z
  .object({
    verificationId: z.string().min(1).max(128),
    proofDigest: z.string().regex(/^[0-9a-f]{64}$/),
    confirmAdoption: z.literal(true),
  })
  .strict();
export type AdoptSheetsVerification = z.input<typeof AdoptSheetsVerificationSchema>;
export const FreshSheetsAttemptSchema = z
  .object({
    newOperationId: OperationIdSchema,
    stepKey: z.string().min(1).max(256),
    expectedClaimId: z.string().min(1).max(256),
    confirmDuplicateRisk: z.literal(true),
  })
  .strict();
export type SheetsExportRequest = z.input<typeof SheetsExportRequestSchema>;
export type SheetsUncertainStep = z.infer<typeof SheetsUncertainStepSchema>;
