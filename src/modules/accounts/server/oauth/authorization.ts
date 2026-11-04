import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { StartOAuthSchema, type StartOAuthInput } from '../../contracts/authorization';
import { assertAccountNotRemoving } from '../lifecycle/write-guards';
import {
  signHmac,
  createPkce,
  decryptToken,
  encryptToken,
  hashToken,
  randomToken,
} from '../credentials/crypto';
import type { AccountConfig, AccountDependencies } from '../configuration';
import { readConnection, type ConnectionRow } from '../connections/record';
import type { InstallationRow } from '../session/installation';
import type { OwnerSession } from '../session/sessions';
import { OwnerSessions } from '../session/sessions';
import { convertError, invalidState, normalizeEmail } from '../errors';
import {
  GOOGLE_TASKS_SCOPE,
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  verifyGoogleIdToken,
  type GoogleCodeGrant,
  type GoogleIdentity,
} from './google';
import { ConnectionGrantWriter } from './connection-write';
import type {
  OAuthStartResult,
  OAuthFinishResult,
  OAuthStateRow,
  OAuthWriteAuthorization,
} from './state';

const stateLifetime = 10 * 60_000;
const addressSchema = z.union([z.ipv4(), z.ipv6()]);
const sheetsImportScope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const sheetsExportScope = 'https://www.googleapis.com/auth/drive.file';
const verifierSchema = z
  .object({
    verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    generation: z.string().min(1),
    connectOwner: z.boolean().default(false),
  })
  .strict();

export class GoogleAuthorization {
  private readonly grants: ConnectionGrantWriter;
  constructor(
    private readonly db: D1Database,
    private readonly config: AccountConfig,
    private readonly sessions: OwnerSessions,
    private readonly dependencies: Pick<AccountDependencies, 'exchange' | 'verify' | 'fetch'> = {},
  ) {
    this.grants = new ConnectionGrantWriter(db, config, sessions.clock);
  }
  private returnPath(value: string): string {
    try {
      if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value))
        throw new Error('invalid return');
      const decoded = decodeURIComponent(value);
      if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded))
        throw new Error('invalid return');
      const parsed = new URL(value, this.sessions.cookies.origin);
      if (parsed.origin !== this.sessions.cookies.origin || parsed.pathname !== '/')
        throw new Error('unapproved return');
      return parsed.pathname + parsed.search + parsed.hash;
    } catch {
      throw new AppError(
        'validation_failed',
        'choose a local workspace return location.',
        422,
        false,
        { returnPath: 'use the workspace root' },
      );
    }
  }

  private async limitOAuthStarts(request: Request): Promise<void> {
    const header = request.headers.get('CF-Connecting-IP');
    const address =
      !this.sessions.cookies.local &&
      header &&
      header.length <= 64 &&
      addressSchema.safeParse(header).success
        ? header.toLowerCase()
        : this.sessions.cookies.local
          ? 'local'
          : 'edge-without-ip';
    const bucket =
      'oauth-start:' +
      (await signHmac(
        'lanes:oauth-rate:' + this.sessions.cookies.origin + ':' + address,
        this.config.sessionKey,
      ));
    const now = this.sessions.clock(),
      cutoff = now - stateLifetime;
    const admitted = await this.db
      .prepare(
        `INSERT INTO accounts_rate_limits (bucket,window_start,attempts) VALUES (?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET
        window_start=CASE WHEN accounts_rate_limits.window_start<=? THEN excluded.window_start ELSE accounts_rate_limits.window_start END,
        attempts=CASE WHEN accounts_rate_limits.window_start<=? THEN 1 ELSE accounts_rate_limits.attempts+1 END
      WHERE accounts_rate_limits.window_start<=? OR accounts_rate_limits.attempts<20 RETURNING attempts`,
      )
      .bind(bucket, now, cutoff, cutoff, cutoff)
      .first<{ attempts: number }>();
    if (!admitted)
      throw new AppError(
        'rate_limited',
        'too many google authorization attempts. wait a few minutes before trying again.',
        429,
        true,
      );
  }

  async startOAuth(request: Request, input: StartOAuthInput): Promise<OAuthStartResult> {
    this.sessions.cookies.assertOrigin(request, ['POST']);
    const parsed = StartOAuthSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('validation_failed', 'check the google authorization request.', 422);
    const value = parsed.data;
    const returnPath = this.returnPath(value.returnPath);
    try {
      const installation = await this.sessions.installation.read();
      const session =
        value.purpose === 'signin' ? null : await this.sessions.sessionFor(request, installation);
      if (value.purpose !== 'signin' && !session)
        throw new AppError('unauthenticated', 'sign in before connecting an account.', 401);
      const account = value.accountId ? await readConnection(this.db, value.accountId) : null;
      if (account) await assertAccountNotRemoving(this.db, account.id);
      if (account?.state === 'disconnecting')
        throw new AppError('conflict', 'wait for this account to finish disconnecting.', 409);
      if (value.purpose.startsWith('sheets_') && account?.state === 'disconnected')
        throw new AppError(
          'reconnect_required',
          'reconnect this account before granting sheets access.',
          409,
        );
      const connectOwner =
        value.purpose === 'signin' &&
        !(await this.db.prepare('SELECT 1 AS present FROM accounts_connections LIMIT 1').first());
      await this.limitOAuthStarts(request);
      const state = randomToken(),
        nonce = randomToken(),
        pkce = await createPkce();
      const browser = (await this.sessions.cookies.cookieToken(request, 'oauth')) ?? randomToken();
      const stateHash = await hashToken(state);
      const verifier = await encryptToken(
        JSON.stringify({
          verifier: pkce.verifier,
          generation: installation.owner_generation,
          connectOwner,
        }),
        this.config.tokenKey,
        'oauth:' + stateHash + ':verifier',
      );
      const now = this.sessions.clock();
      await this.db
        .prepare(
          `INSERT INTO accounts_oauth_states
        (state_hash,browser_hash,purpose,session_hash,account_id,verifier_ciphertext,nonce,return_path,planning_zone,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          stateHash,
          await hashToken(browser),
          value.purpose,
          session?.tokenHash ?? null,
          account?.id ?? null,
          verifier,
          nonce,
          returnPath,
          value.planningZone ?? account?.planning_zone ?? 'UTC',
          now + stateLifetime,
          now,
        )
        .run();
      const scopes = value.purpose === 'signin' && !connectOwner ? [] : [GOOGLE_TASKS_SCOPE];
      if (value.purpose === 'sheets_import') scopes.push(sheetsImportScope);
      if (value.purpose === 'sheets_export') scopes.push(sheetsExportScope);
      const authorizationUrl = buildGoogleAuthorizationUrl(this.config.google, {
        state,
        nonce,
        codeChallenge: pkce.challenge,
        scopes,
        offline: value.purpose !== 'signin' || connectOwner,
        prompt:
          value.purpose === 'signin' && !connectOwner ? 'select_account' : 'consent select_account',
        ...(account ? { loginHint: account.email } : {}),
      });
      return {
        authorizationUrl,
        cookie: this.sessions.cookies.cookie(
          this.sessions.cookies.browserCookieName,
          await this.sessions.cookies.signedCookie('oauth', browser),
          stateLifetime / 1000,
        ),
      };
    } catch (error) {
      return convertError(error);
    }
  }

  private authorization(session: OwnerSession, state: OAuthStateRow): OAuthWriteAuthorization {
    return {
      sql: `EXISTS (SELECT 1 FROM accounts_sessions s JOIN accounts_installation i ON i.id=1
        AND i.owner_subject=s.owner_subject AND i.owner_generation=s.owner_generation
        WHERE s.token_hash=? AND s.expires_at>? AND i.owner_generation=? AND i.bootstrap_email=? AND i.token_key_id=?)
        AND EXISTS (SELECT 1 FROM accounts_oauth_states o WHERE o.state_hash=? AND o.consumed_at=?)`,
      values: [
        session.tokenHash,
        this.sessions.clock(),
        session.generation,
        this.sessions.ownerEmail,
        this.config.tokenKey.id,
        state.state_hash,
        state.consumed_at,
      ],
    };
  }

  async finishOAuth(request: Request): Promise<OAuthFinishResult> {
    this.sessions.cookies.assertOrigin(request);
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/auth/google/callback') throw invalidState();
    for (const name of ['state', 'code', 'error', 'iss'])
      if (url.searchParams.getAll(name).length > 1) throw invalidState();
    const rawState = url.searchParams.get('state');
    if (!rawState || !/^[A-Za-z0-9_-]{43}$/.test(rawState)) throw invalidState();
    try {
      const installation = await this.sessions.installation.read();
      const browser = await this.sessions.cookies.cookieToken(request, 'oauth');
      if (!browser) throw invalidState();
      const state = await this.db
        .prepare(
          `UPDATE accounts_oauth_states SET consumed_at=?
        WHERE state_hash=? AND browser_hash=? AND expires_at>? AND consumed_at IS NULL RETURNING *`,
        )
        .bind(
          this.sessions.clock(),
          await hashToken(rawState),
          await hashToken(browser),
          this.sessions.clock(),
        )
        .first<OAuthStateRow>();
      if (!state) throw invalidState();
      const session =
        state.purpose === 'signin' ? null : await this.sessions.sessionFor(request, installation);
      if (state.purpose !== 'signin' && (!session || session.tokenHash !== state.session_hash))
        throw new AppError(
          'unauthenticated',
          'the session that started this authorization has ended. sign in and try again.',
          401,
        );
      const plaintext = await decryptToken(
        state.verifier_ciphertext,
        this.config.tokenKey,
        'oauth:' + state.state_hash + ':verifier',
      );
      let decodedVerifier: unknown;
      try {
        decodedVerifier = JSON.parse(plaintext);
      } catch {
        throw invalidState();
      }
      const verifier = verifierSchema.safeParse(decodedVerifier);
      if (!verifier.success || verifier.data.generation !== installation.owner_generation)
        throw invalidState();
      const responseIssuer = url.searchParams.get('iss');
      if (
        responseIssuer &&
        !['https://accounts.google.com', 'accounts.google.com'].includes(responseIssuer)
      )
        throw invalidState();
      if (url.searchParams.has('error'))
        throw new AppError(
          state.purpose.startsWith('sheets_') ? 'permission_required' : 'forbidden',
          'google authorization was not granted. existing connections are unchanged.',
          403,
        );
      const code = url.searchParams.get('code');
      if (!code || code.length > 8192) throw invalidState();
      const target = state.account_id ? await readConnection(this.db, state.account_id) : null;
      const grant = await (this.dependencies.exchange ?? exchangeGoogleCode)(
        this.config.google,
        { code, codeVerifier: verifier.data.verifier },
        {
          now: this.sessions.clock,
          ...(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {}),
        },
      );
      const identity = await (this.dependencies.verify ?? verifyGoogleIdToken)(
        grant.idToken,
        {
          clientId: this.config.google.clientId,
          nonce: state.nonce,
          ...(target ? { expectedSubject: target.google_subject } : {}),
        },
        { now: this.sessions.clock },
      );
      if (target && identity.subject !== target.google_subject)
        throw new AppError(
          'forbidden',
          'google returned a different account. link it separately to keep the intended connection unchanged.',
          403,
        );
      if (state.purpose === 'signin') {
        if (
          installation.owner_subject
            ? installation.owner_subject !== identity.subject
            : normalizeEmail(identity.email) !== this.sessions.ownerEmail
        )
          throw new AppError(
            'forbidden',
            'this google identity does not own this lanes instance.',
            403,
          );
        if (verifier.data.connectOwner)
          return await this.finishOwnerConnection(request, installation, state, identity, grant);
        if (!installation.owner_subject) {
          await this.db
            .prepare(
              `UPDATE accounts_installation SET owner_subject=?
            WHERE id=1 AND owner_subject IS NULL AND owner_generation=? AND bootstrap_email=? AND token_key_id=?
              AND EXISTS (SELECT 1 FROM accounts_oauth_states WHERE state_hash=? AND consumed_at=?)`,
            )
            .bind(
              identity.subject,
              installation.owner_generation,
              this.sessions.ownerEmail,
              this.config.tokenKey.id,
              state.state_hash,
              state.consumed_at,
            )
            .run();
        }
        const current = await this.sessions.installation.read();
        if (
          current.owner_subject !== identity.subject ||
          current.owner_generation !== installation.owner_generation
        )
          throw new AppError(
            'forbidden',
            'this google identity does not own this lanes instance.',
            403,
          );
        return {
          redirectPath: state.return_path,
          cookies: [await this.sessions.createSession(request, current, state)],
        };
      }
      if (!session)
        throw new AppError('unauthenticated', 'sign in before connecting an account.', 401);
      const currentSession = await this.sessions.sessionFor(
        request,
        await this.sessions.installation.read(),
      );
      if (!currentSession || currentSession.tokenHash !== session.tokenHash)
        throw new AppError(
          'unauthenticated',
          'the session that started this authorization has ended.',
          401,
        );
      const connection = await this.grants.prepareConnectionWrite(
        state,
        identity,
        grant,
        target,
        this.authorization(session, state),
      );
      const saved = await connection.statement.first<ConnectionRow>();
      if (!saved) {
        if (!(await this.sessions.sessionFor(request, await this.sessions.installation.read())))
          throw new AppError(
            'unauthenticated',
            'the session that started this authorization has ended.',
            401,
          );
        throw new AppError(
          'conflict',
          'this connection changed while authorization was completing. inspect its current state and try again.',
          409,
        );
      }
      return { redirectPath: state.return_path, cookies: [], connectedAccountId: saved.id };
    } catch (error) {
      return convertError(error);
    }
  }

  private async finishOwnerConnection(
    request: Request,
    installation: InstallationRow,
    state: OAuthStateRow,
    identity: GoogleIdentity,
    grant: GoogleCodeGrant,
  ): Promise<OAuthFinishResult> {
    const auth: OAuthWriteAuthorization = {
      sql: `EXISTS (SELECT 1 FROM accounts_installation WHERE id=1 AND owner_subject=?
        AND owner_generation=? AND bootstrap_email=? AND token_key_id=?)
        AND EXISTS (SELECT 1 FROM accounts_oauth_states WHERE state_hash=? AND consumed_at=?)`,
      values: [
        identity.subject,
        installation.owner_generation,
        this.sessions.ownerEmail,
        this.config.tokenKey.id,
        state.state_hash,
        state.consumed_at,
      ],
    };
    const connection = await this.grants.prepareConnectionWrite(state, identity, grant, null, auth);
    const session = await this.sessions.prepareSession(
      request,
      { ...installation, owner_subject: identity.subject },
      state,
    );
    // each changes() guard must immediately follow its conditional write in this batch transaction.
    const changedRow = () =>
      this.db.prepare('INSERT INTO accounts_write_guards(valid) SELECT 0 WHERE changes()<>1');
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE accounts_installation SET owner_subject=? WHERE id=1 AND owner_subject IS NULL
            AND owner_generation=? AND bootstrap_email=? AND token_key_id=?`,
          )
          .bind(
            identity.subject,
            installation.owner_generation,
            this.sessions.ownerEmail,
            this.config.tokenKey.id,
          ),
        connection.statement,
        changedRow(),
        session.statements[0]!,
        changedRow(),
        ...session.statements.slice(1),
      ]);
    } catch (error) {
      if (error instanceof Error && /CHECK constraint failed:\s*valid\s*=\s*1/i.test(error.message))
        throw new AppError(
          'conflict',
          'this sign-in or account changed while authorization was completing. start sign-in again.',
          409,
        );
      throw error;
    }
    return {
      redirectPath: state.return_path,
      cookies: [session.cookie],
      connectedAccountId: connection.id,
    };
  }
}
