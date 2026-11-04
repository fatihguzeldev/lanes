import { z } from 'zod';
import { TaskCoverageSchema } from '../../tasks/contracts/query';
import { HistoryEventSchema } from './events';

export const HistoryPageSchema = z
  .object({
    items: z.array(HistoryEventSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: TaskCoverageSchema,
  })
  .strict();
