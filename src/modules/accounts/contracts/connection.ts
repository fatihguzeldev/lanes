import { z } from 'zod';
import { AccountPlanningZoneSchema } from './preferences';

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
