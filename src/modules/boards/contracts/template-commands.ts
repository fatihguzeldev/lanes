import { z } from 'zod';

import { ResourceIdSchema } from '../../../shared/contracts/identity';
import {
  CreateListTemplateSchema,
  SnapshotOptionsSchema,
  TemplateMetadataPatchSchema,
} from '../../tasks/contracts/template';
import {
  CreateBoardTemplateSchema,
  CreateTemplateScheduleSchema,
  TemplateSchedulePatchSchema,
} from './template';
const id = ResourceIdSchema.max(1024),
  revision = z.number().int().nonnegative().safe();
const listSource = SnapshotOptionsSchema.extend({ listId: id, listRevision: revision }).strict();
const boardSource = SnapshotOptionsSchema.extend({ boardId: id, boardRevision: revision }).strict();
export const ListTemplateSourceSchema = listSource;
export const BoardTemplateSourceSchema = boardSource;
export const TemplateCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('template.list.create'), input: CreateListTemplateSchema }).strict(),
  z.object({ kind: z.literal('template.board.create'), input: CreateBoardTemplateSchema }).strict(),
  z
    .object({
      kind: z.literal('template.list.update'),
      templateId: id,
      revision,
      input: TemplateMetadataPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('template.board.update'),
      templateId: id,
      revision,
      input: TemplateMetadataPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('template.list.replace'),
      templateId: id,
      revision,
      input: listSource,
    })
    .strict(),
  z
    .object({
      kind: z.literal('template.board.replace'),
      templateId: id,
      revision,
      input: boardSource,
    })
    .strict(),
  z.object({ kind: z.literal('template.list.delete'), templateId: id, revision }).strict(),
  z.object({ kind: z.literal('template.board.delete'), templateId: id, revision }).strict(),
  z.object({ kind: z.literal('template.list.gallery'), galleryId: id }).strict(),
  z.object({ kind: z.literal('template.board.gallery'), galleryId: id }).strict(),
  z
    .object({ kind: z.literal('template.schedule.create'), input: CreateTemplateScheduleSchema })
    .strict(),
  z
    .object({
      kind: z.literal('template.schedule.update'),
      scheduleId: id,
      revision,
      input: TemplateSchedulePatchSchema,
    })
    .strict(),
  z.object({ kind: z.literal('template.schedule.pause'), scheduleId: id, revision }).strict(),
  z
    .object({
      kind: z.literal('template.schedule.resume'),
      scheduleId: id,
      revision,
      catchUp: z.enum(['latest', 'skip']),
    })
    .strict(),
  z.object({ kind: z.literal('template.schedule.delete'), scheduleId: id, revision }).strict(),
]);
export type TemplateCommand = z.infer<typeof TemplateCommandSchema>;
