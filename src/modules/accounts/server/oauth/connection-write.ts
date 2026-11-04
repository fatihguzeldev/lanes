import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { assertAccountLinkFresh } from '../lifecycle/link-fence';
import { assertAccountNotRemoving } from '../lifecycle/write-guards';
import { TokenCryptoError, decryptToken, encryptToken } from '../credentials/crypto';
import { accountGrantContext } from '../credentials/grant-context';
import type { AccountConfig } from '../configuration';
import type { ConnectionRow } from '../connections/record';
import type { OAuthStateRow, OAuthWriteAuthorization } from './state';
import {
  GOOGLE_TASKS_SCOPE,
  ensureGoogleScopes,
  type GoogleCodeGrant,
  type GoogleGrant,
  type GoogleIdentity,
} from './google';
import { installationError } from '../errors';

const sessionLifetime = 7 * 86_400_000;
const sheetsImportScope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const sheetsExportScope = 'https://www.googleapis.com/auth/drive.file';

const storedGrantSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().nullable(),
    expiresAt: z.number().int(),
    scopes: z.array(z.string()),
    tokenType: z.literal('Bearer'),
    refreshTokenExpiresAt: z.number().int().optional(),
  })
  .strict();

export class ConnectionGrantWriter {
  constructor(
    private readonly db: D1Database,
    private readonly config: AccountConfig,
    private readonly clock: () => number,
  ) {}
  async prepareConnectionWrite(
    state: OAuthStateRow,
    identity: GoogleIdentity,
    grant: GoogleCodeGrant,
    target: ConnectionRow | null,
    auth: OAuthWriteAuthorization,
  ): Promise<{ id: string; statement: D1PreparedStatement }> {
    ensureGoogleScopes(grant.scopes, [
      GOOGLE_TASKS_SCOPE,
      ...(state.purpose === 'sheets_import'
        ? [sheetsImportScope]
        : state.purpose === 'sheets_export'
          ? [sheetsExportScope]
          : []),
    ]);
    const existing =
      target ??
      (await this.db
        .prepare('SELECT * FROM accounts_connections WHERE google_subject=?')
        .bind(identity.subject)
        .first<ConnectionRow>());
    if (existing) await assertAccountNotRemoving(this.db, existing.id);
    const relink = await assertAccountLinkFresh(this.db, identity.subject, state.created_at);
    if (
      existing?.state === 'disconnecting' ||
      (existing?.disconnect_requested_at && state.created_at <= existing.disconnect_requested_at) ||
      (existing?.state === 'disconnected' && state.created_at <= existing.updated_at)
    )
      throw new AppError(
        'conflict',
        'this account was disconnected after authorization began. start a new connection.',
        409,
      );
    const now = this.clock();
    const stored = await this.usablePreviousGrant(existing, now);
    const refreshToken = grant.refreshToken ?? stored?.refreshToken;
    if (!refreshToken)
      throw new AppError(
        'reconnect_required',
        'google did not provide background access. reconnect and grant offline task access.',
        409,
      );
    const grantExpiry = grant.refreshToken
      ? Math.min(state.created_at + sessionLifetime, grant.refreshTokenExpiresAt ?? Infinity)
      : (existing?.grant_expires_at ?? state.created_at + sessionLifetime);
    if (grantExpiry <= now)
      throw new AppError(
        'reconnect_required',
        'this google authorization has expired. reconnect the account.',
        409,
      );
    const id = existing?.id ?? crypto.randomUUID();
    const persistent: GoogleGrant = {
      accessToken: grant.accessToken,
      refreshToken,
      expiresAt: grant.expiresAt,
      scopes: grant.scopes,
      tokenType: 'Bearer',
      ...(grant.refreshTokenExpiresAt === undefined
        ? {}
        : { refreshTokenExpiresAt: grant.refreshTokenExpiresAt }),
    };
    const ciphertext = await encryptToken(
      JSON.stringify(persistent),
      this.config.tokenKey,
      accountGrantContext(id),
    );
    const nextState =
      state.purpose.startsWith('sheets_') && existing?.state === 'connected'
        ? 'connected'
        : 'connecting';
    let statement: D1PreparedStatement;
    if (existing) {
      statement = this.db
        .prepare(
          `UPDATE accounts_connections SET email=?,display_name=?,picture_url=?,state=?,grant_ciphertext=?,scopes_json=?,
        access_expires_at=?,grant_expires_at=?,token_revision=token_revision+1,revision=revision+1,refresh_claim=NULL,refresh_claim_until=NULL,
        disconnect_requested_at=NULL,updated_at=? WHERE id=? AND token_revision=? AND state=? AND removal_requested_at IS NULL AND ${auth.sql} AND ${relink.sql} RETURNING *`,
        )
        .bind(
          identity.email,
          identity.name ?? identity.email,
          identity.picture ?? null,
          nextState,
          ciphertext,
          JSON.stringify(grant.scopes),
          grant.expiresAt,
          grantExpiry,
          now,
          id,
          existing.token_revision,
          existing.state,
          ...auth.values,
          ...relink.values,
        );
    } else {
      statement = this.db
        .prepare(
          `INSERT INTO accounts_connections
        (id,google_subject,email,display_name,picture_url,state,grant_ciphertext,scopes_json,access_expires_at,grant_expires_at,planning_zone,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${auth.sql} AND ${relink.sql} ON CONFLICT(google_subject) DO NOTHING RETURNING *`,
        )
        .bind(
          id,
          identity.subject,
          identity.email,
          identity.name ?? identity.email,
          identity.picture ?? null,
          nextState,
          ciphertext,
          JSON.stringify(grant.scopes),
          grant.expiresAt,
          grantExpiry,
          state.planning_zone,
          now,
          now,
          ...auth.values,
          ...relink.values,
        );
    }
    return { id, statement };
  }

  private async usablePreviousGrant(
    connection: ConnectionRow | null,
    now: number,
  ): Promise<GoogleGrant | null> {
    if (
      !connection?.grant_ciphertext ||
      !['connecting', 'connected', 'temporarily_unavailable'].includes(connection.state) ||
      (connection.grant_expires_at !== null && connection.grant_expires_at <= now)
    )
      return null;
    try {
      const parsed = storedGrantSchema.parse(
        JSON.parse(
          await decryptToken(
            connection.grant_ciphertext,
            this.config.tokenKey,
            accountGrantContext(connection.id),
          ),
        ),
      );
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        scopes: parsed.scopes,
        tokenType: parsed.tokenType,
        ...(parsed.refreshTokenExpiresAt === undefined
          ? {}
          : { refreshTokenExpiresAt: parsed.refreshTokenExpiresAt }),
      };
    } catch (error) {
      if (error instanceof TokenCryptoError) throw error;
      throw installationError();
    }
  }
}
