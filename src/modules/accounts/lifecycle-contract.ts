import { z } from 'zod';
export const RemoveAccountSchema = z
  .object({ confirm: z.literal(true), revision: z.number().int().nonnegative().safe() })
  .strict();
export type RemoveAccount = z.infer<typeof RemoveAccountSchema>;
export const DisconnectStatusSchema = z
  .object({
    accountId: z.string(),
    state: z.enum(['disconnecting', 'disconnected']),
    pending: z.boolean(),
    remoteRevocation: z.enum(['pending', 'succeeded', 'failed', 'not_needed', 'unknown']),
    pausedOwners: z.number().int().nonnegative(),
    totalOwners: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();
export type DisconnectStatus = z.infer<typeof DisconnectStatusSchema>;
export const RemovalStatusSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    state: z.enum(['pending', 'running', 'blocked', 'completed']),
    owner: z.string().nullable(),
    deletedRecords: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();
export type RemovalStatus = z.infer<typeof RemovalStatusSchema>;
export const AccountLifecycleStatusSchema = z
  .object({
    disconnect: DisconnectStatusSchema.nullable(),
    removal: RemovalStatusSchema.nullable(),
  })
  .strict();
export type AccountLifecycleStatus = z.infer<typeof AccountLifecycleStatusSchema>;
