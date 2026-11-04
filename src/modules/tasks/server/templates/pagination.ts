import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { id } from './validation';
export function cursor(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function readCursor(
  value: string,
  scope: {
    accountId: string;
    snapshotId?: string;
    kind: string;
  },
): {
  position: number;
  id?: string | undefined;
  updatedAt?: number | undefined;
} {
  try {
    const base = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = z
      .object({
        accountId: id,
        snapshotId: id.optional(),
        kind: z.string(),
        position: z.number().int(),
        id: id.optional(),
        updatedAt: z.number().int().optional(),
      })
      .strict()
      .parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(atob(base), (value) => value.charCodeAt(0)),
          ),
        ),
      );
    if (
      parsed.accountId !== scope.accountId ||
      parsed.snapshotId !== scope.snapshotId ||
      parsed.kind !== scope.kind
    )
      throw new Error();
    return parsed;
  } catch {
    throw new AppError(
      'validation_failed',
      'the template cursor belongs to another selection',
      422,
    );
  }
}
