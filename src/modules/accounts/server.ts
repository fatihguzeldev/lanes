import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../contracts/errors';
import { assertAccountLinkFresh, assertAccountNotRemoving } from './lifecycle';
import type { Page } from '../../contracts/http';
import {
  AccountPreferencesSchema,
  ConnectionPageOptionsSchema,
  ConnectionSummarySchema,
  StartOAuthSchema,
} from './contracts';
import type {
  AccountPreferencesInput,
  ConnectionPageOptions,
  ConnectionState,
  ConnectionSummary,
  OAuthPurpose,
  StartOAuthInput,
} from './contracts';
import {
  TokenCryptoError,
  createPkce,
  decryptToken,
  encryptToken,
  hashToken,
  randomToken,
  signHmac,
  validateTokenKey,
  verifyHmac,
} from './crypto';
import type { TokenKey } from './crypto';
import {
  GOOGLE_TASKS_SCOPE,
  GoogleOAuthError,
  buildGoogleAuthorizationUrl,
  ensureGoogleScopes,
  exchangeGoogleCode,
  verifyGoogleIdToken,
} from './google';
import type { GoogleCodeGrant, GoogleFetch, GoogleGrant, GoogleOAuthConfig } from './google';

export interface AccountConfig {
  origin: string;
  ownerEmail: string;
  sessionKey: string;
  tokenKey: TokenKey;
  google: GoogleOAuthConfig;
}

export interface AccountDependencies {
  now?: () => number;
  exchange?: typeof exchangeGoogleCode;
  verify?: typeof verifyGoogleIdToken;
  fetch?: GoogleFetch;
  /** Preferences can join a composition-owned operation receipt transaction. */
  commitPreferences?(writes: D1PreparedStatement[]): Promise<D1Result[]>;
}

/** Server-side identity; HTTP composition must not expose the cookie or session hash. */
export interface OwnerSession {
  subject: string;
  tokenHash: string;
  generation: string;
  expiresAt: number;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  cookie: string;
}
export interface OAuthFinishResult {
  redirectPath: string;
  cookies: string[];
  connectedAccountId?: string;
}

interface InstallationRow {
  owner_subject: string | null;
  bootstrap_email: string;
  owner_generation: string;
  token_key_id: string;
}
interface SessionRow {
  token_hash: string;
  owner_subject: string;
  owner_generation: string;
  expires_at: number;
}
interface OAuthStateRow {
  state_hash: string;
  browser_hash: string;
  purpose: OAuthPurpose;
  session_hash: string | null;
  account_id: string | null;
  verifier_ciphertext: string;
  nonce: string;
  return_path: string;
  planning_zone: string;
  expires_at: number;
  consumed_at: number;
  created_at: number;
}
interface ConnectionRow {
  id: string;
  google_subject: string;
  email: string;
  display_name: string;
  picture_url: string | null;
  state: ConnectionState;
  grant_ciphertext: string | null;
  scopes_json: string;
  access_expires_at: number | null;
  grant_expires_at: number | null;
  token_revision: number;
  revision: number;
  planning_zone: string;
  week_start: 1 | 7;
  disconnect_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

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

const day = 86_400_000;
const sessionLifetime = 7 * day;
const stateLifetime = 10 * 60_000;
const addressSchema = z.union([z.ipv4(), z.ipv6()]);
const sheetsImportScope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const sheetsExportScope = 'https://www.googleapis.com/auth/drive.file';
const verifierSchema = z
  .object({
    verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    generation: z.string().min(1),
  })
  .strict();
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

export function accountGrantContext(accountId: string): string {
  return 'account:' + accountId + ':grant';
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
function invalidState(): AppError {
  return new AppError(
    'forbidden',
    'this google authorization is invalid or expired. start it again.',
    403,
  );
}
function installationError(): AppError {
  return new AppError(
    'installation_unavailable',
    'the owner or encryption configuration does not match this installation. restore the configured values or follow the owner-change procedure.',
    503,
  );
}
function convertError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof TokenCryptoError) throw installationError();
  if (error instanceof GoogleOAuthError) {
    switch (error.code) {
      case 'configuration_invalid':
        throw new AppError('installation_unavailable', error.message, 503);
      case 'identity_invalid':
      case 'authorization_failed':
        throw new AppError('forbidden', error.message, 403);
      case 'reconnect_required':
        throw new AppError('reconnect_required', error.message, 409);
      case 'permission_required':
        throw new AppError('permission_required', error.message, 403);
      case 'provider_rate_limited':
        throw new AppError('provider_rate_limited', error.message, 429, error.retryable);
      default:
        throw new AppError('provider_unavailable', error.message, 503, error.retryable);
    }
  }
  throw error;
}

/** Accounts owns authentication and grants; workspace initialization belongs to task/board composition. */
export class AccountService {
  private readonly origin: string;
  private readonly ownerEmail: string;
  private readonly secure: boolean;
  private readonly local: boolean;
  private readonly sessionCookieName: string;
  private readonly browserCookieName: string;
  private readonly clock: () => number;

  constructor(
    private readonly db: D1Database,
    private readonly config: AccountConfig,
    private readonly dependencies: AccountDependencies = {},
  ) {
    try {
      const origin = new URL(config.origin);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
      if (
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))
      )
        throw installationError();
      this.origin = origin.origin;
      if (config.google.redirectUri !== this.origin + '/auth/google/callback')
        throw installationError();
      this.ownerEmail = normalizeEmail(z.email().parse(config.ownerEmail));
      validateTokenKey(config.tokenKey);
      validateTokenKey({ id: 'session', value: config.sessionKey });
      this.local = local;
      this.secure = origin.protocol === 'https:';
      this.sessionCookieName = this.secure ? '__Host-lanes_session' : 'lanes_session';
      this.browserCookieName = this.secure ? '__Host-lanes_oauth' : 'lanes_oauth';
      this.clock = dependencies.now ?? Date.now;
    } catch {
      throw installationError();
    }
  }

  private assertOrigin(request: Request, methods?: readonly string[]): void {
    if (new URL(request.url).origin !== this.origin)
      throw new AppError('forbidden', 'use the configured lanes origin.', 403);
    if (
      methods &&
      (!methods.includes(request.method) || request.headers.get('origin') !== this.origin)
    )
      throw new AppError('forbidden', 'this change requires a request from the lanes origin.', 403);
  }

  private cookie(name: string, value: string, maxAge: number): string {
    return (
      name +
      '=' +
      value +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
      maxAge +
      (this.secure ? '; Secure' : '')
    );
  }

  private readCookie(request: Request, name: string): string | null {
    const header = request.headers.get('cookie');
    if (!header || header.length > 8192) return null;
    const matches = header
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(name + '='));
    return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
  }

  private signedMessage(kind: 'session' | 'oauth', token: string): string {
    return 'lanes:' + kind + ':v1:' + this.origin + ':' + token;
  }
  private async signedCookie(kind: 'session' | 'oauth', token: string): Promise<string> {
    return (
      'v1.' +
      token +
      '.' +
      (await signHmac(this.signedMessage(kind, token), this.config.sessionKey))
    );
  }
  private async cookieToken(request: Request, kind: 'session' | 'oauth'): Promise<string | null> {
    const value = this.readCookie(
      request,
      kind === 'session' ? this.sessionCookieName : this.browserCookieName,
    );
    const match = value?.match(/^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
    if (!match?.[1] || !match[2]) return null;
    return (await verifyHmac(this.signedMessage(kind, match[1]), match[2], this.config.sessionKey))
      ? match[1]
      : null;
  }

  private async installation(): Promise<InstallationRow> {
    const query =
      'SELECT owner_subject,bootstrap_email,owner_generation,token_key_id FROM accounts_installation WHERE id=1';
    let row = await this.db.prepare(query).first<InstallationRow>();
    if (!row) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO accounts_installation
        (id,bootstrap_email,owner_generation,token_key_id,created_at) VALUES (1,?,?,?,?)`,
        )
        .bind(this.ownerEmail, randomToken(), this.config.tokenKey.id, this.clock())
        .run();
      row = await this.db.prepare(query).first<InstallationRow>();
    }
    if (
      !row ||
      row.bootstrap_email !== this.ownerEmail ||
      row.token_key_id !== this.config.tokenKey.id ||
      !row.owner_generation
    )
      throw installationError();
    return row;
  }

  private async sessionFor(
    request: Request,
    installation: InstallationRow,
  ): Promise<OwnerSession | null> {
    const token = await this.cookieToken(request, 'session');
    if (!token || !installation.owner_subject) return null;
    const tokenHash = await hashToken(token);
    const row = await this.db
      .prepare(
        `SELECT token_hash,owner_subject,owner_generation,expires_at FROM accounts_sessions
      WHERE token_hash=? AND expires_at>? AND owner_subject=? AND owner_generation=?`,
      )
      .bind(tokenHash, this.clock(), installation.owner_subject, installation.owner_generation)
      .first<SessionRow>();
    return row
      ? {
          subject: row.owner_subject,
          tokenHash: row.token_hash,
          generation: row.owner_generation,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async getSession(request: Request): Promise<OwnerSession | null> {
    this.assertOrigin(request);
    try {
      return await this.sessionFor(request, await this.installation());
    } catch (error) {
      return convertError(error);
    }
  }
  async requireSession(request: Request): Promise<OwnerSession> {
    const session = await this.getSession(request);
    if (!session) throw new AppError('unauthenticated', 'sign in to use this workspace.', 401);
    return session;
  }

  /** Internal scheduled-work authority. It never bootstraps ownership or becomes a browser response. */
  async requireInstallationOwnerSubject(): Promise<string> {
    const installation = await this.installation();
    if (!installation.owner_subject)
      throw new AppError(
        'installation_unavailable',
        'sign in as the configured owner before running scheduled work.',
        503,
      );
    return installation.owner_subject;
  }

  private returnPath(value: string): string {
    try {
      if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value))
        throw new Error('invalid return');
      const decoded = decodeURIComponent(value);
      if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded))
        throw new Error('invalid return');
      const parsed = new URL(value, this.origin);
      if (parsed.origin !== this.origin || parsed.pathname !== '/')
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

  private async connection(id: string): Promise<ConnectionRow> {
    const row = await this.db
      .prepare('SELECT * FROM accounts_connections WHERE id=?')
      .bind(id)
      .first<ConnectionRow>();
    if (!row) throw new AppError('not_found', 'this connected account was not found.', 404);
    return row;
  }

  private async limitOAuthStarts(request: Request): Promise<void> {
    const header = request.headers.get('CF-Connecting-IP');
    const address =
      !this.local && header && header.length <= 64 && addressSchema.safeParse(header).success
        ? header.toLowerCase()
        : this.local
          ? 'local'
          : 'edge-without-ip';
    const bucket =
      'oauth-start:' +
      (await signHmac('lanes:oauth-rate:' + this.origin + ':' + address, this.config.sessionKey));
    const now = this.clock(),
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
    this.assertOrigin(request, ['POST']);
    const parsed = StartOAuthSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('validation_failed', 'check the google authorization request.', 422);
    const value = parsed.data;
    const returnPath = this.returnPath(value.returnPath);
    try {
      const installation = await this.installation();
      const session =
        value.purpose === 'signin' ? null : await this.sessionFor(request, installation);
      if (value.purpose !== 'signin' && !session)
        throw new AppError('unauthenticated', 'sign in before connecting an account.', 401);
      const account = value.accountId ? await this.connection(value.accountId) : null;
      if (account) await assertAccountNotRemoving(this.db, account.id);
      if (account?.state === 'disconnecting')
        throw new AppError('conflict', 'wait for this account to finish disconnecting.', 409);
      if (value.purpose.startsWith('sheets_') && account?.state === 'disconnected')
        throw new AppError(
          'reconnect_required',
          'reconnect this account before granting sheets access.',
          409,
        );
      await this.limitOAuthStarts(request);
      const state = randomToken(),
        nonce = randomToken(),
        pkce = await createPkce();
      const browser = (await this.cookieToken(request, 'oauth')) ?? randomToken();
      const stateHash = await hashToken(state);
      const verifier = await encryptToken(
        JSON.stringify({ verifier: pkce.verifier, generation: installation.owner_generation }),
        this.config.tokenKey,
        'oauth:' + stateHash + ':verifier',
      );
      const now = this.clock();
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
      const scopes = value.purpose === 'signin' ? [] : [GOOGLE_TASKS_SCOPE];
      if (value.purpose === 'sheets_import') scopes.push(sheetsImportScope);
      if (value.purpose === 'sheets_export') scopes.push(sheetsExportScope);
      const authorizationUrl = buildGoogleAuthorizationUrl(this.config.google, {
        state,
        nonce,
        codeChallenge: pkce.challenge,
        scopes,
        offline: value.purpose !== 'signin',
        prompt: value.purpose === 'signin' ? 'select_account' : 'consent select_account',
        ...(account ? { loginHint: account.email } : {}),
      });
      return {
        authorizationUrl,
        cookie: this.cookie(
          this.browserCookieName,
          await this.signedCookie('oauth', browser),
          stateLifetime / 1000,
        ),
      };
    } catch (error) {
      return convertError(error);
    }
  }

  private authorization(
    session: OwnerSession,
    state: OAuthStateRow,
  ): { sql: string; values: (string | number)[] } {
    return {
      sql: `EXISTS (SELECT 1 FROM accounts_sessions s JOIN accounts_installation i ON i.id=1
        AND i.owner_subject=s.owner_subject AND i.owner_generation=s.owner_generation
        WHERE s.token_hash=? AND s.expires_at>? AND i.owner_generation=? AND i.bootstrap_email=? AND i.token_key_id=?)
        AND EXISTS (SELECT 1 FROM accounts_oauth_states o WHERE o.state_hash=? AND o.consumed_at=?)`,
      values: [
        session.tokenHash,
        this.clock(),
        session.generation,
        this.ownerEmail,
        this.config.tokenKey.id,
        state.state_hash,
        state.consumed_at,
      ],
    };
  }

  async finishOAuth(request: Request): Promise<OAuthFinishResult> {
    this.assertOrigin(request);
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/auth/google/callback') throw invalidState();
    for (const name of ['state', 'code', 'error', 'iss'])
      if (url.searchParams.getAll(name).length > 1) throw invalidState();
    const rawState = url.searchParams.get('state');
    if (!rawState || !/^[A-Za-z0-9_-]{43}$/.test(rawState)) throw invalidState();
    try {
      const installation = await this.installation();
      const browser = await this.cookieToken(request, 'oauth');
      if (!browser) throw invalidState();
      const state = await this.db
        .prepare(
          `UPDATE accounts_oauth_states SET consumed_at=?
        WHERE state_hash=? AND browser_hash=? AND expires_at>? AND consumed_at IS NULL RETURNING *`,
        )
        .bind(this.clock(), await hashToken(rawState), await hashToken(browser), this.clock())
        .first<OAuthStateRow>();
      if (!state) throw invalidState();
      const session =
        state.purpose === 'signin' ? null : await this.sessionFor(request, installation);
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
      const target = state.account_id ? await this.connection(state.account_id) : null;
      const grant = await (this.dependencies.exchange ?? exchangeGoogleCode)(
        this.config.google,
        { code, codeVerifier: verifier.data.verifier },
        {
          now: this.clock,
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
        { now: this.clock },
      );
      if (target && identity.subject !== target.google_subject)
        throw new AppError(
          'forbidden',
          'google returned a different account. link it separately to keep the intended connection unchanged.',
          403,
        );
      if (state.purpose === 'signin') {
        if (!installation.owner_subject && normalizeEmail(identity.email) !== this.ownerEmail)
          throw new AppError(
            'forbidden',
            'this google identity does not own this lanes instance.',
            403,
          );
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
              this.ownerEmail,
              this.config.tokenKey.id,
              state.state_hash,
              state.consumed_at,
            )
            .run();
        }
        const current = await this.installation();
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
          cookies: [await this.createSession(request, current, state)],
        };
      }
      if (!session)
        throw new AppError('unauthenticated', 'sign in before connecting an account.', 401);
      const currentSession = await this.sessionFor(request, await this.installation());
      if (!currentSession || currentSession.tokenHash !== session.tokenHash)
        throw new AppError(
          'unauthenticated',
          'the session that started this authorization has ended.',
          401,
        );
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
        (existing?.disconnect_requested_at &&
          state.created_at <= existing.disconnect_requested_at) ||
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
      const auth = this.authorization(session, state);
      const nextState =
        state.purpose.startsWith('sheets_') && existing?.state === 'connected'
          ? 'connected'
          : 'connecting';
      let saved: ConnectionRow | null;
      if (existing) {
        saved = await this.db
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
          )
          .first<ConnectionRow>();
      } else {
        saved = await this.db
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
          )
          .first<ConnectionRow>();
      }
      if (!saved) {
        if (!(await this.sessionFor(request, await this.installation())))
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

  private async createSession(
    request: Request,
    installation: InstallationRow,
    state: OAuthStateRow,
  ): Promise<string> {
    if (!installation.owner_subject) throw installationError();
    const token = randomToken(),
      now = this.clock();
    const tokenHash = await hashToken(token);
    const oldToken = await this.cookieToken(request, 'session');
    const statements = [];
    statements.push(
      this.db
        .prepare(
          `INSERT INTO accounts_sessions (token_hash,owner_subject,owner_generation,created_at,expires_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM accounts_installation WHERE id=1 AND owner_subject=? AND owner_generation=? AND bootstrap_email=? AND token_key_id=?)
      AND EXISTS (SELECT 1 FROM accounts_oauth_states WHERE state_hash=? AND consumed_at=?)`,
        )
        .bind(
          tokenHash,
          installation.owner_subject,
          installation.owner_generation,
          now,
          now + sessionLifetime,
          installation.owner_subject,
          installation.owner_generation,
          this.ownerEmail,
          this.config.tokenKey.id,
          state.state_hash,
          state.consumed_at,
        ),
    );
    if (oldToken)
      statements.push(
        this.db
          .prepare(
            `DELETE FROM accounts_sessions WHERE token_hash=?
      AND EXISTS (SELECT 1 FROM accounts_sessions WHERE token_hash=?)`,
          )
          .bind(await hashToken(oldToken), tokenHash),
      );
    const results = await this.db.batch(statements);
    if (!results[0]?.meta.changes) throw invalidState();
    return this.cookie(
      this.sessionCookieName,
      await this.signedCookie('session', token),
      sessionLifetime / 1000,
    );
  }

  async signOut(request: Request): Promise<{ cookies: string[] }> {
    this.assertOrigin(request, ['POST']);
    try {
      await this.installation();
      const token = await this.cookieToken(request, 'session');
      if (token) {
        const hash = await hashToken(token);
        await this.db.batch([
          this.db.prepare('DELETE FROM accounts_sessions WHERE token_hash=?').bind(hash),
          this.db.prepare('DELETE FROM accounts_oauth_states WHERE session_hash=?').bind(hash),
        ]);
      }
      return {
        cookies: [
          this.cookie(this.sessionCookieName, '', 0),
          this.cookie(this.browserCookieName, '', 0),
        ],
      };
    } catch (error) {
      return convertError(error);
    }
  }

  private summary(row: SummaryRow): ConnectionSummary {
    const scopes = z.array(z.string()).parse(JSON.parse(row.scopes_json));
    const expired = row.grant_expires_at !== null && row.grant_expires_at <= this.clock();
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
    const session = await this.requireSession(request);
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
    await this.requireSession(request);
    if (!z.string().min(1).max(256).safeParse(accountId).success)
      throw new AppError('validation_failed', 'choose a connected account.', 422);
    const row = await this.db
      .prepare(`SELECT ${summaryFields} FROM accounts_connections WHERE id=?`)
      .bind(accountId)
      .first<SummaryRow>();
    if (!row) throw new AppError('not_found', 'this connected account was not found.', 404);
    return this.summary(row);
  }

  /** Portability exposes identity and preferences, never authorization material. */
  async getPortableIdentity(
    request: Request,
    accountId: string,
  ): Promise<{
    accountId: string;
    googleSubject: string;
    email: string;
    planningZone: string;
    weekStart: 1 | 7;
    revision: number;
  }> {
    await this.requireSession(request);
    if (!z.string().min(1).max(256).safeParse(accountId).success)
      throw new AppError('validation_failed', 'choose a connected account.', 422);
    const row = await this.db
      .prepare(
        'SELECT id,google_subject,email,planning_zone,week_start,revision FROM accounts_connections WHERE id=?',
      )
      .bind(accountId)
      .first<{
        id: string;
        google_subject: string;
        email: string;
        planning_zone: string;
        week_start: 1 | 7;
        revision: number;
      }>();
    if (!row) throw new AppError('not_found', 'this connected account was not found.', 404);
    return {
      accountId: row.id,
      googleSubject: row.google_subject,
      email: row.email,
      planningZone: row.planning_zone,
      weekStart: row.week_start,
      revision: row.revision,
    };
  }

  async updatePreferences(
    request: Request,
    accountId: string,
    input: AccountPreferencesInput,
  ): Promise<ConnectionSummary> {
    this.assertOrigin(request, ['PATCH', 'POST']);
    const session = await this.requireSession(request);
    const parsed = AccountPreferencesSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('validation_failed', 'check the account preferences.', 422);
    const existing = await this.connection(accountId);
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
        this.clock(),
        accountId,
        value.revision,
        session.tokenHash,
        this.clock(),
        session.generation,
        this.ownerEmail,
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
        this.clock(),
        session.generation,
        this.ownerEmail,
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
