import { z } from 'zod';
import {
  BoardTemplateSummarySchema,
  TemplateRunSummarySchema,
  TemplateScheduleSummarySchema,
} from '../../contracts/template';
import {
  ListTemplateSummarySchema,
  SnapshotSummarySchema,
  TemplateDocumentSchema,
} from '../../../tasks/contracts/template';

const CoverageSchema = z
  .object({ complete: z.boolean(), stale: z.boolean(), lastSyncedAt: z.string().nullable() })
  .strict();

export const page = <S extends z.ZodType>(schema: S) =>
  z
    .object({
      items: z.array(schema).max(100),
      nextCursor: z.string().nullable(),
      coverage: CoverageSchema,
    })
    .strict();

export const ListPageSchema = page(ListTemplateSummarySchema),
  BoardTemplatePageSchema = page(BoardTemplateSummarySchema);

export const SchedulePageSchema = page(TemplateScheduleSummarySchema),
  RunPageSchema = page(TemplateRunSummarySchema);

export const GallerySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            document: TemplateDocumentSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type Gallery = z.infer<typeof GallerySchema>['items'];

export const SourcePreviewSchema = SnapshotSummarySchema.omit({ id: true, createdAt: true });

export type SourcePreview = z.infer<typeof SourcePreviewSchema>;

const count = z.number().int().nonnegative();

const PreviewSchema = z
  .object({
    labelDefinitionCount: count,
    labelColorConflictCount: count,
    listCount: count,
    taskCount: count,
    requiredListSlots: count,
    omittedDependencyCount: count,
    omittedDates: count,
    omittedTimes: count,
    omittedRepeatRules: count,
    negativeDateCount: count,
  })
  .strict();

const CapacitySchema = z
  .object({
    known: count.nullable(),
    reserved: count,
    available: count.nullable(),
    stale: z.boolean(),
  })
  .strict();

export const ApplicationPreviewSchema = z
  .object({ preview: PreviewSchema, capacity: CapacitySchema })
  .strict();

export type Capacity = z.infer<typeof CapacitySchema>;

export const ConflictPageSchema = page(
  z.object({ name: z.string(), requestedColor: z.string(), keptColor: z.string() }).strict(),
);
