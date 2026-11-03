import { z } from 'zod';
import { BoardBackgroundSchema, BoardColorSchema, BoardEmojiSchema } from './contracts';
import { ResourceIdSchema } from '../tasks/contracts';
import {
  SnapshotOptionsSchema,
  SnapshotSummarySchema,
  TemplateDescriptionSchema,
  TemplateMetadataPatchSchema,
  TemplateNameSchema,
  TemplateApplicationOptionsSchema,
} from '../tasks/template-contract';
import { TemplateScheduleSchema } from '../tasks/planning-contract';
export const BoardTemplateAppearanceSchema = z
  .object({
    title: z.string(),
    emoji: BoardEmojiSchema.nullable(),
    color: BoardColorSchema,
    backgroundUrl: BoardBackgroundSchema.nullable(),
  })
  .strict();
export const BoardTemplateSummarySchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    kind: z.literal('board'),
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema,
    revision: z.number().int().nonnegative(),
    contentRevision: z.number().int().positive(),
    snapshot: SnapshotSummarySchema,
    appearance: BoardTemplateAppearanceSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type BoardTemplateSummary = z.infer<typeof BoardTemplateSummarySchema>;
export const CreateBoardTemplateSchema = SnapshotOptionsSchema.extend({
  name: TemplateNameSchema,
  description: TemplateDescriptionSchema.default(''),
  boardId: ResourceIdSchema.max(1024),
  boardRevision: z.number().int().nonnegative(),
}).strict();
export const TemplateReferenceSchema = z
  .object({
    kind: z.enum(['list', 'board']),
    id: ResourceIdSchema.max(1024),
    contentRevision: z.number().int().positive(),
  })
  .strict();
export type TemplateReference = z.infer<typeof TemplateReferenceSchema>;
export const ApplyTemplateSchema = TemplateApplicationOptionsSchema.extend({
  template: TemplateReferenceSchema,
  destination: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('existing'),
        boardId: ResourceIdSchema.max(1024),
        boardRevision: z.number().int().nonnegative(),
      })
      .strict(),
    z.object({ kind: z.literal('new'), title: TemplateNameSchema }).strict(),
  ]),
  confirmed: z.literal(true),
}).strict();
export const CreateTemplateScheduleSchema = z
  .object({
    template: TemplateReferenceSchema,
    boardId: ResourceIdSchema.max(1024),
    boardRevision: z.number().int().nonnegative(),
    timing: TemplateScheduleSchema,
    useRelativeDates: z.boolean().default(true),
    listPrefix: TemplateApplicationOptionsSchema.shape.listPrefix,
  })
  .strict();
export const TemplateSchedulePatchSchema = z
  .object({
    template: TemplateReferenceSchema.optional(),
    boardId: ResourceIdSchema.max(1024).optional(),
    boardRevision: z.number().int().nonnegative().optional(),
    timing: TemplateScheduleSchema.optional(),
    useRelativeDates: z.boolean().optional(),
    listPrefix: TemplateApplicationOptionsSchema.shape.listPrefix.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit at least one schedule change',
  );
export const TemplateScheduleStateSchema = z.enum(['active', 'paused', 'deleted']);
export const TemplateScheduleSummarySchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    template: TemplateReferenceSchema,
    boardId: ResourceIdSchema,
    timing: TemplateScheduleSchema,
    useRelativeDates: z.boolean(),
    listPrefix: z.string(),
    state: TemplateScheduleStateSchema,
    pauseReason: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    nextRunAt: z.iso.datetime({ offset: true }).nullable(),
    lastClaimedDay: z.string().nullable(),
    lastResolvedDay: z.string().nullable(),
    catchUpRequired: z.boolean(),
    activeRunId: ResourceIdSchema.nullable(),
  })
  .strict();
export type TemplateScheduleSummary = z.infer<typeof TemplateScheduleSummarySchema>;
export const TemplateRunSummarySchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    scheduleId: ResourceIdSchema.nullable(),
    slotDay: z.string(),
    snapshotId: ResourceIdSchema,
    operationId: ResourceIdSchema,
    state: z.enum(['capturing', 'running', 'partial', 'paused', 'succeeded', 'cancelled']),
    errorCode: z.string().nullable(),
    skippedBefore: z.string().nullable(),
  })
  .strict();
export type TemplateRunSummary = z.infer<typeof TemplateRunSummarySchema>;
export { TemplateMetadataPatchSchema };
