import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import {
  GoogleTaskSchema,
  type GoogleProviderPage,
  type GoogleTaskDTO,
} from '../provider/google-tasks';

export const providerPageSize = 25;
const maxPageBytes = 1_500_000;
const pageSchema = z
  .object({
    version: z.literal(1),
    items: z
      .array(GoogleTaskSchema.omit({ kind: true, selfLink: true, webViewLink: true, links: true }))
      .max(providerPageSize),
    nextPageToken: z.string().min(1).max(16_384).nullable(),
  })
  .strict()
  .refine((page) => new Set(page.items.map((task) => task.id)).size === page.items.length);
export type CapturedTaskPage = z.infer<typeof pageSchema>;

export function captureTaskPage(page: GoogleProviderPage<GoogleTaskDTO>): CapturedTaskPage {
  const parsed = pageSchema.safeParse({
    version: 1,
    items: page.items,
    nextPageToken: page.nextPageToken,
  });
  if (
    !parsed.success ||
    new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > maxPageBytes
  )
    throw new AppError(
      'provider_unavailable',
      'google returned a task page that could not be retained safely',
      503,
      true,
    );
  return parsed.data;
}

export function retainedTaskPage(
  work: { page_json: string | null; page_offset: number; page_projection_revision: number | null },
  projectionRevision: number,
): { page: CapturedTaskPage; offset: number } | null {
  if (
    work.page_json === null ||
    work.page_projection_revision !== projectionRevision ||
    !Number.isInteger(work.page_offset) ||
    work.page_offset < 0 ||
    new TextEncoder().encode(work.page_json).byteLength > maxPageBytes
  )
    return null;
  try {
    const parsed = pageSchema.safeParse(JSON.parse(work.page_json));
    return parsed.success && work.page_offset < parsed.data.items.length
      ? { page: parsed.data, offset: work.page_offset }
      : null;
  } catch {
    return null;
  }
}
