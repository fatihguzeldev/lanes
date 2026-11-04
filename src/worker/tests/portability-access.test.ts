import { afterEach, beforeEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../tests/support/sqlite-d1';
import type { Env } from '../configuration/env';
import { handleRequest } from '../request';

let database: ReturnType<typeof testDatabase>;
beforeEach(() => {
  database = testDatabase();
});
afterEach(() => database.close());

it.each(['GET', 'POST'])(
  'requires an owner session before %s archive export access',
  async (method) => {
    await seedAccount(database.db, 'account');
    const env: Env = {
      DB: database.db,
      ASSETS: { fetch: async () => new Response('public') },
      APP_ORIGIN: 'https://lanes.example',
      OWNER_EMAIL: 'owner@example.com',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'private-client-secret',
      SESSION_KEY: Buffer.alloc(32, 1).toString('base64url'),
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64url'),
    };
    const request = new Request(
      env.APP_ORIGIN + '/api/accounts/account/transfer/archives/exports',
      {
        method,
        headers: {
          origin: env.APP_ORIGIN!,
          'x-lanes-api': '1',
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      },
    );
    const response = await handleRequest(request, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  },
);
