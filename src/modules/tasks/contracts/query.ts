import { CoverageSchema } from '../../../shared/contracts/coverage';
import { z } from 'zod';
import { LabelSchema, TaskFilterSchema, TaskSchema, TaskSortSchema } from './task';
import { ResourceIdSchema } from '../../../shared/contracts/identity';

const ids = z
  .array(ResourceIdSchema)
  .max(2_000)
  .refine((values) => new Set(values).size === values.length, 'use each list once');
export const TaskQuerySchema = z
  .object({
    boardId: ResourceIdSchema.optional(),
    listIds: ids.optional(),
    parentId: ResourceIdSchema.nullable().optional(),
    query: z.string().max(512).default(''),
    filter: TaskFilterSchema.default({}),
    sort: TaskSortSchema.default('manual'),
    limit: z
      .number()
      .int()
      .min(2, 'a task page needs room for a task and its parent context')
      .max(100)
      .default(50),
    cursor: z.string().min(1).max(32_768).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.filter.listIds?.length ?? 0) > 2_000)
      context.addIssue({
        code: 'custom',
        path: ['filter', 'listIds'],
        message: 'select at most 2,000 lists',
      });
  });
export type TaskQueryInput = z.input<typeof TaskQuerySchema>;
export type TaskQuery = z.output<typeof TaskQuerySchema>;

export const TaskDependantSchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    listId: ResourceIdSchema,
    listTitle: z.string(),
    parentId: ResourceIdSchema.nullable(),
    parentTitle: z.string().nullable(),
    title: z.string(),
    completed: z.boolean(),
    providerMissing: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type TaskDependant = z.infer<typeof TaskDependantSchema>;
export const TaskDependantsQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(32_768).optional(),
  })
  .strict();
export type TaskDependantsQueryInput = z.input<typeof TaskDependantsQuerySchema>;
export const TaskDependantsPageSchema = z
  .object({
    items: z.array(TaskDependantSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: CoverageSchema,
    graphRevision: z.number().int().nonnegative(),
  })
  .strict();
export type TaskDependantsPage = z.infer<typeof TaskDependantsPageSchema>;
export const SubtaskSummarySchema = z
  .object({
    open: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict()
  .refine((summary) => summary.open <= summary.total, 'open subtasks cannot exceed the total');
export type SubtaskSummary = z.infer<typeof SubtaskSummarySchema>;

export const TaskPageSchema = z
  .object({
    items: z.array(TaskSchema).max(100),
    matchedTaskIds: z.array(ResourceIdSchema).max(100),
    contextTaskIds: z.array(ResourceIdSchema).max(100),
    subtaskSummaries: z.record(ResourceIdSchema, SubtaskSummarySchema),
    nextCursor: z.string().nullable(),
    coverage: CoverageSchema,
    providerCoverage: CoverageSchema,
  })
  .strict();
export type TaskPage = z.infer<typeof TaskPageSchema>;

/** Export owns pagination of the whole selection, including each context parent once. */
export const TaskExportQuerySchema = TaskQuerySchema.safeExtend({
  sort: z.literal('manual').default('manual'),
  limit: z.number().int().min(1).max(10).default(10),
});
export type TaskExportQueryInput = z.input<typeof TaskExportQuerySchema>;
export const TaskExportPageSchema = z
  .object({
    items: z.array(TaskSchema).max(10),
    matchedTaskIds: z.array(ResourceIdSchema).max(10),
    contextTaskIds: z.array(ResourceIdSchema).max(10),
    nextCursor: z.string().nullable(),
    providerCoverage: CoverageSchema,
  })
  .strict();
export type TaskExportPage = z.infer<typeof TaskExportPageSchema>;

export const LabelQuerySchema = z
  .object({
    query: z.string().max(512).default(''),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(32_768).optional(),
  })
  .strict();
export type LabelQueryInput = z.input<typeof LabelQuerySchema>;
export const LabelPageSchema = z
  .object({
    items: z.array(LabelSchema).max(100),
    nextCursor: z.string().nullable(),
    coverage: CoverageSchema,
  })
  .strict();
