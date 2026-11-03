import { z } from 'zod';
import { CreateTaskSchema, ListTitleSchema, ResourceIdSchema, TaskPatchSchema } from './contracts';
import { TaskScheduleSchema } from './planning-contract';
const id = ResourceIdSchema.max(1024);
const revision = z.number().int().nonnegative().safe();
const knownTask = { taskId: id, revision };
const knownList = { listId: id, revision };
const patch = z
  .object({
    title: TaskPatchSchema.shape.title,
    notes: TaskPatchSchema.shape.notes,
    scheduledDay: TaskPatchSchema.shape.scheduledDay,
    scheduledTime: TaskPatchSchema.shape.scheduledTime,
    timeZone: TaskPatchSchema.shape.timeZone,
    repeatRule: TaskPatchSchema.shape.repeatRule,
    labelIds: TaskPatchSchema.shape.labelIds,
    priority: TaskPatchSchema.shape.priority,
    starred: TaskPatchSchema.shape.starred,
    blockedBy: TaskPatchSchema.shape.blockedBy,
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit at least one changed field',
  );
const destination = {
  listId: id,
  listRevision: revision,
  parentId: id.nullable().default(null),
  parentRevision: revision.optional(),
  previousId: id.nullable().optional(),
  previousRevision: revision.optional(),
};
export const ProviderCommandSchema = z.discriminatedUnion('kind', [
  TaskScheduleSchema.safeExtend({
    kind: z.literal('task.create'),
    ...destination,
    title: CreateTaskSchema.shape.title,
    notes: CreateTaskSchema.shape.notes,
    labelIds: CreateTaskSchema.shape.labelIds,
    priority: CreateTaskSchema.shape.priority,
    starred: CreateTaskSchema.shape.starred,
    blockedBy: CreateTaskSchema.shape.blockedBy,
    expectedGraphRevision: revision.optional(),
  }).strict(),
  z
    .object({
      kind: z.literal('task.edit'),
      ...knownTask,
      patch,
      expectedGraphRevision: revision.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task.delete'),
      ...knownTask,
      confirm: z.literal(true),
      confirmSubtaskCount: z.number().int().nonnegative().optional(),
      confirmAssignment: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task.complete'),
      ...knownTask,
      confirmBlocked: z.literal(true).optional(),
      confirmOpenSubtaskCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('task.reopen'), ...knownTask }).strict(),
  z
    .object({
      kind: z.literal('task.move'),
      ...knownTask,
      ...destination,
      confirmSubtaskCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task.duplicate'),
      ...knownTask,
      ...destination,
      title: CreateTaskSchema.shape.title.optional(),
      includeCompleted: z.boolean().default(false),
      confirmIndependentRepeat: z.literal(true).optional(),
      confirmOmittedDependencyCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list.create'),
      title: ListTitleSchema,
      boardId: id,
      boardRevision: revision.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('list.rename'), ...knownList, title: ListTitleSchema }).strict(),
  z
    .object({
      kind: z.literal('list.delete'),
      ...knownList,
      confirm: z.literal(true),
      confirmTaskCount: z.number().int().nonnegative(),
      confirmAssignments: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list.duplicate'),
      ...knownList,
      title: ListTitleSchema,
      boardId: id,
      boardRevision: revision.optional(),
      includeCompleted: z.boolean().default(false),
      confirmIndependentRepeat: z.literal(true).optional(),
      confirmOmittedDependencyCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type ProviderCommand = z.output<typeof ProviderCommandSchema>;
export type ProviderCommandInput = z.input<typeof ProviderCommandSchema>;
export interface PrepareProviderCommand {
  operationId: string;
  ownerSubject: string;
  accountId: string;
  command: ProviderCommandInput;
}
