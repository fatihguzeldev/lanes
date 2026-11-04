import { CoverageSchema } from '../../../shared/contracts/coverage';
import { z } from 'zod';
import { BoardListSchema, BoardSchema } from './board';

const page = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item).max(100),
      nextCursor: z.string().nullable(),
      coverage: CoverageSchema,
    })
    .strict();
export const BoardPageSchema = page(BoardSchema);
export const BoardListPageSchema = page(BoardListSchema);
