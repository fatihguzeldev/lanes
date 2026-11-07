import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/support/sqlite-d1';
import { handleRequest } from '../index';
import type { Env } from '../configuration/env';
const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  open.splice(0).forEach((db) => db.close());
});
function fixture(configured: boolean) {
  const db = testDatabase();
  open.push(db);
  return {
    ...db,
    env: {
      DB: db.db,
      ASSETS: { fetch: async () => new Response('public static client') },
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
    } satisfies Env,
  };
}
describe('worker access entry points', () => {
  it('serves public assets while an incomplete installation stays closed', async () => {
    const { env, db } = fixture(false);
    expect(
      await (await handleRequest(new Request('https://lanes.example/favicon.svg'), env)).text(),
    ).toBe('public static client');
    expect(
      await (await handleRequest(new Request('https://lanes.example/api/session'), env)).json(),
    ).toMatchObject({ configured: false, authenticated: false });
    const privateResponse = await handleRequest(
      new Request('https://lanes.example/api/accounts'),
      env,
    );
    expect(privateResponse.status).toBe(503);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts_installation').first('n')).toBe(0);
  });
  it('does not let a public bootstrap request claim the owner', async () => {
    const { env, db } = fixture(true);
    expect(
      await (await handleRequest(new Request('https://lanes.example/api/session'), env)).json(),
    ).toMatchObject({ configured: true, authenticated: false });
    expect(
      await db
        .prepare('SELECT owner_subject FROM accounts_installation WHERE id=1')
        .first('owner_subject'),
    ).toBeNull();
    expect(
      (await handleRequest(new Request('https://lanes.example/api/accounts'), env)).status,
    ).toBe(401);
  });
  it('rejects cross-origin mutation and old-client commands before private work', async () => {
    const { env } = fixture(true);
    const badOrigin = await handleRequest(
      new Request('https://lanes.example/auth/google/start', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'x-lanes-api': '1' },
      }),
      env,
    );
    expect(badOrigin.status).toBe(403);
    const oldClient = await handleRequest(
      new Request('https://lanes.example/auth/google/start', {
        method: 'POST',
        headers: { origin: 'https://lanes.example', 'x-lanes-api': '0' },
      }),
      env,
    );
    expect(oldClient.status).toBe(409);
  });
  it('keeps invalid callback diagnostics off the callback page and preserves closed ownership', async () => {
    const { env, db } = fixture(true);
    const response = await handleRequest(
      new Request('https://lanes.example/auth/google/callback?code=private-code&state=wrong'),
      env,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).not.toContain('private-code');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts_sessions').first('n')).toBe(0);
  });
});
