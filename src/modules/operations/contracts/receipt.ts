import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';

export const OperationIdSchema = z.string().regex(/^\d{13}:[a-zA-Z0-9_-]{16,64}$/);
export const OperationStateSchema = z.enum([
  'accepted',
  'running',
  'succeeded',
  'partial',
  'reconnect_required',
  'blocked_by_limit',
  'uncertain',
  'failed',
  'cancelled',
]);
export const OperationSummarySchema = z
  .object({
    id: OperationIdSchema,
    accountId: ResourceIdSchema,
    kind: z.string(),
    state: OperationStateSchema,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    cancelRequested: z.boolean(),
    totalSteps: z.number().int().positive(),
    confirmedSteps: z.number().int().nonnegative(),
    inputSealed: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    nextAttemptAt: z.number().int().nullable(),
    finished: z.boolean().default(false),
  })
  .strict();
export type OperationSummary = z.infer<typeof OperationSummarySchema>;
export const OperationPageSchema = z
  .object({
    items: z.array(OperationSummarySchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: z
      .object({ complete: z.boolean(), stale: z.boolean(), lastSyncedAt: z.string().nullable() })
      .strict(),
  })
  .strict();
export const OperationStepSummarySchema = z
  .object({
    key: z.string(),
    position: z.number().int().nonnegative(),
    kind: z.string(),
    state: z.enum([
      'accepted',
      'claimed',
      'dispatched',
      'confirmed',
      'failed',
      'uncertain',
      'cancelled',
    ]),
    errorCode: z.string().nullable(),
    taskId: ResourceIdSchema.nullable(),
    listId: ResourceIdSchema.nullable(),
    spreadsheetId: z.string().nullable(),
    deleted: z.boolean(),
    stopDecision: z.literal('keep_provider_current').nullable().default(null),
  })
  .strict();
export const OperationStepPageSchema = z
  .object({
    items: z.array(OperationStepSummarySchema).max(10),
    nextCursor: z.string().nullable(),
    coverage: z
      .object({ complete: z.boolean(), stale: z.boolean(), lastSyncedAt: z.string().nullable() })
      .strict(),
  })
  .strict();
export type OperationStepSummary = z.infer<typeof OperationStepSummarySchema>;
const progressCount = z.number().int().nonnegative();
const settledCounts = z
  .object({
    confirmed: progressCount,
    failed: progressCount,
    uncertain: progressCount,
    cancelled: progressCount,
  })
  .strict();
export const OperationProgressSchema = z
  .object({
    operationId: OperationIdSchema,
    accountId: ResourceIdSchema,
    inputSealed: z.boolean(),
    finished: z.boolean(),
    totalSteps: progressCount,
    steps: settledCounts.extend({ remaining: progressCount }).strict(),
    taskCreates: settledCounts,
    checkedAt: z.number().int().nonnegative(),
  })
  .strict();
export type OperationProgress = z.infer<typeof OperationProgressSchema>;
export const IssuedOperationStepSchema = z
  .object({
    key: z.string(),
    kind: z.string(),
    state: z.enum(['dispatched', 'uncertain']),
    hasRecordedResponse: z.boolean(),
    claimActive: z.boolean(),
  })
  .strict();
export type IssuedOperationStep = z.infer<typeof IssuedOperationStepSchema>;
