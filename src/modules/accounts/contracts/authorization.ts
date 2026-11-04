import { z } from 'zod';
import { AccountPlanningZoneSchema } from './preferences';

export const OAuthPurposeSchema = z.enum([
  'signin',
  'link',
  'reconnect',
  'sheets_import',
  'sheets_export',
]);

export type OAuthPurpose = z.infer<typeof OAuthPurposeSchema>;

export const StartOAuthSchema = z
  .object({
    purpose: OAuthPurposeSchema,
    accountId: z.string().min(1).max(256).optional(),
    returnPath: z.string().min(1).max(2048).default('/'),
    planningZone: AccountPlanningZoneSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const targeted = ['reconnect', 'sheets_import', 'sheets_export'].includes(value.purpose);
    if (targeted !== !!value.accountId) {
      context.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: targeted
          ? 'choose the account for this authorization'
          : 'this authorization does not take an account reference',
      });
    }
  });

export type StartOAuthInput = z.input<typeof StartOAuthSchema>;
