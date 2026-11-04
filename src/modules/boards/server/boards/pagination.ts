import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
export const cursorSchema = z
  .object({
    kind: z.enum(['boards', 'lists']),
    accountId: z.string(),
    boardId: z.string().optional(),
    position: z.number().int(),
    id: z.string().min(1),
  })
  .strict();

export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeCursor(
  value: string | undefined,
  expected: { kind: Cursor['kind']; accountId: string; boardId?: string },
): Cursor | null {
  if (value === undefined) return null;
  try {
    if (!/^[\w-]+$/.test(value)) throw new Error('invalid cursor');
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    );
    const cursor = cursorSchema.parse(JSON.parse(text));
    if (
      cursor.kind !== expected.kind ||
      cursor.accountId !== expected.accountId ||
      cursor.boardId !== expected.boardId
    )
      throw new Error('wrong cursor scope');
    return cursor;
  } catch {
    throw new AppError(
      'validation_failed',
      'the page cursor does not belong to this selection',
      422,
    );
  }
}
