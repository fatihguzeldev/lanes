import { z } from 'zod';
import { OperationIdSchema } from '../../operations/contracts/receipt';
const providerId = z.string().min(1).max(2048),
  timestamp = z.number().int().nonnegative();
export const ResolutionDecisionSchema = z.enum(['adopt', 'keep_provider_current']);
export const ResolutionContextSchema = z
  .object({
    operationId: OperationIdSchema,
    stepKey: z.string(),
    action: z.string(),
    title: z.string(),
    listTitle: z.string(),
    hasRecordedResponse: z.boolean(),
    claimActive: z.boolean(),
    needsCandidate: z.boolean(),
  })
  .strict();
export const ResolutionCandidateSchema = z
  .object({
    providerId,
    title: z.string(),
    notes: z.string(),
    scheduledDay: z.string().nullable(),
    completed: z.boolean(),
    parentId: providerId.nullable(),
    etag: z.string().nullable(),
    alreadyRetained: z.boolean(),
    retainedId: z.string().nullable().default(null),
  })
  .strict();
export const ResolutionCandidatesSchema = z
  .object({
    context: ResolutionContextSchema,
    items: z.array(ResolutionCandidateSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const ResolutionPreviewSchema = z
  .object({
    context: ResolutionContextSchema,
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    candidate: ResolutionCandidateSchema.nullable(),
    canConfirm: z.boolean(),
    reason: z.string().nullable(),
    checkedAt: timestamp,
    decision: ResolutionDecisionSchema.default('adopt'),
    canKeepProviderCurrent: z.boolean().default(false),
    stopExplanation: z.string().nullable().default(null),
  })
  .strict();
export const ResolutionPreviewRequestSchema = z
  .object({
    candidateId: providerId.optional(),
    decision: ResolutionDecisionSchema.default('adopt'),
  })
  .strict();
export const ResolutionConfirmSchema = ResolutionPreviewRequestSchema.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
  confirmIdentity: z.literal(true).optional(),
}).strict();
export const ResolutionCandidatesRequestSchema = z
  .object({ cursor: z.string().min(1).max(32768).optional() })
  .strict();
export type ResolutionContext = z.infer<typeof ResolutionContextSchema>;
export type ResolutionCandidate = z.infer<typeof ResolutionCandidateSchema>;
export type ResolutionPreview = z.infer<typeof ResolutionPreviewSchema>;
