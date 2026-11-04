import { z } from 'zod';
import { TaskCoverageSchema } from '../../tasks/query-contract';
import { HistoryEventSchema } from './events';

export const HistoryPageSchema = z
  .object({
    items: z.array(HistoryEventSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: TaskCoverageSchema,
  })
  .strict();
