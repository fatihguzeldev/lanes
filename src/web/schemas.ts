import { z } from 'zod';
import { BoardListSchema, BoardSchema } from '../modules/boards/contracts';
import { HistoryEventSchema } from '../modules/history/contracts';
import { TaskCoverageSchema } from '../modules/tasks/query-contract';
const page = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item).max(100),
      nextCursor: z.string().nullable(),
      coverage: TaskCoverageSchema,
    })
    .strict();
export const BoardPageSchema = page(BoardSchema);
export const BoardListPageSchema = page(BoardListSchema);
export const HistoryPageSchema = page(HistoryEventSchema);
