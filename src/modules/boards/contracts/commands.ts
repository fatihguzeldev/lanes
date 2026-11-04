import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';
import { BoardColorSchema, BoardPatchSchema, CreateBoardSchema } from './board';
const revision = z.number().int().nonnegative();
export const BoardCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('board.create'), input: CreateBoardSchema }).strict(),
  z
    .object({
      kind: z.literal('board.update'),
      boardId: ResourceIdSchema,
      input: BoardPatchSchema,
      revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('board.reorder'),
      boardId: ResourceIdSchema,
      position: z.number().int().nonnegative(),
      revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('board.delete'),
      boardId: ResourceIdSchema,
      revision,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list.placement'),
      listId: ResourceIdSchema,
      boardId: ResourceIdSchema,
      revision,
      position: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list.appearance'),
      listId: ResourceIdSchema,
      color: BoardColorSchema,
      revision,
    })
    .strict(),
]);
export type BoardCommand = z.infer<typeof BoardCommandSchema>;
