import { z } from 'zod';
import { ResourceIdSchema } from './contracts';
import { OperationIdSchema } from './operation-contract';
import { RepeatRuleSchema } from './planning-contract';
export const RecurrenceStateSchema = z.enum([
  'active',
  'pending',
  'finished',
  'paused',
  'uncertain',
  'reopen_required',
  'undoing',
  'stopped',
]);
export const RecurrenceStatusSchema = z
  .object({
    taskId: ResourceIdSchema,
    seriesId: ResourceIdSchema.nullable(),
    occurrenceId: ResourceIdSchema.nullable(),
    state: RecurrenceStateSchema,
    createdCount: z.number().int().min(1).max(10_000),
    successorTaskId: ResourceIdSchema.nullable(),
    operationId: ResourceIdSchema.nullable(),
    pausedRule: z
      .object({
        rule: RepeatRuleSchema,
        reason: z.enum(['provider_day_removed', 'provider_nested_task']),
        pausedAt: z.number().int().nonnegative(),
      })
      .strict()
      .nullable()
      .optional(),
    checklistComplete: z.boolean(),
    nextAttemptAt: z.number().int().nonnegative().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();
export type RecurrenceStatus = z.infer<typeof RecurrenceStatusSchema>;
export const RecurrenceAdvanceSchema = z
  .object({
    accountId: ResourceIdSchema.nullable(),
    taskId: ResourceIdSchema.nullable(),
    advanced: z.boolean(),
    pending: z.boolean(),
    state: z.union([RecurrenceStateSchema, z.literal('idle')]),
  })
  .strict();
export type RecurrenceAdvance = z.infer<typeof RecurrenceAdvanceSchema>;
export const ReopenChoiceSchema = z.enum(['cancel_pending', 'remove_untouched', 'one_off']);
export const ReopenPreviewSchema = z
  .object({
    taskId: ResourceIdSchema,
    revision: z.number().int().nonnegative(),
    successorTaskId: ResourceIdSchema.nullable(),
    successorTitle: z.string().nullable(),
    successorSubtaskCount: z.number().int().nonnegative(),
    choices: z.array(ReopenChoiceSchema),
    reason: z.string(),
    token: z.string(),
  })
  .strict();
export type ReopenPreview = z.infer<typeof ReopenPreviewSchema>;
export const ReopenRequestSchema = z
  .object({
    taskId: ResourceIdSchema,
    revision: z.number().int().nonnegative(),
    operationId: OperationIdSchema,
    choice: ReopenChoiceSchema,
    confirm: z.literal(true),
    token: z.string().min(1).max(512),
  })
  .strict();
export type ReopenRequest = z.infer<typeof ReopenRequestSchema>;
