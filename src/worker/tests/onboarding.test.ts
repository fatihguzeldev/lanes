import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../../../tests/support/sqlite-d1';
import { invocationDatabase } from '../../../tests/support/d1-invocation';
import { GOOGLE_TASKS_SCOPE } from '../../modules/accounts/server/oauth/google';
import { handleRequest } from '../index';
import type { Env } from '../configuration/env';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
const open: ReturnType<typeof testDatabase>[] = [];
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'onboarding', alg: 'RS256' };
});
afterEach(() => {
  vi.restoreAllMocks();
  open.splice(0).forEach((database) => database.close());
});

it.each([false, true])(
  'opens the first account through one OAuth callback and retains consent across initialization failure: %s',
  async (interruptInitialization) => {
    const database = testDatabase();
    open.push(database);
    let failInitialization = interruptInitialization;
    const prepare = database.db.prepare.bind(database.db);
    vi.spyOn(database.db, 'prepare').mockImplementation((sql) => {
      if (failInitialization && sql.startsWith('INSERT OR IGNORE INTO tasks_account_state')) {
        failInitialization = false;
        throw new Error('temporary workspace initialization failure');
      }
      return prepare(sql);
    });
    const env: Env = {
      DB: database.db,
      ASSETS: { fetch: async () => new Response('public') },
      APP_ORIGIN: 'https://lanes.example',
      OWNER_EMAIL: 'owner@example.com',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      SESSION_KEY: Buffer.alloc(32, 1).toString('base64url'),
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64url'),
    };
    const call = (path: string, cookie = '', body?: unknown) => {
      const invocation = invocationDatabase(env.DB);
      return handleRequest(
        new Request(env.APP_ORIGIN + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            cookie,
            origin: env.APP_ORIGIN!,
            'x-lanes-api': '1',
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        { ...env, DB: invocation.db },
      ).then((response) => {
        expect(invocation.queries).toBeLessThanOrEqual(50);
        return response;
      });
    };
    const started = await call('/auth/google/start', '', {
      purpose: 'signin',
      planningZone: 'Europe/Istanbul',
    });
    const authorization = new URL((await started.json()).authorizationUrl);
    expect(authorization.searchParams.get('scope')).toContain(GOOGLE_TASKS_SCOPE);
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    const idToken = await new SignJWT({
      sub: 'owner-subject',
      email: 'owner@example.com',
      email_verified: true,
      nonce: authorization.searchParams.get('nonce'),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'onboarding' })
      .setIssuer('https://accounts.google.com')
      .setAudience('client')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    let exchanges = 0;
    const list = { id: 'list', etag: '"v1"', title: 'my tasks', updated: new Date().toISOString() };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.href === 'https://oauth2.googleapis.com/token') {
        exchanges++;
        expect(new URLSearchParams(String(init?.body)).get('code')).toBe('test-code');
        return Response.json({
          access_token: 'test-access',
          refresh_token: 'test-refresh',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile ' + GOOGLE_TASKS_SCOPE,
        });
      }
      if (url.href === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] });
      expect(url.origin).toBe('https://tasks.googleapis.com');
      expect(init?.method).toBe('GET');
      if (url.pathname.endsWith('/lists/@default')) return Response.json(list);
      if (url.pathname.endsWith('/users/@me/lists')) return Response.json({ items: [list] });
      return Response.json({ items: [] });
    });
    const callback = await call(
      '/auth/google/callback?code=test-code&state=' + authorization.searchParams.get('state'),
      started.headers.get('set-cookie')!.split(';')[0]!,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(
      env.APP_ORIGIN + (interruptInitialization ? '/?connection_setup=pending' : '/'),
    );
    const cookie = callback.headers.get('set-cookie')!.split(';')[0]!;
    const session = await (await call('/api/session', cookie)).json();
    expect(session.authenticated).toBe(true);
    expect(session.accounts.items).toHaveLength(1);
    const account = session.accounts.items[0];
    expect(account).toMatchObject({ email: 'owner@example.com', planningZone: 'Europe/Istanbul' });
    const base = '/api/accounts/' + account.id;
    expect((await call(base + '/sync', cookie, { reason: 'manual' })).status).toBe(200);
    for (let i = 0; i < 8; i++) {
      const status = await (await call(base + '/sync', cookie)).json();
      if (status.initialized) break;
      expect((await call(base + '/sync/advance', cookie, {})).status).toBe(200);
    }
    expect(await (await call(base + '/sync', cookie)).json()).toMatchObject({ initialized: true });
    const boards = await (await call(base + '/boards', cookie)).json();
    expect(boards.items).toHaveLength(1);
    const lists = await (
      await call(base + '/boards/' + boards.items[0].id + '/lists', cookie)
    ).json();
    expect(lists.items).toEqual([expect.objectContaining({ title: 'my tasks' })]);
    expect(exchanges).toBe(1);
  },
);
