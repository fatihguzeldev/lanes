import { z } from 'zod';
import { PrioritySchema, ResourceIdSchema, type Task, type TaskList } from '../../tasks/contracts';
import {
  CalendarDateSchema,
  LocalTimeSchema,
  RepeatRuleSchema,
  TimeZoneSchema,
} from '../../tasks/planning-contract';

export const HISTORY_RETENTION_MS = 90 * 86_400_000;
const timestamp = z.iso.datetime({ offset: true });
const recordedTimestamp = timestamp.refine(
  (value) => !/\.\d{4}/.test(value),
  'recorded time uses millisecond precision',
);
const snapshot = z
  .string()
  .refine(
    (value) => [...value].length <= 1_024,
    'a title snapshot may contain at most 1,024 characters',
  );
const references = (max: number) =>
  z
    .array(ResourceIdSchema)
    .max(max)
    .refine((value) => new Set(value).size === value.length, 'use each reference once');
const provenance = {
  operationId: ResourceIdSchema.optional(),
  stepKey: ResourceIdSchema.optional(),
  providerVersion: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value.trim().length > 0, 'provide a resource version')
    .optional(),
  scheduleId: ResourceIdSchema.optional(),
  runId: ResourceIdSchema.optional(),
};
const summary = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...provenance, ...shape }).strict();
const base = {
  id: ResourceIdSchema,
  schemaVersion: z.literal(1).default(1),
  accountId: ResourceIdSchema,
  taskId: ResourceIdSchema.nullable().default(null),
  listId: ResourceIdSchema.nullable().default(null),
  origin: z.enum(['owner', 'scheduled', 'observed']),
  dedupKey: z
    .string()
    .min(1)
    .max(2_048)
    .refine((value) => value.trim().length > 0, 'provide a source deduplication key'),
  recordedAt: recordedTimestamp,
  providerAt: timestamp.nullable().default(null),
  taskTitle: snapshot.nullable().default(null),
  listTitle: snapshot.nullable().default(null),
};
const event = <const Kind extends string, Summary extends z.ZodType>(kind: Kind, value: Summary) =>
  z.object({ ...base, kind: z.literal(kind), summary: value }).strict();
const address = z
  .object({ listId: ResourceIdSchema, parentId: ResourceIdSchema.nullable() })
  .strict();
const time = z
  .object({ time: LocalTimeSchema.nullable(), zone: TimeZoneSchema.nullable() })
  .strict()
  .refine((value) => !value.time || value.zone !== null, 'a local time needs its named zone');
export const CreationSourceSchema = z.enum([
  'direct',
  'import',
  'transfer',
  'template',
  'duplication',
  'repetition',
]);
export type CreationSource = z.infer<typeof CreationSourceSchema>;
export const HistoryEventKindSchema = z.enum([
  'task_created',
  'task_completed',
  'task_reopened',
  'task_moved',
  'task_deleted',
  'list_deleted',
  'scheduled_day_changed',
  'scheduled_time_changed',
  'repeat_rule_changed',
  'labels_changed',
  'priority_changed',
  'star_changed',
  'dependencies_changed',
]);
export type HistoryEventKind = z.infer<typeof HistoryEventKindSchema>;

export const HistoryEventSchema = z
  .discriminatedUnion('kind', [
    event(
      'task_created',
      summary({
        source: CreationSourceSchema.optional(),
        sourceAccountId: ResourceIdSchema.optional(),
        sourceTaskId: ResourceIdSchema.optional(),
        templateId: ResourceIdSchema.optional(),
        seriesId: ResourceIdSchema.optional(),
        occurrenceId: ResourceIdSchema.optional(),
      }),
    ),
    event('task_completed', summary({ completedAt: timestamp.nullable().default(null) })),
    event('task_reopened', summary({ previousCompletedAt: timestamp.nullable().default(null) })),
    event(
      'task_moved',
      summary({ from: address, to: address }).refine(
        (value) =>
          value.from.listId !== value.to.listId || value.from.parentId !== value.to.parentId,
        'manual sibling-order changes are not activity events',
      ),
    ),
    event(
      'task_deleted',
      summary({
        parentId: ResourceIdSchema.nullable().default(null),
        knownSubtaskCount: z.number().int().nonnegative().default(0),
      }),
    ),
    event(
      'list_deleted',
      summary({
        knownTaskCount: z.number().int().nonnegative(),
        coverageComplete: z.boolean().default(false),
      }),
    ),
    event(
      'scheduled_day_changed',
      summary({ before: CalendarDateSchema.nullable(), after: CalendarDateSchema.nullable() }),
    ),
    event('scheduled_time_changed', summary({ before: time, after: time })),
    event(
      'repeat_rule_changed',
      summary({ before: RepeatRuleSchema.nullable(), after: RepeatRuleSchema.nullable() }),
    ),
    event('labels_changed', summary({ before: references(20), after: references(20) })),
    event('priority_changed', summary({ before: PrioritySchema, after: PrioritySchema })),
    event('star_changed', summary({ before: z.boolean(), after: z.boolean() })),
    event('dependencies_changed', summary({ before: references(50), after: references(50) })),
  ])
  .superRefine((value, context) => {
    if (!value.listId)
      context.addIssue({
        code: 'custom',
        path: ['listId'],
        message: 'record the affected list identity',
      });
    if (value.kind !== 'list_deleted' && !value.taskId)
      context.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'record the affected task identity',
      });
    if (value.kind === 'list_deleted' && value.taskId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'a list deletion event does not identify one task',
      });
    }
    if (value.origin === 'observed') {
      if (!value.summary.providerVersion)
        context.addIssue({
          code: 'custom',
          path: ['summary', 'providerVersion'],
          message: 'an observation needs a provider version',
        });
      if (
        value.summary.operationId ||
        value.summary.stepKey ||
        value.summary.scheduleId ||
        value.summary.runId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['summary'],
          message: 'an external observation cannot claim a lanes operation or actor',
        });
      }
      if (value.kind === 'task_created' && value.summary.source !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['summary', 'source'],
          message: 'google does not reveal the source of external creation',
        });
      }
    } else {
      if (!value.summary.operationId || !value.summary.stepKey) {
        context.addIssue({
          code: 'custom',
          path: ['summary'],
          message: 'record only a confirmed operation and step',
        });
      }
      if (value.summary.providerVersion !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['summary', 'providerVersion'],
          message: 'provider observations use the observed origin',
        });
      }
      if (value.kind === 'task_created' && value.summary.source === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['summary', 'source'],
          message: 'identify the creation context',
        });
      }
    }
  });
export type HistoryEvent = z.output<typeof HistoryEventSchema>;
export type HistoryEventInput = z.input<typeof HistoryEventSchema>;

export const HistoryQuerySchema = z
  .object({
    boardId: ResourceIdSchema.optional(),
    listId: ResourceIdSchema.optional(),
    taskId: ResourceIdSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type HistoryQuery = z.input<typeof HistoryQuerySchema>;

export type CompletedGroupKey =
  'today' | 'yesterday' | 'this_week' | 'earlier' | 'unknown_time' | 'future';
export interface CompletedOptions {
  accountId: string;
  zone: string;
  weekStart: 1 | 7;
  now: string;
  listIds?: readonly string[] | undefined;
  query?: string | undefined;
  lists?: readonly TaskList[] | undefined;
}
export interface CompletedTaskItem {
  task: Task;
  parent: Task | null;
  list: TaskList | null;
  completedDay: string | null;
}
export interface CompletedGroup {
  key: CompletedGroupKey;
  items: CompletedTaskItem[];
}
export interface CompletionSummary {
  days: { day: string; count: number; lists: { listId: string; count: number }[] }[];
  total: number;
  unknownTimeCount: number;
  outsideWindowCount: number;
  countingRule: 'current_completed_tasks_including_subtasks';
}
export interface HistoryDayGroup {
  day: string;
  events: HistoryEvent[];
}
