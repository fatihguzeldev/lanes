import { z } from 'zod';

export const OAuthPurposeSchema = z.enum([
  'signin',
  'link',
  'reconnect',
  'sheets_import',
  'sheets_export',
]);
export type OAuthPurpose = z.infer<typeof OAuthPurposeSchema>;

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

export const ConnectionStateSchema = z.enum([
  'connecting',
  'connected',
  'reconnect_required',
  'temporarily_unavailable',
  'disconnecting',
  'disconnected',
]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ConnectionSummarySchema = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    pictureUrl: z.string().nullable(),
    state: ConnectionStateSchema,
    permissions: z
      .object({ tasks: z.boolean(), sheetsImport: z.boolean(), sheetsExport: z.boolean() })
      .strict(),
    grantExpiresAt: z.iso.datetime({ offset: true }).nullable(),
    planningZone: AccountPlanningZoneSchema,
    weekStart: z.union([z.literal(1), z.literal(7)]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;

export const ConnectionPageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ConnectionPageOptions = z.input<typeof ConnectionPageOptionsSchema>;
