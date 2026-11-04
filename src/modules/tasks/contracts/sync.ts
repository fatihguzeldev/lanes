import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';
export const RefreshRequestSchema = z
  .object({
    reason: z.enum(['entry', 'manual', 'stale', 'reconnect', 'list_change']),
    visibleListIds: z.array(ResourceIdSchema).max(2_000).optional(),
  })
  .strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
const SyncPhaseSchema = z.enum([
  'idle',
  'coalesced',
  'default',
  'inventory',
  'tasks',
  'list_check',
  'task_check',
]);
export const SyncAdvanceSchema = z
  .object({
    accountId: ResourceIdSchema.nullable(),
    phase: SyncPhaseSchema,
    continued: z.boolean(),
    errorCode: z.string().optional(),
  })
  .strict();
export type SyncAdvance = z.infer<typeof SyncAdvanceSchema>;
export const SyncStatusSchema = z
  .object({
    initialized: z.boolean(),
    pending: z.boolean(),
    nextAttemptAt: z.number().int().nonnegative().nullable(),
    phase: SyncPhaseSchema,
    errorCode: z.string().nullable(),
  })
  .strict();
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
