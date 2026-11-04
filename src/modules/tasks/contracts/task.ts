import { ResourceIdSchema } from '../../../shared/contracts/identity';
import { z } from 'zod';
import {
  CalendarDateSchema,
  LocalTimeSchema,
  RepeatRuleSchema,
  TaskScheduleSchema,
  TimeZoneSchema,
} from './planning';

export type { RepeatRule } from './planning';

const TimestampSchema = z.iso.datetime({ offset: true });
const nullableTimestamp = TimestampSchema.nullable();
const textLength = (limit: number) => (value: string) => [...value].length <= limit;
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'enter a title')
  .refine(textLength(1_024), 'use at most 1,024 characters');
const NotesSchema = z.string().refine(textLength(8_192), 'use at most 8,192 characters');
const uniqueIds = (limit: number) =>
  z
    .array(ResourceIdSchema)
    .max(limit)
    .refine((ids) => new Set(ids).size === ids.length, 'use each identity once');

export const PrioritySchema = z.enum(['none', 'low', 'medium', 'high']);
export type Priority = z.infer<typeof PrioritySchema>;

export const TaskCapabilitiesSchema = z
  .object({
    canEdit: z.boolean(),
    canEditNotes: z.boolean(),
    canMove: z.boolean(),
    canDelete: z.boolean(),
    canHaveChildren: z.boolean(),
    canNest: z.boolean(),
    assignmentSource: z.enum(['docs', 'chat']).nullable(),
    sourceUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      }, 'use an https source url')
      .nullable(),
    restriction: z.string().nullable(),
  })
  .strict();
export type TaskCapabilities = z.infer<typeof TaskCapabilitiesSchema>;

export const ProviderTaskAddressSchema = z
  .object({
    id: ResourceIdSchema,
    listId: ResourceIdSchema,
    etag: z.string().nullable(),
    position: z.string().nullable(),
    updatedAt: nullableTimestamp,
    missing: z.boolean().optional(),
  })
  .strict();
export type ProviderTaskAddress = z.infer<typeof ProviderTaskAddressSchema>;

// A retained provider title may be empty. Input validation must not rewrite it.
export const TaskSchema = TaskScheduleSchema.safeExtend({
  id: ResourceIdSchema,
  accountId: ResourceIdSchema,
  listId: ResourceIdSchema,
  parentId: ResourceIdSchema.nullable(),
  title: z.string(),
  notes: z.string(),
  completed: z.boolean(),
  completedAt: nullableTimestamp,
  seriesId: ResourceIdSchema.nullable(),
  occurrenceId: ResourceIdSchema.nullable(),
  labelIds: uniqueIds(20),
  priority: PrioritySchema,
  starred: z.boolean(),
  blockedBy: uniqueIds(50),
  revision: z.number().int().nonnegative(),
  provider: ProviderTaskAddressSchema,
  capabilities: TaskCapabilitiesSchema,
  unsupportedHierarchy: z.boolean(),
}).strict();
export type Task = z.infer<typeof TaskSchema>;

export const TaskListSchema = z
  .object({
    id: ResourceIdSchema,
    accountId: ResourceIdSchema,
    title: z.string(),
    providerId: ResourceIdSchema,
    providerEtag: z.string().nullable(),
    isDefault: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type TaskList = z.infer<typeof TaskListSchema>;

export const ListTitleSchema = TitleSchema;
export const LabelInputSchema = z
  .object({
    name: z.string().trim().min(1).refine(textLength(64), 'use at most 64 characters'),
    color: z
      .string()
      .regex(/^#[\da-f]{3}(?:[\da-f]{3})?$/i, 'use a hexadecimal color')
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const LabelSchema = LabelInputSchema.extend({
  id: ResourceIdSchema,
  accountId: ResourceIdSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export type Label = z.infer<typeof LabelSchema>;
export type LabelInput = z.infer<typeof LabelInputSchema>;

export const CreateTaskSchema = TaskScheduleSchema.safeExtend({
  accountId: ResourceIdSchema,
  listId: ResourceIdSchema,
  parentId: ResourceIdSchema.nullable().default(null),
  title: TitleSchema,
  notes: NotesSchema.default(''),
  labelIds: uniqueIds(20).default([]),
  priority: PrioritySchema.default('none'),
  starred: z.boolean().default(false),
  blockedBy: uniqueIds(50).default([]),
})
  .strict()
  .superRefine((input, context) => {
    if (input.parentId && input.repeatRule) {
      context.addIssue({
        code: 'custom',
        path: ['repeatRule'],
        message: 'a nested subtask cannot repeat independently',
      });
    }
  });
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;
export type CreateTask = z.output<typeof CreateTaskSchema>;

// No defaults here: an omitted field must remain omitted during a narrow patch.
export const TaskPatchSchema = z
  .object({
    title: TitleSchema.optional(),
    notes: NotesSchema.optional(),
    listId: ResourceIdSchema.optional(),
    parentId: ResourceIdSchema.nullable().optional(),
    scheduledDay: CalendarDateSchema.nullable().optional(),
    scheduledTime: LocalTimeSchema.nullable().optional(),
    timeZone: TimeZoneSchema.nullable().optional(),
    repeatRule: RepeatRuleSchema.nullable().optional(),
    labelIds: uniqueIds(20).optional(),
    priority: PrioritySchema.optional(),
    starred: z.boolean().optional(),
    blockedBy: uniqueIds(50).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!Object.values(input).some((value) => value !== undefined)) {
      context.addIssue({ code: 'custom', message: 'submit at least one changed field' });
    }
    if (
      input.scheduledDay === null &&
      (input.scheduledTime || input.timeZone || input.repeatRule)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledDay'],
        message: 'a cleared day cannot retain a time or repeat rule',
      });
    }
  });
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

export const TaskSortSchema = z.enum(['manual', 'scheduled', 'title', 'updated', 'priority']);
export type TaskSort = z.infer<typeof TaskSortSchema>;
export const DependencyStateSchema = z.enum(['blocked', 'unblocked', 'unknown']);
export type DependencyState = z.infer<typeof DependencyStateSchema>;
const ScheduledFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('overdue') }).strict(),
  z.object({ kind: z.literal('today') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({ kind: z.literal('range'), from: CalendarDateSchema, to: CalendarDateSchema })
    .strict()
    .refine((value) => value.from <= value.to, 'the range end cannot precede its start'),
]);
export const TaskFilterSchema = z
  .object({
    listIds: z.array(ResourceIdSchema).optional(),
    completion: z.enum(['open', 'completed', 'all']).optional(),
    labelIds: z.array(ResourceIdSchema).max(20).optional(),
    labelMatch: z.enum(['any', 'all']).optional(),
    priorities: z.array(PrioritySchema).max(4).optional(),
    starred: z.boolean().optional(),
    dependencyStates: z.array(DependencyStateSchema).max(3).optional(),
    scheduled: ScheduledFilterSchema.optional(),
  })
  .strict();
export type TaskFilter = z.infer<typeof TaskFilterSchema>;

export interface TaskSelectionOptions {
  accountId: string;
  today: string;
  query?: string | undefined;
  listIds?: readonly string[] | undefined;
  filter?: TaskFilter | undefined;
  labels?: readonly Label[] | undefined;
  lists?: readonly TaskList[] | undefined;
}
export interface TaskSelection {
  tasks: Task[];
  matchedTaskIds: string[];
  contextTaskIds: string[];
}

export type ModelIssueCode =
  | 'duplicate_task_id'
  | 'self_parent'
  | 'missing_parent'
  | 'cross_account_parent'
  | 'cross_list_parent'
  | 'nested_parent'
  | 'hierarchy_cycle'
  | 'children_not_supported'
  | 'nesting_not_supported'
  | 'self_dependency'
  | 'missing_dependency'
  | 'cross_account_dependency'
  | 'dependency_cycle'
  | 'too_many_dependencies';
export interface ModelIssue {
  accountId: string;
  code: ModelIssueCode;
  taskId: string;
  relatedTaskId?: string;
  message: string;
}
export interface BlockingState {
  state: DependencyState;
  openBlockers: Task[];
  missingBlockerIds: string[];
}

export interface TaskMoveIntent {
  accountId: string;
  taskId: string;
  revision: number;
  sourceListId: string;
  destinationListId: string;
  parentId: null;
  previousTaskId: string | null;
}
