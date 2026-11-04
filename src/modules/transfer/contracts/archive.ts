import { z } from 'zod';
import { LabelInputSchema, PrioritySchema } from '../../tasks/contracts/task';
import {
  CalendarDateSchema,
  TaskScheduleSchema,
  TemplateScheduleSchema,
  TimeZoneSchema,
} from '../../tasks/contracts/planning';
import {
  BoardColorSchema,
  BoardEmojiSchema,
  BoardBackgroundSchema,
} from '../../boards/contracts/board';
import {
  TemplateDocumentHeaderSchema,
  TemplateListSchema,
  TemplateTaskSchema,
  TemplateNameSchema,
  TemplateDescriptionSchema,
} from '../../tasks/contracts/template';
import { BoardTemplateAppearanceSchema } from '../../boards/contracts/template';
import { HistoryEventSchema } from '../../history/contracts/events';
export const ARCHIVE_FORMAT = 'lanes-workspace';
export const ARCHIVE_VERSION = 1;
export const ArchiveKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
const key = ArchiveKeySchema,
  providerId = z.string().min(1).max(2048),
  revision = z.number().int().nonnegative().safe();
const names = z.string().refine((value) => [...value].length <= 1024),
  notes = z.string().refine((value) => [...value].length <= 8192);
export const PortableAccountSchema = z
  .object({
    googleSubject: z.string().min(1).max(256),
    email: z.email().max(320),
    planningZone: TimeZoneSchema,
    weekStart: z.union([z.literal(1), z.literal(7)]),
  })
  .strict();
export const ArchiveHeaderSchema = z
  .object({
    format: z.literal(ARCHIVE_FORMAT),
    version: z.literal(ARCHIVE_VERSION),
    id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    generatedAt: z.iso.datetime({ offset: true }),
    source: PortableAccountSchema,
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('account') }).strict(),
      z.object({ kind: z.literal('board'), boardKey: key }).strict(),
    ]),
    includesTaskSnapshots: z.boolean(),
    generationNote: z.literal(
      'paginated retained projections; provider changes can produce a mixed-time export.',
    ),
  })
  .strict();
export type ArchiveHeader = z.infer<typeof ArchiveHeaderSchema>;
export const ArchiveBoardSchema = z
  .object({
    kind: z.literal('board'),
    key,
    title: z
      .string()
      .min(1)
      .refine((value) => [...value].length <= 128),
    isMain: z.boolean(),
    emoji: BoardEmojiSchema.nullable(),
    color: BoardColorSchema,
    backgroundUrl: BoardBackgroundSchema.nullable(),
    position: z.number().int(),
    revision,
  })
  .strict();
export const ArchiveListSchema = z
  .object({
    kind: z.literal('list'),
    key,
    boardKey: key,
    providerId,
    title: names,
    color: BoardColorSchema,
    position: z.number().int(),
    revision,
    membershipRevision: revision,
  })
  .strict();
export const ArchiveLabelSchema = z
  .object({ kind: z.literal('label'), key, ...LabelInputSchema.shape, revision })
  .strict();
const provider = z
  .object({ id: providerId, listId: providerId, etag: z.string().max(2048).nullable() })
  .strict();
export const ArchiveTaskSchema = TaskScheduleSchema.safeExtend({
  kind: z.literal('task'),
  key,
  listKey: key,
  parentKey: key.nullable(),
  provider,
  revision,
  labels: z
    .array(z.object({ key, ...LabelInputSchema.shape }).strict())
    .max(20)
    .refine(
      (value) =>
        new Set(value.map((item) => item.name.normalize('NFC').toLowerCase())).size ===
        value.length,
      'use each normalized label name once',
    ),
  priority: PrioritySchema,
  starred: z.boolean(),
  dependencies: z
    .array(z.object({ key, provider }).strict())
    .max(50)
    .refine(
      (value) => new Set(value.map((item) => item.key)).size === value.length,
      'use each dependency reference once',
    ),
  order: z.number().int().nonnegative().safe(),
  snapshot: z
    .object({
      title: names,
      notes,
      completed: z.boolean(),
      completedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .strict()
    .optional(),
}).strict();
export const ArchiveTemplateSchema = z
  .object({
    kind: z.literal('template'),
    key,
    templateKind: z.enum(['list', 'board']),
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema,
    contentRevision: z.number().int().positive(),
    header: TemplateDocumentHeaderSchema,
    appearance: BoardTemplateAppearanceSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.templateKind !== 'board' || value.appearance !== undefined,
    'a board template needs its captured appearance',
  );
export const ArchiveTemplateListSchema = z
  .object({ kind: z.literal('template_list'), key, templateKey: key, value: TemplateListSchema })
  .strict();
export const ArchiveTemplateTaskSchema = z
  .object({ kind: z.literal('template_task'), key, templateKey: key, value: TemplateTaskSchema })
  .strict();
export const ArchiveScheduleSchema = z
  .object({
    kind: z.literal('schedule'),
    key,
    templateKey: key,
    templateKind: z.enum(['list', 'board']),
    boardKey: key,
    timing: TemplateScheduleSchema,
    useRelativeDates: z.boolean(),
    listPrefix: z.string().max(512),
    wasActive: z.boolean(),
    unmatchedReferences: z
      .object({ template: z.boolean(), board: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export const ArchiveHistorySchema = z
  .object({ kind: z.literal('history'), key, event: HistoryEventSchema })
  .strict()
  .refine(
    (value) => value.event.accountId === 'a1',
    'history belongs to the explicitly mapped source account',
  );
export const ArchiveRecordSchema = z.discriminatedUnion('kind', [
  ArchiveBoardSchema,
  ArchiveListSchema,
  ArchiveLabelSchema,
  ArchiveTaskSchema,
  ArchiveTemplateSchema,
  ArchiveTemplateListSchema,
  ArchiveTemplateTaskSchema,
  ArchiveScheduleSchema,
  ArchiveHistorySchema,
]);
export type ArchiveRecord = z.infer<typeof ArchiveRecordSchema>;
export const ArchiveDocumentSchema = z
  .object({ header: ArchiveHeaderSchema, records: z.array(ArchiveRecordSchema).max(100000) })
  .strict();
export type ArchiveDocument = z.infer<typeof ArchiveDocumentSchema>;
export const ArchiveImportModeSchema = z.enum(['restore_metadata', 'copy_task_snapshots']);
export type ArchiveImportMode = z.infer<typeof ArchiveImportModeSchema>;
export interface ArchiveConflict {
  key: string;
  kind: ArchiveRecord['kind'];
  status: 'matched' | 'new' | 'unmatched' | 'conflict';
  message: string;
  destinationId?: string;
  destinationRevision?: number;
}
export const ArchiveRestoreSelectionSchema = z
  .object({
    incomingKeys: z
      .array(key)
      .max(100000)
      .refine((value) => new Set(value).size === value.length),
    skipUnmatched: z.boolean().default(true),
  })
  .strict();
export const ArchiveCaptureChunkSchema = z
  .array(
    z.object({ position: z.number().int().min(0).max(99999), value: ArchiveRecordSchema }).strict(),
  )
  .min(1)
  .max(10);
export const ArchiveExportSelectionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    accountId: z.string().min(1).max(1024),
    boardId: z.string().min(1).max(1024).optional(),
    includeTaskSnapshots: z.boolean(),
    today: CalendarDateSchema,
  })
  .strict();
export type ArchiveExportSelection = z.infer<typeof ArchiveExportSelectionSchema>;
export const ArchiveFieldSchema = z.enum([
  'name',
  'appearance',
  'placement',
  'order',
  'labels',
  'priority',
  'starred',
  'dependencies',
  'time',
  'repeat',
  'definition',
  'history',
]);
export type ArchiveField = z.infer<typeof ArchiveFieldSchema>;
export const ArchiveChoiceChunkSchema = z
  .array(
    z
      .object({
        key: ArchiveKeySchema,
        fields: z
          .array(ArchiveFieldSchema)
          .max(12)
          .refine((value) => new Set(value).size === value.length),
        acceptOmittedReferences: z.boolean().default(false),
      })
      .strict(),
  )
  .min(1)
  .max(10);
export interface ArchiveMatch {
  key: string;
  kind: ArchiveRecord['kind'];
  status: 'matched' | 'new' | 'unmatched' | 'conflict';
  message: string;
  destinationId?: string;
  destinationRevision?: number;
  fields: ArchiveField[];
  blockedFields: Partial<Record<ArchiveField, string>>;
  changes: Partial<Record<ArchiveField, { current: unknown; incoming: unknown }>>;
  defaultIncomingFields: ArchiveField[];
  dependencyIds?: string[];
  missingDependencyCount?: number;
}
export interface ArchiveCaptureSummary {
  validation?: { checkedRecords: number; totalRecords: number; remainingGraphNodes: number } | null;
  paused?: boolean;
  id: string;
  accountId: string;
  mode: ArchiveImportMode;
  header: ArchiveHeader;
  recordCount: number;
  expectedRecords: number;
  bytes: number;
  state: 'staging' | 'preview' | 'restoring' | 'finished' | 'cancelled';
  previewHash: string | null;
  revision: number;
}
export interface ArchiveRestorePreview {
  archive: ArchiveCaptureSummary;
  pendingMatches: number;
  matched: number;
  newRecords: number;
  conflicts: number;
  unmatched: number;
  selected: number;
  restored: number;
  skipped: number;
  preferences: {
    current: { planningZone: string; weekStart: 1 | 7; revision: number };
    incoming: { planningZone: string; weekStart: 1 | 7 };
    selected: boolean;
  };
}
