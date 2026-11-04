import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';
import { OperationIdSchema } from '../../operations/contracts/receipt';

const count = z.number().int().nonnegative().safe();
const timestamp = count;
const error = z.object({ code: z.string(), message: z.string() }).strict().nullable();
export const BeginCompletedDeletionSchema = z
  .object({
    id: OperationIdSchema,
    listRevision: count,
  })
  .strict();
export const ConfirmCompletedDeletionSchema = z
  .object({
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
    confirmOpenDescendantCount: count,
    confirmAssignedTaskCount: count,
  })
  .strict();
export const CompletedDeletionStateSchema = z.enum([
  'capturing',
  'preview',
  'running',
  'partial',
  'uncertain',
  'paused',
  'finished',
  'cancelled',
  'stale',
]);
export const CompletedDeletionSummarySchema = z
  .object({
    id: OperationIdSchema,
    accountId: ResourceIdSchema,
    listId: ResourceIdSchema,
    listTitle: z.string(),
    listRevision: count,
    state: CompletedDeletionStateSchema,
    selectedCompletedCount: count,
    totalDeleteCount: count,
    openDescendantCount: count,
    assignedTaskCount: count,
    rootCount: count,
    capturedCount: count,
    deletedCount: count,
    deletedRootCount: count,
    failedRootCount: count,
    pendingRootCount: count,
    previewHash: z.string().nullable(),
    operationId: OperationIdSchema.nullable(),
    coverageComplete: z.boolean(),
    payloadRetained: z.boolean(),
    error,
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .strict();
export const CompletedDeletionItemSchema = z
  .object({
    taskId: ResourceIdSchema,
    rootTaskId: ResourceIdSchema,
    parentId: ResourceIdSchema.nullable(),
    title: z.string().nullable(),
    completed: z.boolean(),
    revision: count,
    isRoot: z.boolean(),
    assignmentSource: z.enum(['docs', 'chat']).nullable(),
    state: z.enum([
      'captured',
      'pending',
      'admitted',
      'deleted',
      'failed',
      'uncertain',
      'cancelled',
    ]),
    operationId: OperationIdSchema.nullable(),
    payloadRetained: z.boolean(),
    error,
  })
  .strict();
const coverage = z
  .object({ complete: z.boolean(), stale: z.boolean(), lastSyncedAt: z.string().nullable() })
  .strict();
export const CompletedDeletionPageSchema = z
  .object({
    items: z.array(CompletedDeletionSummarySchema).max(10),
    nextCursor: z.string().nullable(),
    coverage,
  })
  .strict();
export const CompletedDeletionPreviewPageSchema = z
  .object({
    items: z.array(CompletedDeletionItemSchema).max(10),
    nextCursor: z.string().nullable(),
    coverage,
  })
  .strict();
export type CompletedDeletionSummary = z.infer<typeof CompletedDeletionSummarySchema>;
export type CompletedDeletionItem = z.infer<typeof CompletedDeletionItemSchema>;
export type CompletedDeletionState = z.infer<typeof CompletedDeletionStateSchema>;
