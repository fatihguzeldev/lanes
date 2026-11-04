import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import {
  CreateTaskSchema,
  LabelInputSchema,
  ListTitleSchema,
  PrioritySchema,
  ResourceIdSchema,
} from '../../contracts';
import { TaskScheduleSchema } from '../../planning-contract';
import type { CreationSource } from '../../../history/contracts';
import type { ProviderCommand } from '../../provider-command-contract';
export const CopyEntrySchema = TaskScheduleSchema.safeExtend({
  listKey: ResourceIdSchema.max(256).optional(),
  sourceTaskId: ResourceIdSchema.max(1024).optional(),
  key: ResourceIdSchema.max(256),
  position: z.number().int().min(0).max(2000),
  parentKey: ResourceIdSchema.max(256).nullable().default(null),
  previousKey: ResourceIdSchema.max(256).nullable().optional(),
  title: CreateTaskSchema.shape.title,
  notes: CreateTaskSchema.shape.notes,
  completed: z.boolean().default(false),
  completedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  labelDefinitions: z.array(LabelInputSchema).max(20).default([]),
  labelIds: CreateTaskSchema.shape.labelIds,
  priority: PrioritySchema.default('none'),
  starred: z.boolean().default(false),
  dependencyKeys: z.array(ResourceIdSchema.max(256)).max(50).default([]),
  existingBlockerIds: CreateTaskSchema.shape.blockedBy,
})
  .strict()
  .superRefine((value, context) => {
    if (value.labelDefinitions.length + value.labelIds.length > 20)
      context.addIssue({
        code: 'custom',
        path: ['labelDefinitions'],
        message: 'a task has at most 20 labels',
      });
    if (value.parentKey && value.repeatRule)
      context.addIssue({
        code: 'custom',
        path: ['repeatRule'],
        message: 'a copied subtask cannot repeat independently',
      });
    if (!value.completed && value.completedAt)
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'an open copy cannot retain a completion timestamp',
      });
  });
export type CopyEntry = z.input<typeof CopyEntrySchema>;
export const CopyListDefinitionSchema = z
  .object({
    key: ResourceIdSchema.max(256),
    position: z.number().int().min(0).max(99),
    title: ListTitleSchema.optional(),
    boardId: ResourceIdSchema.max(1024).optional(),
    boardRevision: z.number().int().nonnegative().safe().optional(),
    color: z
      .string()
      .regex(/^#[\da-f]{3}(?:[\da-f]{3})?$/i)
      .transform((value) => value.toLowerCase())
      .optional(),
    existingListId: ResourceIdSchema.max(1024).optional(),
    revision: z.number().int().nonnegative().safe().optional(),
    targetListId: ResourceIdSchema.max(1024).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.existingListId
        ? value.revision !== undefined && !value.boardId && !value.title && !value.targetListId
        : !!value.title && !!value.boardId,
    'choose an existing list/revision or a new title/board',
  );
export type CopyListDefinition = z.input<typeof CopyListDefinitionSchema>;
export interface BeginCapturedCopy {
  operationId: string;
  ownerSubject: string;
  accountId: string;
  source: CreationSource;
  origin: 'owner' | 'scheduled';
  listId?: string;
  listRevision?: number;
  totalTasks: number;
  requestKey: string;
  totalLists?: number;
  newListCount?: number;
  lists?: CopyListDefinition[];
  parentTaskId?: string;
  previousTaskId?: string | null;
  scheduleId?: string;
  runId?: string;
  guardWrites?: D1PreparedStatement[];
  newList?: {
    title: string;
    boardId: string;
    boardRevision?: number;
  };
  request?: ProviderCommand;
}
export async function copyTaskId(operationId: string, key: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationId + ':copy:' + key)),
  );
  return (
    'task-' +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)
  );
}
