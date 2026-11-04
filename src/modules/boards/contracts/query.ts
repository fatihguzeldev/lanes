import { z } from 'zod';
import { BoardListSchema, BoardSchema } from './board';
import { TaskCoverageSchema } from '../../tasks/contracts/query';
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
