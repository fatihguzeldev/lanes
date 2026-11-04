import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
export const id = ResourceIdSchema.max(1024);

export const revision = z.number().int().nonnegative().safe();

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      'validation_failed',
      'check the template fields',
      422,
      false,
      Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return parsed.data;
}
