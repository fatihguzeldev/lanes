import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
export const revisionSchema = z.number().int().nonnegative();

export const positionSchema = z.number().int().nonnegative();

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the submitted board fields',
      422,
      false,
      Object.fromEntries(
        result.error.issues.map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return result.data;
}
