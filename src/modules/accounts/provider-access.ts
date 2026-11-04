import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../shared/contracts/errors';
import { decryptToken, encryptToken, randomToken, validateTokenKey } from './crypto';
import {
  GOOGLE_TASKS_SCOPE,
  GoogleOAuthError,
  ensureGoogleScopes,
  refreshGoogleGrant,
  revokeGoogleGrant,
} from './google';
import type { GoogleFetch, GoogleGrant } from './google';
import { accountGrantContext } from './server';
import type { AccountConfig } from './server';
import type { ConnectionState } from './contracts';

export interface ProviderAccessOptions {
  now?: () => number;
  /** The composition owner supplies its counted transport, including token and revocation requests. */
  fetch?: GoogleFetch;
  refresh?: typeof refreshGoogleGrant;
  revoke?: typeof revokeGoogleGrant;
  /** True while issued provider work is unsettled. Retire queued work and record expired issued work as uncertain before returning false. */
  pendingProviderWork?: (accountId: string) => Promise<boolean>;
}
export interface AccessTokenResult {
  accessToken: string;
  tokenRevision: number;
}
export interface AccessTokenOptions {
  requiredScopes?: readonly string[];
  forceRefresh?: boolean;
  /** Required with forceRefresh: a rejected older version must not refresh a newer grant again. */
  observedTokenRevision?: number;
}
export interface DisconnectResult {
  state: 'disconnecting' | 'disconnected';
  pending: boolean;
  remoteRevocation: 'pending' | 'succeeded' | 'failed' | 'not_needed';
}
interface Installation {
  owner_subject: string;
  bootstrap_email: string;
  owner_generation: string;
  token_key_id: string;
}
interface Connection {
  id: string;
  state: ConnectionState;
  grant_ciphertext: string | null;
  scopes_json: string;
  access_expires_at: number | null;
  grant_expires_at: number | null;
  token_revision: number;
  refresh_claim: string | null;
  refresh_claim_until: number | null;
  work_claim: string | null;
  work_claim_until: number | null;
}
const columns =
  'id,state,grant_ciphertext,scopes_json,access_expires_at,grant_expires_at,token_revision,refresh_claim,refresh_claim_until,work_claim,work_claim_until';
const activeStates = "('connecting','connected','temporarily_unavailable')";
const leaseLifetime = 30_000;
const tokenBuffer = 60_000;
const tokenText = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[^\x00-\x20\x7f]+$/);
const scopesSchema = z.array(z.string().min(1).max(2048)).max(256);
const grantSchema = z
  .object({
    accessToken: tokenText,
    refreshToken: tokenText.nullable(),
    expiresAt: z.number().int().safe(),
    scopes: scopesSchema,
    tokenType: z.literal('Bearer'),
    refreshTokenExpiresAt: z.number().int().safe().optional(),
  })
  .strict();
function parseGrant(input: unknown): GoogleGrant {
  const { refreshTokenExpiresAt, ...value } = grantSchema.parse(input);
  return { ...value, ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }) };
}
const optionsSchema = z
  .object({
    requiredScopes: scopesSchema.optional(),
    forceRefresh: z.boolean().optional(),
    observedTokenRevision: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .refine((value) => !value.forceRefresh || value.observedTokenRevision !== undefined);
const accountIdSchema = z.string().min(1).max(256);
function unavailable(): AppError {
  return new AppError(
    'installation_unavailable',
    'the owner or token encryption configuration does not match this installation. restore it before accessing google.',
    503,
  );
}
function busy(): AppError {
  return new AppError(
    'provider_unavailable',
    'this google grant is being refreshed or settled. try again shortly.',
    503,
    true,
  );
}
function reconnect(): AppError {
  return new AppError(
    'reconnect_required',
    'reconnect this google account to resume provider access. retained workspace data is unchanged.',
    409,
  );
}
function pending(): DisconnectResult {
  return { state: 'disconnecting', pending: true, remoteRevocation: 'pending' };
}
function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort(),
    right = [...new Set(b)].sort();
  return left.length === right.length && left.every((scope, i) => scope === right[i]);
}
function safeProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof GoogleOAuthError) {
    switch (error.code) {
      case 'configuration_invalid':
        return unavailable();
      case 'reconnect_required':
        return reconnect();
      case 'permission_required':
        return new AppError('permission_required', error.message, 403);
      case 'provider_rate_limited':
        return new AppError('provider_rate_limited', error.message, 429, error.retryable);
      default:
        return new AppError(
          'provider_unavailable',
          'google could not refresh this authorization. the existing grant is retained.',
          503,
          error.retryable,
        );
    }
  }
  return new AppError(
    'provider_unavailable',
    'google could not refresh this authorization. the existing grant is retained.',
    503,
    true,
  );
}

/** Internal server capability. Callers authorize the owner session and fence provider dispatch separately. Tokens never become browser contracts. */
export class ProviderAccess {
  private readonly now: () => number;
  private readonly ownerEmail: string;
  constructor(
    private readonly db: D1Database,
    private readonly config: AccountConfig,
    private readonly dependencies: ProviderAccessOptions = {},
  ) {
    try {
      validateTokenKey(config.tokenKey);
      this.ownerEmail = z.email().parse(config.ownerEmail).trim().toLowerCase();
      this.now = dependencies.now ?? Date.now;
    } catch {
      throw unavailable();
    }
  }
  private async installation(): Promise<Installation> {
    const row = await this.db
      .prepare(
        'SELECT owner_subject,bootstrap_email,owner_generation,token_key_id FROM accounts_installation WHERE id=1',
      )
      .first<Installation>();
    if (
      !row?.owner_subject ||
      !row.owner_generation ||
      row.bootstrap_email !== this.ownerEmail ||
      row.token_key_id !== this.config.tokenKey.id
    )
      throw unavailable();
    return row;
  }
  private async checkInstallation(expected: Installation): Promise<void> {
    const current = await this.installation();
    if (
      current.owner_generation !== expected.owner_generation ||
      current.owner_subject !== expected.owner_subject
    )
      throw unavailable();
  }
  private fence(installation: Installation): { sql: string; values: string[] } {
    return {
      sql: 'EXISTS (SELECT 1 FROM accounts_installation WHERE id=1 AND owner_subject=? AND owner_generation=? AND bootstrap_email=? AND token_key_id=?)',
      values: [
        installation.owner_subject,
        installation.owner_generation,
        this.ownerEmail,
        this.config.tokenKey.id,
      ],
    };
  }
  private async connection(accountId: string): Promise<Connection> {
    if (!accountIdSchema.safeParse(accountId).success)
      throw new AppError('validation_failed', 'choose a connected account.', 422);
    const row = await this.db
      .prepare('SELECT ' + columns + ' FROM accounts_connections WHERE id=?')
      .bind(accountId)
      .first<Connection>();
    if (!row) throw new AppError('not_found', 'this connected account was not found.', 404);
    return row;
  }
  private assertActive(row: Connection): void {
    if (row.state === 'disconnecting')
      throw new AppError(
        'conflict',
        'this account is disconnecting. issued provider work is settling.',
        409,
      );
    if (row.state === 'disconnected' || row.state === 'reconnect_required') throw reconnect();
  }
  private async grant(row: Connection): Promise<GoogleGrant> {
    if (!row.grant_ciphertext) throw reconnect();
    try {
      const value = parseGrant(
        JSON.parse(
          await decryptToken(
            row.grant_ciphertext,
            this.config.tokenKey,
            accountGrantContext(row.id),
          ),
        ),
      );
      const scopes = scopesSchema.parse(JSON.parse(row.scopes_json));
      if (row.access_expires_at !== value.expiresAt || !sameScopes(scopes, value.scopes))
        throw unavailable();
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
  private scopes(grant: GoogleGrant, required: readonly string[]): void {
    try {
      ensureGoogleScopes(grant.scopes, required);
    } catch (error) {
      throw safeProviderError(error);
    }
  }
  private async assertDeadline(
    row: Connection,
    installation: Installation,
    grant?: GoogleGrant,
  ): Promise<void> {
    const now = this.now();
    if (
      row.grant_expires_at === null ||
      row.grant_expires_at <= now ||
      (grant?.refreshTokenExpiresAt !== undefined && grant.refreshTokenExpiresAt <= now)
    ) {
      const guard = this.fence(installation);
      await this.db
        .prepare(
          `UPDATE accounts_connections SET state='reconnect_required',token_revision=token_revision+1,revision=revision+1,updated_at=?
        WHERE id=? AND token_revision=? AND state IN ${activeStates} AND ${guard.sql}`,
        )
        .bind(now, row.id, row.token_revision, ...guard.values)
        .run();
      throw reconnect();
    }
  }
  private async racedToken(
    accountId: string,
    previousRevision: number,
    required: readonly string[],
    installation: Installation,
  ): Promise<AccessTokenResult> {
    await this.checkInstallation(installation);
    const row = await this.connection(accountId);
    this.assertActive(row);
    const value = await this.grant(row);
    await this.assertDeadline(row, installation, value);
    this.scopes(value, required);
    if (row.token_revision === previousRevision || value.expiresAt <= this.now() + tokenBuffer)
      throw busy();
    return { accessToken: value.accessToken, tokenRevision: row.token_revision };
  }

  async getAccessToken(
    accountId: string,
    input: AccessTokenOptions = {},
  ): Promise<AccessTokenResult> {
    const parsed = optionsSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'a forced token refresh needs the token revision that google rejected.',
        422,
      );
    const options = parsed.data,
      required = options.requiredScopes ?? [GOOGLE_TASKS_SCOPE];
    const installation = await this.installation(),
      guard = this.fence(installation);
    const row = await this.connection(accountId);
    this.assertActive(row);
    const value = await this.grant(row);
    await this.assertDeadline(row, installation, value);
    this.scopes(value, required);
    const forced =
      options.forceRefresh === true && options.observedTokenRevision === row.token_revision;
    if (!forced && value.expiresAt > this.now() + tokenBuffer) {
      const checked = await this.db
        .prepare(
          `SELECT token_revision FROM accounts_connections WHERE id=? AND token_revision=? AND state IN ${activeStates}
        AND grant_expires_at>? AND ${guard.sql}`,
        )
        .bind(accountId, row.token_revision, this.now(), ...guard.values)
        .first<{ token_revision: number }>();
      if (!checked) return this.racedToken(accountId, row.token_revision, required, installation);
      return { accessToken: value.accessToken, tokenRevision: row.token_revision };
    }
    if (!value.refreshToken) {
      await this.db
        .prepare(
          `UPDATE accounts_connections SET state='reconnect_required',token_revision=token_revision+1,revision=revision+1,updated_at=?
        WHERE id=? AND token_revision=? AND state IN ${activeStates} AND ${guard.sql}`,
        )
        .bind(this.now(), accountId, row.token_revision, ...guard.values)
        .run();
      throw reconnect();
    }
    const claim = randomToken(),
      now = this.now();
    const claimed = await this.db
      .prepare(
        `UPDATE accounts_connections SET refresh_claim=?,refresh_claim_until=? WHERE id=? AND token_revision=?
      AND state IN ${activeStates} AND grant_expires_at>? AND (refresh_claim IS NULL OR refresh_claim_until<=?) AND ${guard.sql} RETURNING id`,
      )
      .bind(claim, now + leaseLifetime, accountId, row.token_revision, now, now, ...guard.values)
      .first<{ id: string }>();
    if (!claimed) return this.racedToken(accountId, row.token_revision, required, installation);
    try {
      let refreshed: GoogleGrant;
      try {
        const response = await (this.dependencies.refresh ?? refreshGoogleGrant)(
          this.config.google,
          {
            refreshToken: value.refreshToken,
            scopes: value.scopes,
            ...(value.refreshTokenExpiresAt === undefined
              ? {}
              : { refreshTokenExpiresAt: value.refreshTokenExpiresAt }),
          },
          { now: this.now, ...(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {}) },
        );
        const { idToken: _identity, ...persistent } = response;
        refreshed = parseGrant({
          ...persistent,
          refreshToken: response.refreshToken ?? value.refreshToken,
        });
        if (refreshed.expiresAt <= this.now() + tokenBuffer)
          throw new GoogleOAuthError('provider_response_invalid', true);
      } catch (error) {
        await this.checkInstallation(installation);
        const latest = await this.connection(accountId);
        if (latest.token_revision !== row.token_revision || latest.refresh_claim !== claim)
          return this.racedToken(accountId, row.token_revision, required, installation);
        if (error instanceof GoogleOAuthError && error.code === 'reconnect_required') {
          await this.db
            .prepare(
              `UPDATE accounts_connections SET state='reconnect_required',token_revision=token_revision+1,revision=revision+1,updated_at=?
            WHERE id=? AND token_revision=? AND refresh_claim=? AND refresh_claim_until>? AND state IN ${activeStates} AND ${guard.sql}`,
            )
            .bind(this.now(), accountId, row.token_revision, claim, this.now(), ...guard.values)
            .run();
        }
        throw safeProviderError(error);
      }
      await this.checkInstallation(installation);
      await this.assertDeadline(row, installation, refreshed);
      const ciphertext = await encryptToken(
        JSON.stringify(refreshed),
        this.config.tokenKey,
        accountGrantContext(accountId),
      );
      const deadline = Math.min(
        row.grant_expires_at ?? 0,
        value.refreshTokenExpiresAt ?? Infinity,
        refreshed.refreshTokenExpiresAt ?? Infinity,
      );
      const saved = await this.db
        .prepare(
          `UPDATE accounts_connections SET grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=?,
        token_revision=token_revision+1,revision=revision+1,refresh_claim=NULL,refresh_claim_until=NULL,updated_at=?
        WHERE id=? AND token_revision=? AND refresh_claim=? AND refresh_claim_until>? AND state IN ${activeStates} AND grant_expires_at>? AND ${guard.sql}
        RETURNING token_revision`,
        )
        .bind(
          ciphertext,
          JSON.stringify(refreshed.scopes),
          refreshed.expiresAt,
          deadline,
          this.now(),
          accountId,
          row.token_revision,
          claim,
          this.now(),
          this.now(),
          ...guard.values,
        )
        .first<{ token_revision: number }>();
      if (!saved) return this.racedToken(accountId, row.token_revision, required, installation);
      this.scopes(refreshed, required);
      return { accessToken: refreshed.accessToken, tokenRevision: saved.token_revision };
    } finally {
      await this.db
        .prepare(
          'UPDATE accounts_connections SET refresh_claim=NULL,refresh_claim_until=NULL WHERE id=? AND refresh_claim=?',
        )
        .bind(accountId, claim)
        .run();
    }
  }

  /** Composition calls this only after board mapping and the initial task inventory have completed. */
  async markWorkspaceInitialized(accountId: string): Promise<boolean> {
    const installation = await this.installation(),
      guard = this.fence(installation);
    await this.connection(accountId);
    const result = await this.db
      .prepare(
        `UPDATE accounts_connections SET state='connected',revision=revision+1,updated_at=?
      WHERE id=? AND state='connecting' AND disconnect_requested_at IS NULL AND grant_ciphertext IS NOT NULL AND grant_expires_at>? AND ${guard.sql}`,
      )
      .bind(this.now(), accountId, this.now(), ...guard.values)
      .run();
    return result.meta.changes > 0;
  }

  async requestDisconnect(accountId: string): Promise<DisconnectResult> {
    const installation = await this.installation(),
      guard = this.fence(installation);
    const row = await this.connection(accountId);
    if (row.state === 'disconnected')
      return { state: 'disconnected', pending: false, remoteRevocation: 'not_needed' };
    if (row.state === 'disconnecting') return pending();
    const now = this.now();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE accounts_connections SET state='disconnecting',disconnect_requested_at=?,token_revision=token_revision+1,revision=revision+1,updated_at=?
        WHERE id=? AND token_revision=? AND state NOT IN ('disconnecting','disconnected') AND ${guard.sql}`,
        )
        .bind(now, now, accountId, row.token_revision, ...guard.values),
      this.db
        .prepare(
          `DELETE FROM accounts_oauth_states WHERE (account_id=? OR (account_id IS NULL AND purpose='link'))
        AND EXISTS (SELECT 1 FROM accounts_connections WHERE id=? AND state='disconnecting' AND disconnect_requested_at=?) AND ${guard.sql}`,
        )
        .bind(accountId, accountId, now, ...guard.values),
    ]);
    if (!result[0]?.meta.changes) {
      const current = await this.connection(accountId);
      if (current.state !== 'disconnecting')
        throw new AppError(
          'conflict',
          'this account changed before disconnect started. refresh and try again.',
          409,
        );
    }
    return pending();
  }

  async finalizeDisconnect(accountId: string): Promise<DisconnectResult> {
    const installation = await this.installation(),
      guard = this.fence(installation);
    let row = await this.connection(accountId);
    if (row.state === 'disconnected')
      return { state: 'disconnected', pending: false, remoteRevocation: 'not_needed' };
    if (row.state !== 'disconnecting')
      throw new AppError('conflict', 'request disconnect before settling this account.', 409);
    try {
      if (await this.dependencies.pendingProviderWork?.(accountId)) return pending();
    } catch {
      throw new AppError(
        'provider_unavailable',
        'provider work could not be settled. disconnect is still pending.',
        503,
        true,
      );
    }
    row = await this.connection(accountId);
    if (row.state === 'disconnected')
      return { state: 'disconnected', pending: false, remoteRevocation: 'not_needed' };
    if (row.state !== 'disconnecting')
      throw new AppError('conflict', 'this account changed while disconnect was settling.', 409);
    if (row.refresh_claim && (row.refresh_claim_until ?? Infinity) > this.now()) return pending();
    const claim = randomToken(),
      now = this.now();
    const claimed = await this.db
      .prepare(
        `UPDATE accounts_connections SET work_claim=?,work_claim_until=? WHERE id=? AND token_revision=? AND state='disconnecting'
      AND (refresh_claim IS NULL OR refresh_claim_until<=?) AND (work_claim IS NULL OR work_claim_until<=?) AND ${guard.sql} RETURNING id`,
      )
      .bind(claim, now + leaseLifetime, accountId, row.token_revision, now, now, ...guard.values)
      .first<{ id: string }>();
    if (!claimed) return pending();
    try {
      let remoteRevocation: DisconnectResult['remoteRevocation'] = 'not_needed';
      if (row.grant_ciphertext) {
        const value = await this.grant(row);
        try {
          await (this.dependencies.revoke ?? revokeGoogleGrant)(
            value.refreshToken ?? value.accessToken,
            {
              now: this.now,
              ...(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {}),
            },
          );
          remoteRevocation = 'succeeded';
        } catch {
          remoteRevocation = 'failed';
        }
      }
      const result = await this.db
        .prepare(
          `UPDATE accounts_connections SET state='disconnected',grant_ciphertext=NULL,scopes_json='[]',access_expires_at=NULL,grant_expires_at=NULL,
        token_revision=token_revision+1,revision=revision+1,refresh_claim=NULL,refresh_claim_until=NULL,work_claim=NULL,work_claim_until=NULL,updated_at=?
        WHERE id=? AND token_revision=? AND state='disconnecting' AND work_claim=? AND work_claim_until>? AND ${guard.sql}`,
        )
        .bind(this.now(), accountId, row.token_revision, claim, this.now(), ...guard.values)
        .run();
      if (!result.meta.changes) return pending();
      return { state: 'disconnected', pending: false, remoteRevocation };
    } finally {
      await this.db
        .prepare(
          'UPDATE accounts_connections SET work_claim=NULL,work_claim_until=NULL WHERE id=? AND work_claim=?',
        )
        .bind(accountId, claim)
        .run();
    }
  }
}
