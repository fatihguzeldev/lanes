import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { PrioritySchema } from '../../contracts/task';
export const id = ResourceIdSchema.max(1_024);

export const revision = z.number().int().nonnegative().safe();

export const contextSchema = z
  .object({
    operationId: ResourceIdSchema.max(256),
    stepKey: ResourceIdSchema.max(256),
    origin: z.enum(['owner', 'scheduled']),
    recordedAt: z.iso
      .datetime({ offset: true })
      .refine((value) => !/\.\d{4}/.test(value), 'capture millisecond precision'),
    scheduleId: id.optional(),
    runId: id.optional(),
  })
  .strict();

export const createdSchema = z
  .array(
    z
      .object({
        taskId: id,
        expectedTaskRevision: revision,
        labelIds: z.array(id).max(20),
        priority: PrioritySchema,
        starred: z.boolean(),
        blockedBy: z.array(id).max(50),
      })
      .strict()
      .refine(
        (value) =>
          new Set(value.labelIds).size === value.labelIds.length &&
          new Set(value.blockedBy).size === value.blockedBy.length,
        'use each metadata identity once',
      ),
  )
  .max(10)
  .refine(
    (value) => new Set(value.map((item) => item.taskId)).size === value.length,
    'use each new task once',
  );

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the metadata fields',
      422,
      false,
      Object.fromEntries(
        result.error.issues
          .slice(0, 20)
          .map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return result.data;
}

export function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1_024)
    throw new AppError('validation_failed', 'one metadata slice may contain at most 64 kib', 422);
}
