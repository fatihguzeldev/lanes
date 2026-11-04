import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import type { Page } from '../../shared/contracts/http';
import {
  HISTORY_RETENTION_MS,
  HistoryEventSchema,
  HistoryQuerySchema,
  type HistoryEvent,
  type HistoryEventInput,
  type HistoryQuery,
} from './contracts';

/** This SQL comes from a composition owner, never from an HTTP request. */
export type BoardListSelection = (
  accountId: string,
  boardId: string,
) => Promise<{ sql: string; bindings: (string | number)[] }>;
export interface HistoryServiceOptions {
  boardListSelection?: BoardListSelection;
  now?: () => number;
}
interface EventRow {
  id: string;
  schema_version: number;
  account_id: string;
  task_id: string | null;
  list_id: string | null;
  kind: string;
  origin: string;
  dedup_key: string;
  task_title: string | null;
  list_title: string | null;
  recorded_at: number;
  provider_at: string | null;
  summary_json: string;
}
const fields =
  'id,schema_version,account_id,task_id,list_id,kind,origin,dedup_key,task_title,list_title,recorded_at,provider_at,summary_json';
const cursorSchema = z
  .object({
    accountId: z.string(),
    boardId: z.string().nullable(),
    listId: z.string().nullable(),
    taskId: z.string().nullable(),
    recordedAt: z.number().int().safe(),
    id: z.string().min(1),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      'validation_failed',
      'check the history fields',
      422,
      false,
      Object.fromEntries(
        result.error.issues.map((issue) => [issue.path.join('.') || 'input', issue.message]),
      ),
    );
  return result.data;
}
function encodeCursor(cursor: Cursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
function decodeCursor(
  value: string | undefined,
  scope: Omit<Cursor, 'recordedAt' | 'id'>,
): Cursor | null {
  if (value === undefined) return null;
  try {
    if (!/^[\w-]+$/.test(value)) throw new Error('invalid cursor');
    const base64 = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    );
    const cursor = cursorSchema.parse(JSON.parse(decoded));
    if (
      cursor.accountId !== scope.accountId ||
      cursor.boardId !== scope.boardId ||
      cursor.listId !== scope.listId ||
      cursor.taskId !== scope.taskId
    )
      throw new Error('wrong scope');
    return cursor;
  } catch {
    throw new AppError(
      'validation_failed',
      'the history cursor does not belong to this selection',
      422,
    );
  }
}
function event(row: EventRow): HistoryEvent {
  return HistoryEventSchema.parse({
    id: row.id,
    schemaVersion: row.schema_version,
    accountId: row.account_id,
    taskId: row.task_id,
    listId: row.list_id,
    kind: row.kind,
    origin: row.origin,
    dedupKey: row.dedup_key,
    taskTitle: row.task_title,
    listTitle: row.list_title,
    recordedAt: new Date(row.recorded_at).toISOString(),
    providerAt: row.provider_at,
    summary: JSON.parse(row.summary_json),
  });
}

export class HistoryService {
  private readonly now: () => number;
  constructor(
    private readonly db: D1Database,
    private readonly options: HistoryServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }
  private prepareEvent(value: HistoryEventInput, now: number): HistoryEvent {
    const parsed = parse(HistoryEventSchema, value);
    if (Date.parse(parsed.recordedAt) > now)
      throw new AppError(
        'validation_failed',
        'a recorded history time cannot be in the future',
        422,
        false,
        { recordedAt: 'preserve the original recorded time' },
      );
    return parsed;
  }
  private write(event: HistoryEvent, now: number): D1PreparedStatement {
    const recordedAt = Date.parse(event.recordedAt);
    return this.db
      .prepare(
        `INSERT INTO history_events
      (id,schema_version,account_id,task_id,list_id,kind,origin,dedup_key,task_title,list_title,recorded_at,provider_at,summary_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?>? AND ?<=?
      ON CONFLICT(account_id,dedup_key) DO NOTHING`,
      )
      .bind(
        event.id,
        event.schemaVersion,
        event.accountId,
        event.taskId,
        event.listId,
        event.kind,
        event.origin,
        event.dedupKey,
        event.taskTitle,
        event.listTitle,
        recordedAt,
        event.providerAt,
        JSON.stringify(event.summary),
        recordedAt,
        now - HISTORY_RETENTION_MS,
        recordedAt,
        now,
      );
  }

  /** Join this statement to the command's local commit; it is not click-time logging. */
  eventWrite(input: HistoryEventInput): D1PreparedStatement {
    const now = this.now();
    return this.write(this.prepareEvent(input, now), now);
  }

  async record(input: HistoryEventInput): Promise<HistoryEvent | null> {
    const now = this.now();
    const value = this.prepareEvent(input, now);
    if (Date.parse(value.recordedAt) <= now - HISTORY_RETENTION_MS) return null;
    try {
      const results = await this.db.batch<EventRow>([
        this.write(value, now),
        this.db
          .prepare(
            `SELECT ${fields} FROM history_events WHERE account_id=? AND dedup_key=? AND recorded_at>? AND recorded_at<=?`,
          )
          .bind(value.accountId, value.dedupKey, now - HISTORY_RETENTION_MS, now),
      ]);
      const row = results[1]?.results[0];
      return row ? event(row) : null;
    } catch {
      throw new AppError(
        'storage_unavailable',
        'the confirmed history event could not be recorded',
        503,
        true,
      );
    }
  }

  async query(accountId: string, input: HistoryQuery = {}): Promise<Page<HistoryEvent>> {
    const options = parse(HistoryQuerySchema, input);
    const scope = {
      accountId,
      boardId: options.boardId ?? null,
      listId: options.listId ?? null,
      taskId: options.taskId ?? null,
    };
    const cursor = decodeCursor(options.cursor, scope);
    const now = this.now();
    const conditions = ['account_id=?', 'recorded_at>?', 'recorded_at<=?'];
    const bindings: (string | number)[] = [accountId, now - HISTORY_RETENTION_MS, now];
    if (options.boardId) {
      if (!this.options.boardListSelection)
        throw new AppError(
          'installation_unavailable',
          'board history selection is not configured',
          503,
        );
      try {
        const selection = await this.options.boardListSelection(accountId, options.boardId);
        conditions.push(`list_id IN (${selection.sql})`);
        bindings.push(...selection.bindings);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          'storage_unavailable',
          'the board history selection could not be read',
          503,
          true,
        );
      }
    }
    if (options.listId) {
      conditions.push('list_id=?');
      bindings.push(options.listId);
    }
    if (options.taskId) {
      conditions.push('task_id=?');
      bindings.push(options.taskId);
    }
    if (cursor) {
      conditions.push('(recorded_at<? OR (recorded_at=? AND id<?))');
      bindings.push(cursor.recordedAt, cursor.recordedAt, cursor.id);
    }
    bindings.push(options.limit + 1);
    try {
      const result = await this.db
        .prepare(
          `SELECT ${fields} FROM history_events WHERE ${conditions.join(' AND ')} ORDER BY recorded_at DESC,id DESC LIMIT ?`,
        )
        .bind(...bindings)
        .all<EventRow>();
      const rows = result.results.slice(0, options.limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map(event),
        nextCursor:
          result.results.length > options.limit && last
            ? encodeCursor({ ...scope, recordedAt: last.recorded_at, id: last.id })
            : null,
        // Complete describes the recorded window, not an unavailable google audit trail.
        coverage: { complete: true, lastSyncedAt: null, stale: false },
      };
    } catch {
      throw new AppError('storage_unavailable', 'history could not be read', 503, true);
    }
  }

  async cleanup(limit = 100): Promise<number> {
    const count = parse(z.number().int().min(1).max(100), limit);
    try {
      const result = await this.db
        .prepare(
          `DELETE FROM history_events WHERE id IN
        (SELECT id FROM history_events WHERE recorded_at<=? ORDER BY recorded_at,id LIMIT ?)`,
        )
        .bind(this.now() - HISTORY_RETENTION_MS, count)
        .run();
      return result.meta.changes;
    } catch {
      throw new AppError(
        'storage_unavailable',
        'expired history cleanup could not finish',
        503,
        true,
      );
    }
  }

  /** Internal account-removal coordinator only; ordinary history browsing cannot erase records. */
  async cleanupAccountSlice(
    accountId: string,
    limit = 100,
  ): Promise<{ done: boolean; deleted: number }> {
    const count = parse(z.number().int().min(1).max(100), limit);
    parse(z.string().min(1).max(1024), accountId);
    const result = await this.db
      .prepare(
        `DELETE FROM history_events WHERE id IN
      (SELECT id FROM history_events WHERE account_id=? ORDER BY recorded_at,id LIMIT ?)`,
      )
      .bind(accountId, count)
      .run();
    const remaining = await this.db
      .prepare('SELECT 1 FROM history_events WHERE account_id=? LIMIT 1')
      .bind(accountId)
      .first();
    return { done: remaining === null, deleted: result.meta.changes };
  }
}
