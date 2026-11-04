import { z } from 'zod';
import { TaskListSchema } from '../../tasks/contracts/task';
import { ResourceIdSchema } from '../../../shared/contracts/identity';

const title = z
  .string()
  .trim()
  .min(1, 'enter a board name')
  .refine((value) => [...value].length <= 128, 'use at most 128 characters');
export const BoardColorSchema = z
  .string()
  .regex(/^#[\da-f]{3}(?:[\da-f]{3})?$/i, 'use a hexadecimal color')
  .transform((value) => value.toLowerCase());

function isSingleEmoji(value: string): boolean {
  if (
    value.length > 64 ||
    !/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Presentation}\u20e3]/u.test(value)
  )
    return false;
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length === 1;
}
export const BoardEmojiSchema = z.string().trim().min(1).refine(isSingleEmoji, 'choose one emoji');
export const HttpsImageUrlSchema = z
  .string()
  .max(4_096)
  .transform((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('invalid image url');
      return url.href;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'use an https image url without embedded credentials',
      });
      return z.NEVER;
    }
  });
export const BundledBoardBackgroundSchema = z.enum([
  '/backgrounds/lines.svg',
  '/backgrounds/circles.svg',
]);
export const BoardBackgroundSchema = z.union([BundledBoardBackgroundSchema, HttpsImageUrlSchema]);

const appearance = {
  emoji: BoardEmojiSchema.nullable().optional(),
  color: BoardColorSchema.optional(),
  backgroundUrl: BoardBackgroundSchema.nullable().optional(),
};
export const BoardAppearanceSchema = z
  .object(appearance)
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit at least one appearance field',
  );
export type BoardAppearance = z.infer<typeof BoardAppearanceSchema>;
export const CreateBoardSchema = z
  .object({
    title,
    emoji: BoardEmojiSchema.nullable().default(null),
    color: BoardColorSchema.default('#f1f0e9'),
    backgroundUrl: BoardBackgroundSchema.nullable().default(null),
  })
  .strict();
export type CreateBoardInput = z.input<typeof CreateBoardSchema>;
export const BoardPatchSchema = z
  .object({ title: title.optional(), ...appearance })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit at least one changed field',
  );
export type BoardPatch = z.infer<typeof BoardPatchSchema>;

export const BoardSchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    title: z.string(),
    isMain: z.boolean(),
    emoji: z.string().nullable(),
    color: BoardColorSchema,
    backgroundUrl: BoardBackgroundSchema.nullable(),
    position: z.number().int(),
    revision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Board = z.infer<typeof BoardSchema>;
export const BoardMembershipSchema = z
  .object({
    accountId: ResourceIdSchema,
    listId: ResourceIdSchema,
    boardId: ResourceIdSchema,
    color: BoardColorSchema,
    position: z.number().int(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type BoardMembership = z.infer<typeof BoardMembershipSchema>;
export const BoardListSchema = TaskListSchema.extend({
  boardId: ResourceIdSchema,
  color: BoardColorSchema,
  position: z.number().int(),
  membershipRevision: z.number().int().nonnegative(),
}).strict();
export type BoardList = z.infer<typeof BoardListSchema>;

export const BoardPageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type BoardPageOptions = z.input<typeof BoardPageOptionsSchema>;
export interface DeleteBoardResult {
  deletedBoardId: string;
  mainBoardId: string;
  movedListCount: number;
}
