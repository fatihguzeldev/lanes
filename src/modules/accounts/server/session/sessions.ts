import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { hashToken, randomToken, validateTokenKey } from '../credentials/crypto';
import { installationError, invalidState, convertError, normalizeEmail } from '../errors';
import type { AccountConfig } from '../configuration';
import { InstallationStore, type InstallationRow } from './installation';
import { SessionCookies } from './cookies';

/** Server-side identity; HTTP composition must not expose the cookie or session hash. */
export interface OwnerSession {
  subject: string;
  tokenHash: string;
  generation: string;
  expiresAt: number;
}

interface SessionRow {
  token_hash: string;
  owner_subject: string;
  owner_generation: string;
  expires_at: number;
}

interface SessionAuthorization {
  state_hash: string;
  consumed_at: number;
}
const sessionLifetime = 7 * 86_400_000;

export class OwnerSessions {
  readonly cookies: SessionCookies;
  readonly ownerEmail: string;
  readonly clock: () => number;
  readonly installation: InstallationStore;
  constructor(
    private readonly db: D1Database,
    private readonly config: AccountConfig,
    dependencies: { now?: () => number } = {},
  ) {
    try {
      this.cookies = new SessionCookies(config.origin, config.sessionKey);
      if (config.google.redirectUri !== this.cookies.origin + '/auth/google/callback')
        throw installationError();
      this.ownerEmail = normalizeEmail(z.email().parse(config.ownerEmail));
      validateTokenKey(config.tokenKey);
      validateTokenKey({ id: 'session', value: config.sessionKey });
      this.clock = dependencies.now ?? Date.now;
      this.installation = new InstallationStore(
        db,
        this.ownerEmail,
        config.tokenKey.id,
        this.clock,
      );
    } catch {
      throw installationError();
    }
  }
  async sessionFor(request: Request, installation: InstallationRow): Promise<OwnerSession | null> {
    const token = await this.cookies.cookieToken(request, 'session');
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
    this.cookies.assertOrigin(request);
    try {
      return await this.sessionFor(request, await this.installation.read());
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
    const installation = await this.installation.read();
    if (!installation.owner_subject)
      throw new AppError(
        'installation_unavailable',
        'sign in as the configured owner before running scheduled work.',
        503,
      );
    return installation.owner_subject;
  }

  async prepareSession(
    request: Request,
    installation: InstallationRow,
    state: SessionAuthorization,
  ): Promise<{ statements: D1PreparedStatement[]; cookie: string }> {
    if (!installation.owner_subject) throw installationError();
    const token = randomToken(),
      now = this.clock();
    const tokenHash = await hashToken(token);
    const oldToken = await this.cookies.cookieToken(request, 'session');
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
    return {
      statements,
      cookie: this.cookies.cookie(
        this.cookies.sessionCookieName,
        await this.cookies.signedCookie('session', token),
        sessionLifetime / 1000,
      ),
    };
  }

  async createSession(
    request: Request,
    installation: InstallationRow,
    state: SessionAuthorization,
  ): Promise<string> {
    const prepared = await this.prepareSession(request, installation, state);
    const results = await this.db.batch(prepared.statements);
    if (!results[0]?.meta.changes) throw invalidState();
    return prepared.cookie;
  }

  async signOut(request: Request): Promise<{ cookies: string[] }> {
    this.cookies.assertOrigin(request, ['POST']);
    try {
      await this.installation.read();
      const token = await this.cookies.cookieToken(request, 'session');
      if (token) {
        const hash = await hashToken(token);
        await this.db.batch([
          this.db.prepare('DELETE FROM accounts_sessions WHERE token_hash=?').bind(hash),
          this.db.prepare('DELETE FROM accounts_oauth_states WHERE session_hash=?').bind(hash),
        ]);
      }
      return {
        cookies: [
          this.cookies.cookie(this.cookies.sessionCookieName, '', 0),
          this.cookies.cookie(this.cookies.browserCookieName, '', 0),
        ],
      };
    } catch (error) {
      return convertError(error);
    }
  }
}
