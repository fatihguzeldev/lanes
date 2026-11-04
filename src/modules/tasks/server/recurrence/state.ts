import { AppError } from '../../../../shared/contracts/errors';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { RepeatRuleSchema, type RepeatRule } from '../../contracts/planning';
import { type RecurrenceAdvance } from '../../contracts/recurrence';
export const idle: RecurrenceAdvance = {
  accountId: null,
  taskId: null,
  advanced: false,
  pending: false,
  state: 'idle',
};

export const leaseMs = 45_000;

export function identity(value: string): void {
  if (!ResourceIdSchema.max(1_024).safeParse(value).success)
    throw new AppError('validation_failed', 'provide an explicit account and task identity', 422);
}

export async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function parseRule(value: string): RepeatRule {
  try {
    const result = RepeatRuleSchema.safeParse(JSON.parse(value));
    if (result.success) return result.data;
  } catch {
    /* A corrupt retained rule must not become a fresh provider request. */
  }
  throw new AppError(
    'validation_failed',
    'the retained repeat rule needs attention before a successor can be created',
    422,
  );
}
