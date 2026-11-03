import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;
export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revocationEndpoint = 'https://oauth2.googleapis.com/revoke';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
});

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Milliseconds since the Unix epoch. */
  expiresAt: number;
  scopes: string[];
  tokenType: 'Bearer';
  idToken?: string;
  refreshTokenExpiresAt?: number;
}

export interface GoogleCodeGrant extends GoogleGrant {
  idToken: string;
}

export type GoogleOAuthErrorCode =
  | 'authorization_failed'
  | 'configuration_invalid'
  | 'identity_invalid'
  | 'reconnect_required'
  | 'permission_required'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_response_invalid';

const messages: Record<GoogleOAuthErrorCode, string> = {
  authorization_failed: 'google authorization could not be completed. start sign-in again.',
  configuration_invalid: 'the google oauth client configuration needs attention.',
  identity_invalid: 'the google identity could not be verified for this authorization.',
  reconnect_required: 'this google account needs to reconnect.',
  permission_required: 'google did not grant the permission this action needs.',
  provider_rate_limited: 'google is limiting requests. try again later.',
  provider_unavailable: 'google is temporarily unavailable.',
  provider_response_invalid: 'google returned an unexpected authorization response.',
};

/** Safe to map into an application error. Provider bodies and token values are never attached. */
export class GoogleOAuthError extends Error {
  readonly name = 'GoogleOAuthError';

  constructor(
    readonly code: GoogleOAuthErrorCode,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(messages[code]);
  }
}

export type GoogleFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface GoogleRequestOptions {
  fetch?: GoogleFetch;
  now?: () => number;
  signal?: AbortSignal;
}

export interface GoogleAuthorizationInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  scopes?: readonly string[];
  offline?: boolean;
  prompt?: 'consent' | 'select_account' | 'consent select_account';
  loginHint?: string;
}

export function buildGoogleAuthorizationUrl(
  config: GoogleOAuthConfig,
  input: GoogleAuthorizationInput,
): string {
  const url = new URL(authorizationEndpoint);
  const scopes = [...new Set<string>([...GOOGLE_IDENTITY_SCOPES, ...(input.scopes ?? [])])];
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: input.offline ? 'offline' : 'online',
    include_granted_scopes: 'true',
  }).toString();
  if (input.prompt) url.searchParams.set('prompt', input.prompt);
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

function canonicalScope(scope: string): string {
  if (scope === 'https://www.googleapis.com/auth/userinfo.email') return 'email';
  if (scope === 'https://www.googleapis.com/auth/userinfo.profile') return 'profile';
  return scope;
}

export function ensureGoogleScopes(granted: readonly string[], required: readonly string[]): void {
  const available = new Set(granted.map(canonicalScope));
  if (required.some((scope) => !available.has(canonicalScope(scope))))
    throw new GoogleOAuthError('permission_required');
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.number().int().positive(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  scope: z.string().max(16_384).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  id_token: z.string().min(1).max(32_768).optional(),
});

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleOAuthError('provider_response_invalid');
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new GoogleOAuthError('provider_response_invalid');
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new GoogleOAuthError('provider_response_invalid');
    }
  } catch (error) {
    if (error instanceof GoogleOAuthError) throw error;
    throw new GoogleOAuthError('provider_unavailable', true);
  } finally {
    reader.releaseLock();
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Do not retain a response or expose a stream error. */
  }
}

function retryHint(response: Response, now: number): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value || value.length > 100) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) : undefined;
}

async function providerFailure(
  response: Response,
  phase: 'exchange' | 'refresh' | 'revoke',
  now: number,
): Promise<GoogleOAuthError> {
  const hint = retryHint(response, now);
  if (response.status === 429 || response.status >= 500) {
    await discard(response);
    return new GoogleOAuthError(
      response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
      true,
      hint,
    );
  }
  let code: string | undefined;
  try {
    const body = await readJson(response);
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
      code = body.error;
  } catch {
    /* HTTP status still gives a safe classification when an error body is malformed. */
  }
  if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'invalid_scope')
    return new GoogleOAuthError('configuration_invalid');
  if (code === 'invalid_grant' || response.status === 401)
    return new GoogleOAuthError(
      phase === 'refresh' ? 'reconnect_required' : 'authorization_failed',
    );
  if (code === 'insufficient_scope') return new GoogleOAuthError('permission_required');
  if (code === 'access_denied') return new GoogleOAuthError('authorization_failed');
  return new GoogleOAuthError('provider_response_invalid');
}

async function request(
  endpoint: string,
  body: URLSearchParams,
  phase: 'exchange' | 'refresh' | 'revoke',
  options: GoogleRequestOptions,
): Promise<Response> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(10_000);
    response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    throw new GoogleOAuthError(
      phase === 'exchange' ? 'authorization_failed' : 'provider_unavailable',
      phase !== 'exchange',
    );
  }
  if (!response.ok) throw await providerFailure(response, phase, options.now?.() ?? Date.now());
  return response;
}

function grantFromResponse(
  raw: unknown,
  now: number,
  previousRefresh: string | null,
  previousScopes: readonly string[],
  previousRefreshExpiry?: number,
): GoogleGrant {
  const parsed = tokenSchema.safeParse(raw);
  if (!parsed.success) throw new GoogleOAuthError('provider_response_invalid');
  const value = parsed.data;
  const expiresAt = now + value.expires_in * 1000;
  const refreshExpiry =
    value.refresh_token_expires_in === undefined
      ? previousRefreshExpiry
      : now + value.refresh_token_expires_in * 1000;
  if (
    !Number.isSafeInteger(expiresAt) ||
    (refreshExpiry !== undefined && !Number.isSafeInteger(refreshExpiry))
  )
    throw new GoogleOAuthError('provider_response_invalid');
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token ?? previousRefresh,
    expiresAt,
    scopes:
      value.scope === undefined
        ? [...previousScopes]
        : [...new Set(value.scope.split(/\s+/).filter(Boolean))],
    tokenType: 'Bearer',
    ...(value.id_token === undefined ? {} : { idToken: value.id_token }),
    ...(refreshExpiry === undefined ? {} : { refreshTokenExpiresAt: refreshExpiry }),
  };
}

export interface GoogleCodeInput {
  code: string;
  codeVerifier: string;
  requiredScopes?: readonly string[];
  /** Supply only the refresh token belonging to the subject verified by this flow. */
  previousRefreshToken?: string | null;
  requireRefreshToken?: boolean;
}

export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  input: GoogleCodeInput,
  options: GoogleRequestOptions = {},
): Promise<GoogleCodeGrant> {
  const response = await request(
    tokenEndpoint,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
    }),
    'exchange',
    options,
  );
  const grant = grantFromResponse(
    await readJson(response),
    options.now?.() ?? Date.now(),
    input.previousRefreshToken ?? null,
    [],
  );
  ensureGoogleScopes(grant.scopes, input.requiredScopes ?? []);
  if (input.requireRefreshToken && !grant.refreshToken)
    throw new GoogleOAuthError('reconnect_required');
  if (!grant.idToken) throw new GoogleOAuthError('provider_response_invalid');
  return { ...grant, idToken: grant.idToken };
}

export interface GoogleRefreshInput {
  refreshToken: string;
  scopes: readonly string[];
  requiredScopes?: readonly string[];
  refreshTokenExpiresAt?: number;
}

export async function refreshGoogleGrant(
  config: GoogleOAuthConfig,
  input: GoogleRefreshInput,
  options: GoogleRequestOptions = {},
): Promise<GoogleGrant> {
  if (!input.refreshToken) throw new GoogleOAuthError('reconnect_required');
  const response = await request(
    tokenEndpoint,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }),
    'refresh',
    options,
  );
  const grant = grantFromResponse(
    await readJson(response),
    options.now?.() ?? Date.now(),
    input.refreshToken,
    input.scopes,
    input.refreshTokenExpiresAt,
  );
  ensureGoogleScopes(grant.scopes, input.requiredScopes ?? []);
  return grant;
}

export async function revokeGoogleGrant(
  token: string,
  options: GoogleRequestOptions = {},
): Promise<void> {
  const response = await request(
    revocationEndpoint,
    new URLSearchParams({ token }),
    'revoke',
    options,
  );
  await discard(response);
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface GoogleIdentityRequirements {
  clientId: string;
  nonce: string;
  expectedSubject?: string;
}

export interface GoogleIdentityOptions {
  keySet?: JWTVerifyGetKey;
  now?: () => number;
}

const identitySchema = z.object({
  sub: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/),
  email: z.email(),
  email_verified: z.literal(true),
  nonce: z.string().min(1),
  iat: z.number().int(),
});

export async function verifyGoogleIdToken(
  token: string,
  requirements: GoogleIdentityRequirements,
  options: GoogleIdentityOptions = {},
): Promise<GoogleIdentity> {
  try {
    if (!token || token.length > 32_768 || !requirements.nonce)
      throw new GoogleOAuthError('identity_invalid');
    const now = options.now?.() ?? Date.now();
    const { payload } = await jwtVerify(token, options.keySet ?? googleKeys, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: requirements.clientId,
      currentDate: new Date(now),
      requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified'],
    });
    const identity = identitySchema.safeParse(payload);
    if (
      !identity.success ||
      identity.data.nonce !== requirements.nonce ||
      identity.data.iat > Math.floor(now / 1000) + 60 ||
      (requirements.expectedSubject !== undefined &&
        identity.data.sub !== requirements.expectedSubject) ||
      (payload.azp !== undefined && payload.azp !== requirements.clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== requirements.clientId)
    )
      throw new GoogleOAuthError('identity_invalid');
    let picture: string | undefined;
    if (typeof payload.picture === 'string' && payload.picture.length <= 2048) {
      try {
        const url = new URL(payload.picture);
        if (url.protocol === 'https:' && !url.username && !url.password) picture = url.toString();
      } catch {
        /* Optional profile images do not decide authentication. */
      }
    }
    return {
      subject: identity.data.sub,
      email: identity.data.email,
      ...(typeof payload.name === 'string' && payload.name.length <= 256
        ? { name: payload.name }
        : {}),
      ...(picture === undefined ? {} : { picture }),
    };
  } catch (error) {
    if (error instanceof GoogleOAuthError) throw error;
    if (
      error instanceof errors.JWKSTimeout ||
      error instanceof TypeError ||
      (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC')
    )
      throw new GoogleOAuthError('provider_unavailable', true);
    throw new GoogleOAuthError('identity_invalid');
  }
}
