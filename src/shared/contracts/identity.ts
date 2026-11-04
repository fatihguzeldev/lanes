import { z } from 'zod';

export const ResourceIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'an identity cannot be blank');
