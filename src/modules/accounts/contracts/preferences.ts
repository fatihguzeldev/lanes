import { z } from 'zod';

export const AccountPlanningZoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'choose a supported IANA time zone');

export const AccountPreferencesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    planningZone: AccountPlanningZoneSchema.optional(),
    weekStart: z.union([z.literal(1), z.literal(7)]).optional(),
  })
  .strict()
  .refine(
    (value) => value.planningZone !== undefined || value.weekStart !== undefined,
    'submit at least one preference',
  );

export type AccountPreferencesInput = z.infer<typeof AccountPreferencesSchema>;

export const AccountPreferenceCommandSchema = z
  .object({ kind: z.literal('account.preferences'), input: AccountPreferencesSchema })
  .strict();
