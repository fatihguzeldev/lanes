import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../tests/support/sqlite-d1';
import { createAccountServices } from '../../modules/accounts/server/create-services';
import { parseConfiguration, type Env } from '../configuration/env';
import { handleRequest } from '../request';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  open.splice(0).forEach((database) => database.close());
});
function fixture(configured = true) {
  const database = testDatabase();
  open.push(database);
  const assetRequests: Request[] = [];
  const env: Env = {
    DB: database.db,
    ASSETS: {
      fetch: async (request) => {
        assetRequests.push(request);
        const path = new URL(request.url).pathname;
        return new Response(`<html data-entry="${path}"><!--lanes-session--></html>`, {
          headers: {
            'content-type': 'text/html',
            'cache-control': 'public, max-age=3600',
            etag: 'asset-etag',
            'content-length': '42',
          },
        });
      },
    },
    ...(configured
      ? {
          APP_ORIGIN: 'https://lanes.example',
          OWNER_EMAIL: 'owner@example.com',
          GOOGLE_CLIENT_ID: 'client',
          GOOGLE_CLIENT_SECRET: 'secret',
          SESSION_KEY: Buffer.alloc(32, 1).toString('base64url'),
          TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64url'),
        }
      : {}),
  };
  const call = (path = '/', cookie = '', method = 'GET') =>
    handleRequest(
      new Request(`https://lanes.example${path}`, { method, headers: { cookie } }),
      env,
    );
  return { ...database, env, call, assetRequests };
}
async function signedIn() {
  const f = fixture();
  await seedAccount(f.db, 'account');
  const config = parseConfiguration(f.env);
  const auth = createAccountServices(f.db, config, {
    exchange: async () => ({
      accessToken: 'test-access',
      refreshToken: null,
      idToken: 'test-id',
      expiresAt: Date.now() + 3600_000,
      scopes: ['openid', 'email', 'profile'],
      tokenType: 'Bearer',
    }),
    verify: async () => ({ subject: 'owner', email: 'owner@example.com', name: 'owner' }),
  });
  const start = await auth.oauth.startOAuth(
    new Request(`${config.origin}/auth/google/start`, {
      method: 'POST',
      headers: { origin: config.origin },
    }),
    { purpose: 'signin' },
  );
  const state = new URL(start.authorizationUrl).searchParams.get('state');
  const result = await auth.oauth.finishOAuth(
    new Request(`${config.origin}/auth/google/callback?code=test&state=${state}`, {
      headers: { cookie: start.cookie.split(';')[0]! },
    }),
  );
  return { ...f, cookie: result.cookies.map((value) => value.split(';')[0]).join('; ') };
}
function bootstrap(html: string) {
  const json = html.match(
    /<script id="lanes-session" type="application\/json">([\s\S]*?)<\/script>/,
  )?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!);
}
function privateDocument(response: Response) {
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('cdn-cache-control')).toBe('no-store');
  expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
  expect(response.headers.get('vary')).toContain('Cookie');
  expect(response.headers.has('etag')).toBe(false);
  expect(response.headers.has('content-length')).toBe(false);
}

describe('session-aware document entry', () => {
  it('serves sign-in immediately without claiming ownership for a signed-out visitor', async () => {
    const f = fixture();
    const response = await f.call('/?auth_error=invalid_state');
    privateDocument(response);
    const html = await response.text();
    expect(html).toContain('/_entry/signin.html');
    expect(bootstrap(html)).toMatchObject({
      state: 'ready',
      session: { configured: true, authenticated: false },
    });
    expect(
      await f.db
        .prepare('SELECT owner_subject FROM accounts_installation WHERE id=1')
        .first('owner_subject'),
    ).toBeNull();
  });
  it('serves setup while configuration is incomplete and keeps the response private', async () => {
    const f = fixture(false);
    const response = await f.call('/index.html');
    privateDocument(response);
    const html = await response.text();
    expect(html).toContain('/_entry/setup.html');
    expect(bootstrap(html)).toMatchObject({
      state: 'ready',
      session: { configured: false, authenticated: false },
    });
  });
  it('validates the owner session and reuses the API session snapshot for a connected owner', async () => {
    const f = await signedIn();
    const response = await f.call('/', f.cookie);
    privateDocument(response);
    const html = await response.text();
    expect(html).toContain('/_entry/workspace.html');
    const entry = bootstrap(html);
    expect(entry).toMatchObject({
      state: 'ready',
      session: { authenticated: true, accounts: { items: [{ id: 'account' }] } },
    });
    const api = await (await f.call('/api/session', f.cookie)).json();
    expect(entry.session).toEqual({ ...api, serverTime: entry.session.serverTime });
    expect(f.assetRequests[0]!.headers.has('cookie')).toBe(false);
  });
  it('does not show a workspace for an authenticated owner with no connections', async () => {
    const f = await signedIn();
    await f.db.prepare('DELETE FROM accounts_connections').run();
    const html = await (await f.call('/', f.cookie)).text();
    expect(html).toContain('/_entry/signin.html');
    expect(bootstrap(html)).toMatchObject({
      state: 'ready',
      session: { authenticated: true, accounts: { items: [] } },
    });
  });
  it('rejects both expired sessions and forged session cookie presence', async () => {
    const f = await signedIn();
    await f.db.prepare('UPDATE accounts_sessions SET expires_at=1').run();
    for (const cookie of [
      f.cookie,
      `__Host-lanes_session=v1.${'a'.repeat(43)}.${'b'.repeat(43)}`,
    ]) {
      const html = await (await f.call('/', cookie)).text();
      expect(html).toContain('/_entry/signin.html');
      expect(bootstrap(html).session).toMatchObject({ authenticated: false });
      expect(html).not.toContain('account@example.com');
    }
  });
  it('keeps account content inert inside a JSON script', async () => {
    const f = await signedIn();
    const displayName = "</script><script>private()</script>\u2028\u2029$&$`$'";
    await f.db
      .prepare('UPDATE accounts_connections SET display_name=? WHERE id=?')
      .bind(displayName, 'account')
      .run();
    const html = await (await f.call('/', f.cookie)).text();
    expect(html).not.toContain('<script>private()');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('\\u2028\\u2029');
    expect(bootstrap(html).session.accounts.items[0].displayName).toBe(displayName);
  });
  it('serves a private error document without backend diagnostics', async () => {
    const f = fixture();
    vi.spyOn(f.env.DB, 'prepare').mockImplementation(() => {
      throw new Error('private database detail');
    });
    const response = await f.call('/');
    expect(response.status).toBe(503);
    privateDocument(response);
    const html = await response.text();
    expect(html).toContain('/_entry/error.html');
    expect(bootstrap(html)).toMatchObject({ state: 'error', message: expect.any(String) });
    expect(html).not.toContain('private database detail');
  });
  it.each(['missing', 'failed', 'unmarked'])(
    'keeps an unavailable %s entry asset private and bootstraps only a generic error',
    async (problem) => {
      const f = fixture();
      f.env.ASSETS.fetch = async () => {
        if (problem === 'failed') throw new Error('private asset failure');
        return new Response('unavailable', { status: problem === 'missing' ? 404 : 200 });
      };
      const response = await f.call('/');
      expect(response.status).toBe(503);
      privateDocument(response);
      const html = await response.text();
      expect(bootstrap(html)).toEqual({
        state: 'error',
        message: 'lanes could not open this workspace. try again.',
      });
      expect(html).not.toContain('private asset failure');
    },
  );
  it('sends static resources straight to assets and returns no body for document HEAD', async () => {
    const f = fixture();
    vi.spyOn(f.env.DB, 'prepare').mockImplementation(() => {
      throw new Error('static request touched the database');
    });
    for (const path of ['/favicon.svg', '/fonts/dm-sans-latin.woff2', '/assets/client.js']) {
      const response = await f.call(path);
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(f.assetRequests.at(-1)!.url).toBe(`https://lanes.example${path}`);
    }
    vi.restoreAllMocks();
    const head = await f.call('/', '', 'HEAD');
    privateDocument(head);
    expect(await head.text()).toBe('');
  });
});
