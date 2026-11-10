import { z } from 'zod';
import { LabelInputSchema, PrioritySchema } from './task';
import { ResourceIdSchema } from '../../../shared/contracts/identity';

const id = ResourceIdSchema.max(1_024);
const revision = z.number().int().nonnegative().safe();
export const DependencyGraphRevisionSchema = z.object({ revision }).strict();
const ids = (limit: number) =>
  z
    .array(id)
    .max(limit)
    .refine((value) => new Set(value).size === value.length, 'use each identity once');
export const TaskMetadataPatchSchema = z
  .object({
    labelIds: ids(20).optional(),
    priority: PrioritySchema.optional(),
    starred: z.boolean().optional(),
    blockedBy: ids(50).optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit at least one metadata field',
  );
export type TaskMetadataPatch = z.infer<typeof TaskMetadataPatchSchema>;
export const LabelPatchSchema = LabelInputSchema.partial()
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'submit a label name or color',
  );
export type LabelPatch = z.infer<typeof LabelPatchSchema>;

/** Actor, operation, event time and admitted resource identities are captured by the server. */
export const MetadataCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task.patch'),
      taskId: id,
      patch: TaskMetadataPatchSchema,
      expectedRevision: revision,
      expectedGraphRevision: revision.optional(),
    })
    .strict()
    .refine(
      (value) => value.patch.blockedBy === undefined || value.expectedGraphRevision !== undefined,
      'a dependency edit needs the graph revision',
    ),
  z.object({ kind: z.literal('label.create'), input: LabelInputSchema }).strict(),
  z
    .object({
      kind: z.literal('label.update'),
      labelId: id,
      input: LabelPatchSchema,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({ kind: z.literal('label.delete.start'), labelId: id, expectedRevision: revision })
    .strict(),
  z
    .object({
      kind: z.literal('label.delete.continue'),
      jobId: id,
      limit: z.number().int().min(1).max(10).optional(),
    })
    .strict(),
]);
export type MetadataCommand = z.infer<typeof MetadataCommandSchema>;
export const LabelDeletionQuerySchema = z.object({ jobId: id }).strict();
export const PendingLabelDeletionsQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type PendingLabelDeletionsQuery = z.input<typeof PendingLabelDeletionsQuerySchema>;
export const LabelDeletionJobSchema = z
  .object({
    id,
    accountId: id,
    labelId: id,
    labelName: z.string(),
    state: z.enum(['pending', 'completed']),
    removedAssociations: z.number().int().nonnegative(),
    revision,
    createdAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type LabelDeletionJob = z.infer<typeof LabelDeletionJobSchema>;
