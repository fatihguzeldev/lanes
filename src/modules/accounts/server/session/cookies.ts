import { AppError } from '../../../../shared/contracts/errors';
import { signHmac, verifyHmac } from '../credentials/crypto';
import { installationError } from '../errors';

export class SessionCookies {
  readonly origin: string;
  readonly secure: boolean;
  readonly local: boolean;
  readonly sessionCookieName: string;
  readonly browserCookieName: string;
  constructor(
    originValue: string,
    private readonly sessionKey: string,
  ) {
    const origin = new URL(originValue);
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
    this.local = local;
    this.secure = origin.protocol === 'https:';
    this.sessionCookieName = this.secure ? '__Host-lanes_session' : 'lanes_session';
    this.browserCookieName = this.secure ? '__Host-lanes_oauth' : 'lanes_oauth';
  }
  assertOrigin(request: Request, methods?: readonly string[]): void {
    if (new URL(request.url).origin !== this.origin)
      throw new AppError('forbidden', 'use the configured lanes origin.', 403);
    if (
      methods &&
      (!methods.includes(request.method) || request.headers.get('origin') !== this.origin)
    )
      throw new AppError('forbidden', 'this change requires a request from the lanes origin.', 403);
  }

  cookie(name: string, value: string, maxAge: number): string {
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

  async signedCookie(kind: 'session' | 'oauth', token: string): Promise<string> {
    return 'v1.' + token + '.' + (await signHmac(this.signedMessage(kind, token), this.sessionKey));
  }

  async cookieToken(request: Request, kind: 'session' | 'oauth'): Promise<string | null> {
    const value = this.readCookie(
      request,
      kind === 'session' ? this.sessionCookieName : this.browserCookieName,
    );
    const match = value?.match(/^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
    if (!match?.[1] || !match[2]) return null;
    return (await verifyHmac(this.signedMessage(kind, match[1]), match[2], this.sessionKey))
      ? match[1]
      : null;
  }
}
