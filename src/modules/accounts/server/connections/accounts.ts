import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import {
  AccountPreferencesSchema,
  type AccountPreferencesInput,
} from '../../contracts/preferences';
import {
  ConnectionPageOptionsSchema,
  ConnectionSummarySchema,
  type ConnectionPageOptions,
  type ConnectionSummary,
} from '../../contracts/connection';
import type { AccountConfig, AccountDependencies } from '../configuration';
import { OwnerSessions } from '../session/sessions';
import { GOOGLE_TASKS_SCOPE } from '../oauth/google';
import { readConnection, type ConnectionRow } from './record';

type SummaryRow = Pick<
  ConnectionRow,
  | 'id'
  | 'email'
  | 'display_name'
  | 'picture_url'
  | 'state'
  | 'scopes_json'
  | 'grant_expires_at'
  | 'planning_zone'
  | 'week_start'
  | 'revision'
  | 'created_at'
>;
const summaryFields =
  'id,email,display_name,picture_url,state,scopes_json,grant_expires_at,planning_zone,week_start,revision,created_at';
const connectionCursorSchema = z
  .object({
    kind: z.literal('connections'),
    generation: z.string(),
    createdAt: z.number().int(),
    id: z.string().min(1).max(256),
  })
  .strict();
type ConnectionCursor = z.infer<typeof connectionCursorSchema>;
function encodeCursor(value: ConnectionCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
function decodeCursor(value: string | undefined, generation: string): ConnectionCursor | null {
  if (value === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid cursor');
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const cursor = connectionCursorSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (cursor.generation !== generation) throw new Error('wrong owner generation');
    return cursor;
  } catch {
    throw new AppError(
      'validation_failed',
      'the account cursor does not belong to this selection.',
      422,
    );
  }
}

const sheetsImportScope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const sheetsExportScope = 'https://www.googleapis.com/auth/drive.file';

export class AccountConnections {
  constructor(
    private readonly db: D1Database,
    private readonly config: AccountConfig,
    private readonly sessions: OwnerSessions,
    private readonly dependencies: Pick<AccountDependencies, 'commitPreferences'> = {},
  ) {}
  private summary(row: SummaryRow): ConnectionSummary {
    const scopes = z.array(z.string()).parse(JSON.parse(row.scopes_json));
    const expired = row.grant_expires_at !== null && row.grant_expires_at <= this.sessions.clock();
    return ConnectionSummarySchema.parse({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      pictureUrl: row.picture_url,
      state:
        expired && !['disconnecting', 'disconnected'].includes(row.state)
          ? 'reconnect_required'
          : row.state,
      permissions: {
        tasks: scopes.includes(GOOGLE_TASKS_SCOPE),
        sheetsImport: scopes.includes(sheetsImportScope),
        sheetsExport: scopes.includes(sheetsExportScope),
      },
      grantExpiresAt:
        row.grant_expires_at === null ? null : new Date(row.grant_expires_at).toISOString(),
      planningZone: row.planning_zone,
      weekStart: row.week_start,
      revision: row.revision,
    });
  }

  async listConnectionSummaries(
    request: Request,
    input: ConnectionPageOptions = {},
  ): Promise<Page<ConnectionSummary>> {
    const session = await this.sessions.requireSession(request);
    const parsed = ConnectionPageOptionsSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'choose an account page size between 1 and 100.',
        422,
      );
    const options = parsed.data,
      cursor = decodeCursor(options.cursor, session.generation);
    const rows = await this.db
      .prepare(
        `SELECT ${summaryFields} FROM accounts_connections
      ${cursor ? 'WHERE (created_at>? OR (created_at=? AND id>?))' : ''} ORDER BY created_at,id LIMIT ?`,
      )
      .bind(...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), options.limit + 1)
      .all<SummaryRow>();
    const selected = rows.results.slice(0, options.limit),
      last = selected.at(-1);
    return {
      items: selected.map((row) => this.summary(row)),
      nextCursor:
        rows.results.length > options.limit && last
          ? encodeCursor({
              kind: 'connections',
              generation: session.generation,
              createdAt: last.created_at,
              id: last.id,
            })
          : null,
      coverage: { complete: true, lastSyncedAt: null, stale: false },
    };
  }

  async getConnectionSummary(request: Request, accountId: string): Promise<ConnectionSummary> {
    await this.sessions.requireSession(request);
    if (!z.string().min(1).max(256).safeParse(accountId).success)
      throw new AppError('validation_failed', 'choose a connected account.', 422);
    const row = await this.db
      .prepare(`SELECT ${summaryFields} FROM accounts_connections WHERE id=?`)
      .bind(accountId)
      .first<SummaryRow>();
    if (!row) throw new AppError('not_found', 'this connected account was not found.', 404);
    return this.summary(row);
  }

  async updatePreferences(
    request: Request,
    accountId: string,
    input: AccountPreferencesInput,
  ): Promise<ConnectionSummary> {
    this.sessions.cookies.assertOrigin(request, ['PATCH', 'POST']);
    const session = await this.sessions.requireSession(request);
    const parsed = AccountPreferencesSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('validation_failed', 'check the account preferences.', 422);
    const existing = await readConnection(this.db, accountId);
    if (['disconnected', 'disconnecting'].includes(existing.state))
      throw new AppError(
        'reconnect_required',
        'reconnect this account before changing its preferences.',
        409,
      );
    const value = parsed.data;
    const statement = this.db
      .prepare(
        `UPDATE accounts_connections SET planning_zone=?,week_start=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=? AND state NOT IN ('disconnecting','disconnected') AND disconnect_requested_at IS NULL AND EXISTS (SELECT 1 FROM accounts_sessions s JOIN accounts_installation i ON i.id=1 AND i.owner_subject=s.owner_subject AND i.owner_generation=s.owner_generation
        WHERE s.token_hash=? AND s.expires_at>? AND s.owner_generation=? AND i.bootstrap_email=? AND i.token_key_id=?) RETURNING *`,
      )
      .bind(
        value.planningZone ?? existing.planning_zone,
        value.weekStart ?? existing.week_start,
        this.sessions.clock(),
        accountId,
        value.revision,
        session.tokenHash,
        this.sessions.clock(),
        session.generation,
        this.sessions.ownerEmail,
        this.config.tokenKey.id,
      );
    const guard = this.db
      .prepare(
        `INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE NOT EXISTS
      (SELECT 1 FROM accounts_connections WHERE id=? AND revision=? AND state NOT IN ('disconnecting','disconnected') AND disconnect_requested_at IS NULL)
      OR NOT EXISTS(SELECT 1 FROM accounts_sessions s JOIN accounts_installation i ON i.id=1 AND i.owner_subject=s.owner_subject AND i.owner_generation=s.owner_generation
        WHERE s.token_hash=? AND s.expires_at>? AND s.owner_generation=? AND i.bootstrap_email=? AND i.token_key_id=?)`,
      )
      .bind(
        accountId,
        value.revision,
        session.tokenHash,
        this.sessions.clock(),
        session.generation,
        this.sessions.ownerEmail,
        this.config.tokenKey.id,
      );
    let updated: ConnectionRow | null;
    try {
      if (this.dependencies.commitPreferences) {
        const results = await this.dependencies.commitPreferences([guard, statement]);
        updated = (results[1]?.results[0] as unknown as ConnectionRow | undefined) ?? null;
      } else updated = await statement.first<ConnectionRow>();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'conflict',
        'these account preferences changed. refresh them before saving again.',
        409,
      );
    }
    if (!updated)
      throw new AppError(
        'conflict',
        'these account preferences changed. refresh them before saving again.',
        409,
      );
    return this.summary(updated);
  }
}
