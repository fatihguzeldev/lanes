import { z } from 'zod';
import { ConnectionSummarySchema } from './contracts';
const coverage = z
  .object({ complete: z.boolean(), lastSyncedAt: z.string().nullable(), stale: z.boolean() })
  .strict();
export const AccountPageSchema = z
  .object({
    items: z.array(ConnectionSummarySchema).max(100),
    nextCursor: z.string().nullable(),
    coverage,
  })
  .strict();
export const SessionSnapshotSchema = z
  .object({
    configured: z.boolean(),
    authenticated: z.boolean(),
    serverTime: z.number(),
    accounts: z
      .object({
        items: z.array(ConnectionSummarySchema),
        nextCursor: z.string().nullable(),
        coverage,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.authenticated && (!value.configured || !value.accounts))
      context.addIssue({
        code: 'custom',
        message: 'an authenticated workspace needs a valid account page',
      });
  });
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export const OAuthStartResponseSchema = z.object({ authorizationUrl: z.string().url() }).strict();
