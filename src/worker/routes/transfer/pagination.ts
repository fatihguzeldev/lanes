import { z } from 'zod';
import { parseValue } from '../../http';
export function transferPage(url: URL): { limit: number; cursor?: string } {
  const value = parseValue(
    z
      .object({
        limit: z.number().int().min(1).max(10).default(10),
        cursor: z.string().min(1).max(48000).optional(),
      })
      .strict(),
    {
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
    },
  );
  return { limit: value.limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
}
export function recordPage(url: URL, key = 'after'): { limit: number; after?: number } {
  const value = parseValue(
    z
      .object({
        limit: z.number().int().min(1).max(10).default(10),
        after: z.number().int().min(0).max(100000).optional(),
      })
      .strict(),
    {
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
      ...(url.searchParams.has(key) ? { after: Number(url.searchParams.get(key)) } : {}),
    },
  );
  return { limit: value.limit, ...(value.after === undefined ? {} : { after: value.after }) };
}
