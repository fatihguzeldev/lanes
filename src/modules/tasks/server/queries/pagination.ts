import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
export const readIdsSchema = z.array(ResourceIdSchema.max(1_024)).max(100);

export const cursorSchema = z
  .object({
    kind: z.enum(['tasks-v1', 'labels-v1', 'export-v1', 'dependants-v1']),
    accountId: ResourceIdSchema.max(1_024),
    fingerprint: z.string().length(64),
    id: ResourceIdSchema.max(1_024),
    revision: z.number().int().nonnegative(),
    rootId: ResourceIdSchema.max(1_024).optional(),
    rootRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type Cursor = z.infer<typeof cursorSchema>;

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the task query fields',
      422,
      false,
      Object.fromEntries(
        result.error.issues
          .slice(0, 20)
          .map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return result.data;
}

export function encodeCursor(cursor: Cursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeCursor(
  value: string | undefined,
  kind: Cursor['kind'],
  accountId: string,
  fingerprint: string,
): Cursor | null {
  if (value === undefined) return null;
  try {
    if (!/^[\w-]+$/.test(value)) throw new Error();
    const base64 = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    );
    const cursor = cursorSchema.parse(JSON.parse(text));
    if (
      cursor.kind !== kind ||
      cursor.accountId !== accountId ||
      cursor.fingerprint !== fingerprint ||
      ((kind === 'tasks-v1' || kind === 'export-v1') &&
        (cursor.rootRevision === undefined || cursor.rootId === undefined))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new AppError(
      'validation_failed',
      'the page cursor does not belong to this selection',
      422,
    );
  }
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export async function fingerprint(value: unknown): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical(value))),
    ),
  );
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
