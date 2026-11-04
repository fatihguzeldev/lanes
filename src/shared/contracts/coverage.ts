import { z } from 'zod';

export const CoverageSchema = z
  .object({
    complete: z.boolean(),
    lastSyncedAt: z.iso.datetime().nullable(),
    stale: z.boolean(),
  })
  .strict();
