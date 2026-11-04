import { z } from 'zod';
import { ResourceIdSchema } from '../../../shared/contracts/identity';
import { TaskCoverageSchema } from '../../tasks/contracts/query';
import { HistoryEventSchema } from './events';

export const HistoryPageSchema = z
  .object({
    items: z.array(HistoryEventSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: TaskCoverageSchema,
  })
  .strict();

export const HistoryQuerySchema = z
  .object({
    boardId: ResourceIdSchema.optional(),
    listId: ResourceIdSchema.optional(),
    taskId: ResourceIdSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type HistoryQuery = z.input<typeof HistoryQuerySchema>;
