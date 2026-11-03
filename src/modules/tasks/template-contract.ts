import { z } from 'zod';
import { CreateTaskSchema, LabelInputSchema, PrioritySchema, ResourceIdSchema } from './contracts';
import {
  CalendarDateSchema,
  LocalTimeSchema,
  RepeatRuleSchema,
  TimeZoneSchema,
} from './planning-contract';
const key = ResourceIdSchema.max(256);
const timestamp = z.iso.datetime({ offset: true });
export const TemplateNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= 128, 'use at most 128 characters');
export const TemplateDescriptionSchema = z
  .string()
  .refine((value) => [...value].length <= 2000, 'use at most 2,000 characters');
export const TemplateDateModeSchema = z.enum(['relative', 'none']);
export const TemplateColorSchema = LabelInputSchema.shape.color;
const preset = RepeatRuleSchema.shape;
export const TemplateRepeatPresetSchema = z
  .object({
    frequency: preset.frequency,
    interval: preset.interval,
    zone: preset.zone,
    weekStart: preset.weekStart,
    weekdays: preset.weekdays,
    end: z.discriminatedUnion('type', [
      z.object({ type: z.literal('never') }).strict(),
      z.object({ type: z.literal('count'), count: z.number().int().min(1).max(10000) }).strict(),
      z.object({ type: z.literal('date'), offsetDays: z.number().int().safe() }).strict(),
    ]),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.frequency === 'weekly' && !rule.weekdays.length)
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'choose at least one weekday',
      });
    if (new Set(rule.weekdays).size !== rule.weekdays.length)
      context.addIssue({ code: 'custom', path: ['weekdays'], message: 'use each weekday once' });
  });
export const TemplateTaskSchema = z
  .object({
    key,
    listKey: key,
    parentKey: key.nullable(),
    position: z.number().int().min(0).max(1999),
    title: CreateTaskSchema.shape.title,
    notes: CreateTaskSchema.shape.notes,
    dayOffset: z.number().int().safe().nullable(),
    scheduledTime: LocalTimeSchema.nullable(),
    timeZone: TimeZoneSchema.nullable(),
    repeatPreset: TemplateRepeatPresetSchema.nullable(),
    labels: z.array(LabelInputSchema).max(20),
    priority: PrioritySchema,
    starred: z.boolean(),
    dependencyKeys: z.array(key).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scheduledTime && (value.dayOffset === null || value.timeZone === null))
      context.addIssue({
        code: 'custom',
        path: ['scheduledTime'],
        message: 'a captured local time needs a relative day and zone',
      });
    if (value.parentKey && value.repeatPreset)
      context.addIssue({
        code: 'custom',
        path: ['repeatPreset'],
        message: 'subtasks cannot repeat independently',
      });
    if (
      new Set(value.labels.map((label) => label.name.normalize('NFC').toLowerCase())).size !==
      value.labels.length
    )
      context.addIssue({
        code: 'custom',
        path: ['labels'],
        message: 'use each normalized label name once',
      });
    if (value.timeZone && value.dayOffset === null)
      context.addIssue({
        code: 'custom',
        path: ['timeZone'],
        message: 'a captured time zone needs a relative day',
      });
    if (new Set(value.dependencyKeys).size !== value.dependencyKeys.length)
      context.addIssue({
        code: 'custom',
        path: ['dependencyKeys'],
        message: 'use each dependency once',
      });
  });
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;
export const TemplateListSchema = z
  .object({
    key,
    title: z.string(),
    color: TemplateColorSchema,
    position: z.number().int().min(0).max(99),
  })
  .strict();
export type TemplateList = z.infer<typeof TemplateListSchema>;
export const SnapshotSummarySchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    schemaVersion: z.literal(1),
    dateMode: TemplateDateModeSchema,
    saveDay: CalendarDateSchema,
    zone: TimeZoneSchema,
    listCount: z.number().int().min(0).max(100),
    taskCount: z.number().int().min(0).max(2000),
    contextParentCount: z.number().int().nonnegative(),
    completedIncludedCount: z.number().int().nonnegative(),
    omittedDependencyCount: z.number().int().nonnegative(),
    sourceDatedCount: z.number().int().nonnegative(),
    sourceTimedCount: z.number().int().nonnegative(),
    sourceRepeatCount: z.number().int().nonnegative(),
    createdAt: timestamp,
  })
  .strict();
export type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>;
export const ListTemplateSummarySchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    kind: z.literal('list'),
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema,
    revision: z.number().int().nonnegative(),
    contentRevision: z.number().int().positive(),
    snapshot: SnapshotSummarySchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ListTemplateSummary = z.infer<typeof ListTemplateSummarySchema>;
export const TemplateMetadataPatchSchema = z
  .object({
    name: TemplateNameSchema.optional(),
    description: TemplateDescriptionSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit a name or description',
  );
export const SnapshotOptionsSchema = z
  .object({
    includeCompleted: z.boolean().default(false),
    dateMode: TemplateDateModeSchema.default('relative'),
  })
  .strict();
export const CreateListTemplateSchema = SnapshotOptionsSchema.extend({
  name: TemplateNameSchema,
  description: TemplateDescriptionSchema.default(''),
  listId: ResourceIdSchema.max(1024),
  listRevision: z.number().int().nonnegative(),
}).strict();
export const TemplatePageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type TemplatePageOptions = z.input<typeof TemplatePageOptionsSchema>;
export const SnapshotPageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(10).default(10),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type SnapshotPageOptions = z.input<typeof SnapshotPageOptionsSchema>;
export const TemplateApplicationOptionsSchema = z
  .object({
    applicationDay: CalendarDateSchema,
    useRelativeDates: z.boolean().default(true),
    listPrefix: z
      .string()
      .trim()
      .refine((value) => [...value].length <= 128, 'use at most 128 prefix characters')
      .default(''),
  })
  .strict();
export type TemplateApplicationOptions = z.output<typeof TemplateApplicationOptionsSchema>;
export interface TemplateLabelColorConflict {
  name: string;
  requestedColor: string;
  keptColor: string;
}
export interface TemplatePreview {
  labelDefinitionCount: number;
  labelColorConflictCount: number;
  listCount: number;
  taskCount: number;
  requiredListSlots: number;
  omittedDependencyCount: number;
  omittedDates: number;
  omittedTimes: number;
  omittedRepeatRules: number;
  negativeDateCount: number;
}
export const TemplateDocumentHeaderSchema = z
  .object({
    schemaVersion: z.literal(1),
    dateMode: TemplateDateModeSchema,
    saveDay: CalendarDateSchema,
    zone: TimeZoneSchema,
    listCount: z.number().int().min(0).max(100),
    taskCount: z.number().int().min(0).max(2000),
    contextParentCount: z.number().int().min(0).max(2000).default(0),
    completedIncludedCount: z.number().int().min(0).max(2000).default(0),
    omittedDependencyCount: z.number().int().min(0).max(100000).default(0),
    sourceDatedCount: z.number().int().min(0).max(2000).optional(),
    sourceTimedCount: z.number().int().min(0).max(2000).optional(),
    sourceRepeatCount: z.number().int().min(0).max(2000).optional(),
  })
  .strict()
  .superRefine((header, context) => {
    if (
      header.contextParentCount > header.taskCount ||
      header.completedIncludedCount > header.taskCount ||
      [header.sourceDatedCount, header.sourceTimedCount, header.sourceRepeatCount].some(
        (value) => value !== undefined && value > header.taskCount,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'source counts cannot exceed the captured task count',
      });
    if (
      header.sourceTimedCount !== undefined &&
      header.sourceDatedCount !== undefined &&
      header.sourceTimedCount > header.sourceDatedCount
    )
      context.addIssue({
        code: 'custom',
        path: ['sourceTimedCount'],
        message: 'timed tasks need scheduled days',
      });
  });
export type TemplateDocumentHeader = z.input<typeof TemplateDocumentHeaderSchema>;
export const TemplateDocumentSchema = z
  .object({
    header: TemplateDocumentHeaderSchema,
    lists: z.array(TemplateListSchema).max(100),
    tasks: z.array(TemplateTaskSchema).max(2000),
  })
  .strict();
export type TemplateDocument = z.input<typeof TemplateDocumentSchema>;
