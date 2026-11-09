import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';
const count = z.number().int().nonnegative();
export const TaskConsequencesSchema = z
  .object({
    taskId: ResourceIdSchema,
    revision: count,
    title: z.string(),
    openSubtaskCount: count,
    subtaskCount: count,
    openBlockerCount: count,
    unknownBlockerCount: count,
    openBlockedSubtaskCount: count.default(0),
    assignmentSource: z.enum(['docs', 'chat']).nullable(),
    coverageComplete: z.boolean(),
    completionCoverageComplete: z.boolean().optional(),
  })
  .strict();
export const ListConsequencesSchema = z
  .object({
    listId: ResourceIdSchema,
    revision: count,
    title: z.string(),
    taskCount: count,
    assignedTaskCount: count,
    coverageComplete: z.boolean(),
    isDefault: z.boolean(),
  })
  .strict();
export const DuplicateConsequencesSchema = z
  .object({
    taskCount: count,
    contextParentCount: count,
    externalDependencyCount: count,
    repeatingTaskCount: count,
    coverageComplete: z.boolean(),
  })
  .strict();
export const ListCapacitySchema = z
  .object({
    known: count.nullable(),
    reserved: count,
    available: count.nullable(),
    stale: z.boolean(),
  })
  .strict();
export const DuplicatePreviewSchema = z
  .object({ preview: DuplicateConsequencesSchema, capacity: ListCapacitySchema })
  .strict();
