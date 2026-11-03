import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_TASKS_SCOPE,
  GoogleOAuthError,
  buildGoogleAuthorizationUrl,
  ensureGoogleScopes,
  exchangeGoogleCode,
  refreshGoogleGrant,
  revokeGoogleGrant,
  verifyGoogleIdToken,
} from './google';

const config = {
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://lanes.example.workers.dev/auth/google/callback',
};
const now = Date.parse('2026-11-02T12:00:00Z');
const clock = () => now;
let signingKey: CryptoKey;
let keySet: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  signingKey = keys.privateKey;
  keySet = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256' }],
  });
});

async function idToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'google-subject',
    email: 'owner@example.com',
    email_verified: true,
    nonce: 'expected-nonce',
    name: 'owner',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : 'https://accounts.google.com')
    .setAudience(typeof claims.aud === 'string' ? claims.aud : config.clientId)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : Math.floor(now / 1000) + 60)
    .sign(signingKey);
}

const success = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    id_token: 'header.payload.signature',
    scope:
      'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ' +
      GOOGLE_TASKS_SCOPE,
    ...overrides,
  });

describe('google authorization request', () => {
  it('uses code + S256, explicit redirect and incremental scopes without putting a secret in the URL', () => {
    const url = new URL(
      buildGoogleAuthorizationUrl(config, {
        state: 'one-use-state',
        nonce: 'one-use-nonce',
        codeChallenge: 'pkce-challenge',
        scopes: [GOOGLE_TASKS_SCOPE],
        offline: true,
        prompt: 'consent select_account',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('one-use-nonce');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      ...GOOGLE_IDENTITY_SCOPES,
      GOOGLE_TASKS_SCOPE,
    ]);
    expect(url.toString()).not.toContain(config.clientSecret);
  });

  it('keeps identity-only login distinct from offline tasks consent', () => {
    const url = new URL(
      buildGoogleAuthorizationUrl(config, {
        state: 'state',
        nonce: 'nonce',
        codeChallenge: 'challenge',
      }),
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('access_type')).toBe('online');
  });
});

describe('token grants', () => {
  it('exchanges a code with its verifier and validates actual scopes', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')).toBe('verifier');
      expect(body.get('client_secret')).toBe(config.clientSecret);
      expect(init?.redirect).toBe('error');
      return success();
    });
    const grant = await exchangeGoogleCode(
      config,
      {
        code: 'authorization-code',
        codeVerifier: 'verifier',
        requiredScopes: [GOOGLE_TASKS_SCOPE],
        requireRefreshToken: true,
      },
      { fetch: fetcher, now: clock },
    );
    expect(grant.accessToken).toBe('new-access');
    expect(grant.refreshToken).toBe('new-refresh');
    expect(grant.expiresAt).toBe(now + 3_600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts documented OIDC aliases while keeping API scope matching exact', () => {
    expect(() =>
      ensureGoogleScopes(
        ['openid', 'https://www.googleapis.com/auth/userinfo.email'],
        ['openid', 'email'],
      ),
    ).not.toThrow();
    expect(() =>
      ensureGoogleScopes([GOOGLE_TASKS_SCOPE.toUpperCase()], [GOOGLE_TASKS_SCOPE]),
    ).toThrow(GoogleOAuthError);
  });

  it('rejects a missing background refresh token and missing granted tasks scope', async () => {
    await expect(
      exchangeGoogleCode(
        config,
        { code: 'code', codeVerifier: 'verifier', requireRefreshToken: true },
        {
          fetch: async () => success({ refresh_token: undefined }),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'reconnect_required' });
    await expect(
      exchangeGoogleCode(
        config,
        { code: 'code', codeVerifier: 'verifier', requiredScopes: [GOOGLE_TASKS_SCOPE] },
        {
          fetch: async () => success({ scope: 'openid email profile' }),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'permission_required' });
  });

  it('preserves an existing refresh token when Google omits its replacement', async () => {
    const grant = await refreshGoogleGrant(
      config,
      {
        refreshToken: 'still-valid-refresh',
        scopes: ['openid', GOOGLE_TASKS_SCOPE],
      },
      { fetch: async () => success({ refresh_token: undefined, scope: undefined }), now: clock },
    );
    expect(grant.refreshToken).toBe('still-valid-refresh');
    expect(grant.scopes).toContain(GOOGLE_TASKS_SCOPE);
  });

  it('does not drop an existing refresh token during an incremental grant', async () => {
    const grant = await exchangeGoogleCode(
      config,
      {
        code: 'code',
        codeVerifier: 'verifier',
        previousRefreshToken: 'existing-refresh',
        requireRefreshToken: true,
      },
      { fetch: async () => success({ refresh_token: undefined }), now: clock },
    );
    expect(grant.refreshToken).toBe('existing-refresh');
  });

  it('maps expired grants separately from outages and never exposes provider diagnostics', async () => {
    const secret = 'provider-body-with-a-sensitive-token';
    const failure = refreshGoogleGrant(
      config,
      { refreshToken: 'refresh', scopes: [] },
      {
        fetch: async () =>
          Response.json({ error: 'invalid_grant', error_description: secret }, { status: 400 }),
        now: clock,
      },
    );
    await expect(failure).rejects.toMatchObject({ code: 'reconnect_required', retryable: false });
    try {
      await failure;
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    await expect(
      refreshGoogleGrant(
        config,
        { refreshToken: 'refresh', scopes: [] },
        {
          fetch: async () => Response.json({ error: secret }, { status: 503 }),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('requires an ID token from the code flow that requested openid', async () => {
    await expect(
      exchangeGoogleCode(
        config,
        { code: 'code', codeVerifier: 'verifier' },
        {
          fetch: async () => success({ id_token: undefined }),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('rejects malformed successful responses rather than returning a usable connection', async () => {
    await expect(
      exchangeGoogleCode(
        config,
        { code: 'code', codeVerifier: 'verifier' },
        {
          fetch: async () => success({ expires_in: -1 }),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('bounds provider bodies and sanitizes failures that occur while reading them', async () => {
    await expect(
      exchangeGoogleCode(
        config,
        { code: 'code', codeVerifier: 'verifier' },
        {
          fetch: async () => new Response('x'.repeat(65_537)),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({ code: 'provider_response_invalid' });
    const sensitive = 'stream error containing a sensitive token';
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error(sensitive));
      },
    });
    const failure = exchangeGoogleCode(
      config,
      { code: 'code', codeVerifier: 'verifier' },
      {
        fetch: async () => new Response(stream),
        now: clock,
      },
    );
    await expect(failure).rejects.toBeInstanceOf(GoogleOAuthError);
    try {
      await failure;
    } catch (error) {
      expect(String(error)).not.toContain(sensitive);
    }
  });

  it('returns a bounded retry hint without leaking a rate-limited response body', async () => {
    await expect(
      refreshGoogleGrant(
        config,
        { refreshToken: 'refresh', scopes: [] },
        {
          fetch: async () =>
            new Response('private diagnostics', { status: 429, headers: { 'Retry-After': '60' } }),
          now: clock,
        },
      ),
    ).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
      retryAfterSeconds: 60,
    });
  });

  it('revokes through the fixed server endpoint and reports failure rather than claiming success', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get('token')).toBe('refresh-token');
      return new Response(null, { status: 200 });
    });
    await expect(revokeGoogleGrant('refresh-token', { fetch: fetcher })).resolves.toBeUndefined();
    await expect(
      revokeGoogleGrant('refresh-token', {
        fetch: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

describe('google identity verification', () => {
  it('verifies a real signature and returns the immutable subject', async () => {
    const identity = await verifyGoogleIdToken(
      await idToken(),
      {
        clientId: config.clientId,
        nonce: 'expected-nonce',
        expectedSubject: 'google-subject',
      },
      { keySet, now: clock },
    );
    expect(identity).toMatchObject({
      subject: 'google-subject',
      email: 'owner@example.com',
      name: 'owner',
    });
  });

  it.each([
    { aud: 'another-client' },
    { iss: 'https://attacker.example' },
    { nonce: 'another-nonce' },
    { email_verified: false },
    { email_verified: 'true' },
    { nonce: undefined },
    { email: undefined },
    { azp: 'another-client' },
    { exp: Math.floor(now / 1000) - 1 },
    { sub: 'different-subject' },
  ])('rejects a signed token with unacceptable claims: %j', async (claims) => {
    await expect(
      verifyGoogleIdToken(
        await idToken(claims),
        {
          clientId: config.clientId,
          nonce: 'expected-nonce',
          expectedSubject: 'google-subject',
        },
        { keySet, now: clock },
      ),
    ).rejects.toMatchObject({ code: 'identity_invalid' });
  });

  it('rejects a forged signature even when every claim looks right', async () => {
    const token = await idToken();
    const parts = token.split('.');
    parts[2] = 'A'.repeat(parts[2]?.length ?? 342);
    await expect(
      verifyGoogleIdToken(
        parts.join('.'),
        {
          clientId: config.clientId,
          nonce: 'expected-nonce',
        },
        { keySet, now: clock },
      ),
    ).rejects.toMatchObject({ code: 'identity_invalid' });
  });
});
