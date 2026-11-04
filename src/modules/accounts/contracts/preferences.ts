import { z } from 'zod';
import { AccountPreferencesSchema } from './connection';
export const AccountPreferenceCommandSchema = z
  .object({ kind: z.literal('account.preferences'), input: AccountPreferencesSchema })
  .strict();
