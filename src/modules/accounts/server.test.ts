import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { testDatabase } from '../../../tests/sqlite-d1';
import { AppError } from '../../contracts/errors';
import { decryptToken } from './crypto';
import { GOOGLE_TASKS_SCOPE } from './google';
import type {
  GoogleCodeGrant,
  GoogleIdentity,
  exchangeGoogleCode,
  verifyGoogleIdToken,
} from './google';
import { AccountService, accountGrantContext } from './server';
import type { AccountConfig } from './server';
import { AccountLifecycle, accountRelinkFence } from './lifecycle';
import { ProviderAccess } from './provider-access';

const initialNow = Date.parse('2026-11-02T12:00:00Z');
const day = 86_400_000;
const config: AccountConfig = {
  origin: 'https://lanes.example.workers.dev',
  ownerEmail: 'owner@example.com',
  sessionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  tokenKey: { id: 'primary', value: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
  google: {
    clientId: 'client.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://lanes.example.workers.dev/auth/google/callback',
  },
};
let database: ReturnType<typeof testDatabase>;
let service: AccountService;
let now: number;
let identity: GoogleIdentity;
let grant: GoogleCodeGrant;
let verify: Mock<typeof verifyGoogleIdToken>;
let exchange: Mock<typeof exchangeGoogleCode>;

function request(path = '/', cookie = '', method = 'GET', origin: string | null = config.origin) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  if (origin) headers.set('origin', origin);
  return new Request(config.origin + path, { method, headers });
}
const pair = (cookie: string) => cookie.split(';')[0] ?? '';
const allPairs = (cookies: string[]) => cookies.map(pair).join('; ');

async function start(
  purpose: 'signin' | 'link' | 'reconnect' | 'sheets_import' | 'sheets_export',
  session = '',
  accountId?: string,
) {
  return service.startOAuth(request('/auth/google/start', session, 'POST'), {
    purpose,
    ...(accountId ? { accountId } : {}),
    planningZone: 'Europe/Istanbul',
  });
}
async function callback(
  started: { authorizationUrl: string; cookie: string },
  session = '',
  code = 'authorization-code',
) {
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const cookie = [session, pair(started.cookie)].filter(Boolean).join('; ');
  return service.finishOAuth(
    request('/auth/google/callback?state=' + state + '&code=' + code, cookie),
  );
}
async function signIn() {
  identity = { subject: 'owner-subject', email: 'owner@example.com', name: 'owner' };
  const started = await start('signin');
  const finished = await callback(started);
  return allPairs(finished.cookies);
}
async function link(session: string, subject = 'secondary-subject') {
  identity = { subject, email: subject + '@example.com', name: subject };
  const started = await start('link', session);
  return callback(started, session);
}

beforeEach(() => {
  database = testDatabase();
  now = initialNow;
  identity = { subject: 'owner-subject', email: 'owner@example.com', name: 'owner' };
  grant = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    idToken: 'signed-identity',
    tokenType: 'Bearer',
    expiresAt: now + 3_600_000,
    scopes: ['openid', 'email', 'profile', GOOGLE_TASKS_SCOPE],
  };
  verify = vi.fn<typeof verifyGoogleIdToken>(async () => identity);
  exchange = vi.fn<typeof exchangeGoogleCode>(async () => grant);
  service = new AccountService(database.db, config, { now: () => now, verify, exchange });
});
afterEach(() => database.close());

describe('local account removal and OAuth callback freshness', () => {
  async function removing(session: string) {
    const linked = await link(session);
    const accountId = linked.connectedAccountId!;
    const access = new ProviderAccess(database.db, config, {
      now: () => now,
      revoke: async () => {},
    });
    const lifecycle = new AccountLifecycle(database.db, {
      access,
      owners: [
        {
          name: 'workspace',
          pause: async () => ({ done: true, pending: false }),
          remove: async () => ({ done: true, deleted: 0 }),
          hasUnresolved: async () => false,
        },
      ],
      now: () => now,
    });
    await lifecycle.startDisconnect(accountId);
    await lifecycle.advanceDisconnect(accountId);
    await lifecycle.advanceDisconnect(accountId);
    const account = database.sqlite
      .prepare('SELECT revision FROM accounts_connections WHERE id=?')
      .get(accountId)!;
    await lifecycle.startRemoval(accountId, { confirm: true, revision: Number(account.revision) });
    return { accountId, lifecycle };
  }
  it('rejects a generic callback started during removal after its old connection row is gone', async () => {
    const session = await signIn();
    const { accountId, lifecycle } = await removing(session);
    now += 1_000;
    const late = await start('link', session);
    identity = { subject: 'secondary-subject', email: 'secondary@example.com' };
    for (let i = 0; i < 10; i++) {
      now += 1_000;
      if ((await lifecycle.advanceRemoval(accountId)).state === 'completed') break;
    }
    expect(
      database.sqlite.prepare('SELECT id FROM accounts_connections WHERE id=?').get(accountId),
    ).toBeUndefined();
    await expect(callback(late, session)).rejects.toMatchObject({ code: 'conflict' });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM accounts_connections WHERE google_subject='secondary-subject'",
        )
        .get()?.n,
    ).toBe(0);
    now += 1_000;
    const fresh = await callback(await start('link', session), session);
    expect(fresh.connectedAccountId).toBeTruthy();
    expect(fresh.connectedAccountId).not.toBe(accountId);
  });
  it('refuses a targeted reconnect start while local removal is unfinished', async () => {
    const session = await signIn();
    const { accountId } = await removing(session);
    now += 1_000;
    await expect(start('reconnect', session, accountId)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('checks callback freshness in the final insert after an earlier check passed', async () => {
    const session = await signIn();
    const started = await start('link', session);
    identity = { subject: 'racing-subject', email: 'race@example.com' };
    const original = database.db;
    let injected = false;
    const wrapped = {
      ...original,
      prepare(sql: string) {
        const statement = original.prepare(sql);
        if (!sql.startsWith('INSERT INTO accounts_connections')) return statement;
        const wrap = (prepared: typeof statement): typeof statement =>
          new Proxy(prepared, {
            get(target, key) {
              if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
              if (key === 'first')
                return async () => {
                  if (!injected) {
                    injected = true;
                    const fence = await accountRelinkFence('racing-subject', now);
                    await original
                      .prepare(
                        'INSERT INTO accounts_removed_subjects(subject_hash,fresh_after) VALUES(?,?)',
                      )
                      .bind(fence.values[0], now)
                      .run();
                  }
                  return target.first();
                };
              return Reflect.get(target, key);
            },
          });
        return wrap(statement);
      },
    } as typeof original;
    service = new AccountService(wrapped, config, { now: () => now, verify, exchange });
    await expect(callback(started, session)).rejects.toMatchObject({ code: 'conflict' });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM accounts_connections WHERE google_subject='racing-subject'",
        )
        .get()?.n,
    ).toBe(0);
  });
});

describe('owner access and sessions', () => {
  it('binds the intended owner subject and stores only a hash of the opaque session', async () => {
    const cookie = await signIn();
    const session = await service.requireSession(request('/', cookie));
    expect(session.subject).toBe('owner-subject');
    expect(session.expiresAt).toBe(now + 7 * day);
    const installation = database.sqlite.prepare('SELECT * FROM accounts_installation').get();
    expect(installation?.owner_subject).toBe('owner-subject');
    const rows = database.sqlite.prepare('SELECT * FROM accounts_sessions').all();
    expect(rows).toHaveLength(1);
    expect(cookie).not.toContain(String(rows[0]?.token_hash));
  });

  it('rejects another verified test user and never exposes a first-visitor ownership claim', async () => {
    identity = { subject: 'intruder', email: 'another@example.com' };
    await expect(callback(await start('signin'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      database.sqlite.prepare('SELECT owner_subject FROM accounts_installation').get()
        ?.owner_subject,
    ).toBeNull();
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM accounts_sessions').get()?.n).toBe(0);
  });

  it('uses the bound subject rather than a later reassignment of the bootstrap email', async () => {
    await signIn();
    identity = { subject: 'another-subject', email: 'owner@example.com' };
    await expect(callback(await start('signin'))).rejects.toMatchObject({ code: 'forbidden' });
    identity = { subject: 'owner-subject', email: 'renamed@example.com' };
    await expect(callback(await start('signin'))).resolves.toMatchObject({ redirectPath: '/' });
  });

  it('expires a session after seven days without silently renewing it', async () => {
    const cookie = await signIn();
    now += 7 * day;
    expect(await service.getSession(request('/', cookie))).toBeNull();
    await expect(service.requireSession(request('/', cookie))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rejects altered cookies and fails closed after the installation generation changes', async () => {
    const cookie = await signIn();
    expect(await service.getSession(request('/', cookie + 'x'))).toBeNull();
    database.sqlite
      .prepare("UPDATE accounts_installation SET owner_generation='new-generation'")
      .run();
    expect(await service.getSession(request('/', cookie))).toBeNull();
  });

  it('fails closed when the configured owner or token key id differs from the installation', async () => {
    const cookie = await signIn();
    const changedOwner = new AccountService(database.db, {
      ...config,
      ownerEmail: 'new-owner@example.com',
    });
    await expect(changedOwner.getSession(request('/', cookie))).rejects.toMatchObject({
      code: 'installation_unavailable',
    });
    const changedKey = new AccountService(database.db, {
      ...config,
      tokenKey: { ...config.tokenKey, id: 'new-key' },
    });
    await expect(changedKey.getSession(request('/', cookie))).rejects.toMatchObject({
      code: 'installation_unavailable',
    });
  });

  it('sets secure host-only cookies and permits an insecure cookie only on an explicitly local origin', async () => {
    const result = await callback(await start('signin'));
    expect(result.cookies[0]).toContain('__Host-lanes_session=');
    expect(result.cookies[0]).toContain('HttpOnly');
    expect(result.cookies[0]).toContain('Secure');
    expect(result.cookies[0]).toContain('SameSite=Lax');
    const localConfig = {
      ...config,
      origin: 'http://127.0.0.1:5173',
      google: { ...config.google, redirectUri: 'http://127.0.0.1:5173/auth/google/callback' },
    };
    const localDb = testDatabase();
    try {
      const local = new AccountService(localDb.db, localConfig, {
        verify,
        exchange,
        now: () => now,
      });
      const started = await local.startOAuth(
        new Request(localConfig.origin + '/auth/google/start', {
          method: 'POST',
          headers: { origin: localConfig.origin },
        }),
        { purpose: 'signin' },
      );
      expect(started.cookie).toContain('lanes_oauth=');
      expect(started.cookie).not.toContain('Secure');
    } finally {
      localDb.close();
    }
    expect(
      () => new AccountService(database.db, { ...config, origin: 'http://not-local.example' }),
    ).toThrow(AppError);
  });

  it('retains an existing session when a new signin is invalidated before its final commit', async () => {
    const session = await signIn();
    const started = await start('signin', session);
    exchange.mockImplementationOnce(async () => {
      database.sqlite.prepare('DELETE FROM accounts_oauth_states').run();
      return grant;
    });
    await expect(callback(started, session)).rejects.toBeInstanceOf(AppError);
    expect(await service.getSession(request('/', session))).not.toBeNull();
  });

  it('signs out only the current session and leaves the connected account intact', async () => {
    const session = await signIn();
    const linked = await link(session);
    const otherBrowser = await signIn();
    const result = await service.signOut(request('/auth/signout', session, 'POST'));
    expect(result.cookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    expect(await service.getSession(request('/', session))).toBeNull();
    expect(await service.getSession(request('/', otherBrowser))).not.toBeNull();
    expect(database.sqlite.prepare('SELECT id FROM accounts_connections').get()?.id).toBe(
      linked.connectedAccountId,
    );
    await expect(service.listConnectionSummaries(request('/', session))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});

describe('one-use oauth authorization', () => {
  it('rejects callback replay and a different browser binding before exchanging a code', async () => {
    const started = await start('signin');
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await expect(
      service.finishOAuth(request('/auth/google/callback?state=' + state + '&code=code')),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(exchange).not.toHaveBeenCalled();
    await callback(started);
    await expect(callback(started)).rejects.toMatchObject({ code: 'forbidden' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired state and an unapproved return location', async () => {
    const started = await start('signin');
    now += 10 * 60_000;
    await expect(callback(started)).rejects.toMatchObject({ code: 'forbidden' });
    for (const returnPath of [
      'https://attacker.example',
      '//attacker.example',
      '/\\attacker.example',
      '/auth/google/callback',
    ]) {
      await expect(
        service.startOAuth(request('/auth/google/start', '', 'POST'), {
          purpose: 'signin',
          returnPath,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });

  it('requires an owner session for data grants and the exact origin for state-changing requests', async () => {
    await expect(start('link')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      service.startOAuth(request('/auth/google/start', '', 'POST', 'https://attacker.example'), {
        purpose: 'signin',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.startOAuth(request('/auth/google/start', '', 'POST', null), { purpose: 'signin' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps signin identity-only and asks data flows for offline task access', async () => {
    const signin = new URL((await start('signin')).authorizationUrl);
    expect(signin.searchParams.get('scope')).toBe('openid email profile');
    const session = await signIn();
    const tasks = new URL((await start('link', session)).authorizationUrl);
    expect(tasks.searchParams.get('scope')).toContain(GOOGLE_TASKS_SCOPE);
    expect(tasks.searchParams.get('access_type')).toBe('offline');
    expect(tasks.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('consumes the same state once across concurrent callbacks', async () => {
    const started = await start('signin');
    const results = await Promise.allSettled([callback(started), callback(started)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('invalidates a pending authorization when the owner generation changes', async () => {
    const started = await start('signin');
    database.sqlite
      .prepare("UPDATE accounts_installation SET owner_generation='replacement-generation'")
      .run();
    await expect(callback(started)).rejects.toMatchObject({ code: 'forbidden' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('does not restore a grant after its authorization state is invalidated in flight', async () => {
    const session = await signIn();
    const started = await start('link', session);
    identity = { subject: 'secondary-subject', email: 'secondary@example.com' };
    exchange.mockImplementationOnce(async () => {
      database.sqlite.prepare('DELETE FROM accounts_oauth_states').run();
      return grant;
    });
    await expect(callback(started, session)).rejects.toMatchObject({ code: 'conflict' });
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM accounts_connections').get()?.n).toBe(
      0,
    );
  });

  it('limits concurrent oauth starts and does not write again for denied attempts', async () => {
    const send = (ip = '203.0.113.4') => {
      const req = request('/auth/google/start', '', 'POST');
      req.headers.set('CF-Connecting-IP', ip);
      req.headers.set('X-Forwarded-For', randomForwarded++ + '.example');
      return service.startOAuth(req, { purpose: 'signin' });
    };
    let randomForwarded = 0;
    const results = await Promise.allSettled(Array.from({ length: 21 }, () => send()));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(20);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const before = database.sqlite.prepare('SELECT total_changes() AS n').get()?.n;
    for (let i = 0; i < 3; i++)
      await expect(send()).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(database.sqlite.prepare('SELECT total_changes() AS n').get()?.n).toBe(before);
    expect(
      JSON.stringify(database.sqlite.prepare('SELECT * FROM accounts_rate_limits').all()),
    ).not.toContain('203.0.113');
    await expect(send('203.0.113.5')).resolves.toHaveProperty('authorizationUrl');
    now += 10 * 60_000;
    await expect(send()).resolves.toHaveProperty('authorizationUrl');
  });

  it('rechecks session authorization after Google returns', async () => {
    const session = await signIn();
    const started = await start('link', session);
    identity = { subject: 'secondary-subject', email: 'secondary@example.com' };
    exchange.mockImplementationOnce(async () => {
      database.sqlite.prepare('DELETE FROM accounts_sessions').run();
      return grant;
    });
    await expect(callback(started, session)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM accounts_connections').get()?.n).toBe(
      0,
    );
  });
});

describe('linked accounts', () => {
  it('links one immutable subject once and leaves workspace readiness to initialization', async () => {
    const session = await signIn();
    const first = await link(session);
    const second = await link(session);
    expect(second.connectedAccountId).toBe(first.connectedAccountId);
    const accounts = (await service.listConnectionSummaries(request('/', session))).items;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: first.connectedAccountId,
      state: 'connecting',
      planningZone: 'Europe/Istanbul',
      permissions: { tasks: true },
    });
    expect(JSON.stringify(accounts)).not.toContain('refresh-token');
    expect(JSON.stringify(accounts)).not.toContain('access-token');
    expect(accounts[0]?.grantExpiresAt).toBe(new Date(initialNow + 7 * day).toISOString());
  });

  it('does not replace a reconnect target when Google returns a different subject', async () => {
    const session = await signIn();
    const linked = await link(session);
    const before = database.sqlite
      .prepare('SELECT grant_ciphertext,token_revision FROM accounts_connections WHERE id=?')
      .get(linked.connectedAccountId!);
    const started = await start('reconnect', session, linked.connectedAccountId);
    identity = { subject: 'different-subject', email: 'different@example.com' };
    await expect(callback(started, session)).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      database.sqlite
        .prepare('SELECT grant_ciphertext,token_revision FROM accounts_connections WHERE id=?')
        .get(linked.connectedAccountId!),
    ).toEqual(before);
  });

  it('preserves a usable existing refresh token only after the subject is verified', async () => {
    const session = await signIn();
    const linked = await link(session);
    grant = { ...grant, accessToken: 'updated-access', refreshToken: null };
    await link(session);
    const row = database.sqlite
      .prepare('SELECT grant_ciphertext FROM accounts_connections WHERE id=?')
      .get(linked.connectedAccountId!);
    const stored = JSON.parse(
      await decryptToken(
        String(row?.grant_ciphertext),
        config.tokenKey,
        accountGrantContext(linked.connectedAccountId!),
      ),
    ) as Record<string, unknown>;
    expect(stored.refreshToken).toBe('refresh-token');
    expect(stored.accessToken).toBe('updated-access');
    expect(stored.idToken).toBeUndefined();
    expect(exchange.mock.calls.every((call) => call[1].previousRefreshToken === undefined)).toBe(
      true,
    );
  });

  it('leaves task access unchanged when an optional sheets permission is declined', async () => {
    const session = await signIn();
    const linked = await link(session);
    database.sqlite
      .prepare("UPDATE accounts_connections SET state='connected' WHERE id=?")
      .run(linked.connectedAccountId!);
    const before = database.sqlite
      .prepare('SELECT * FROM accounts_connections WHERE id=?')
      .get(linked.connectedAccountId!);
    const started = await start('sheets_import', session, linked.connectedAccountId);
    await expect(callback(started, session)).rejects.toMatchObject({ code: 'permission_required' });
    expect(
      database.sqlite
        .prepare('SELECT * FROM accounts_connections WHERE id=?')
        .get(linked.connectedAccountId!),
    ).toEqual(before);
  });

  it('shows the accepted seven-day task expiry without deleting retained connection data', async () => {
    const session = await signIn();
    const linked = await link(session);
    now += 6 * day;
    const replacementSession = await signIn();
    now += day + 1;
    const accounts = (await service.listConnectionSummaries(request('/', replacementSession)))
      .items;
    expect(accounts[0]).toMatchObject({
      id: linked.connectedAccountId,
      state: 'reconnect_required',
    });
    expect(
      database.sqlite
        .prepare('SELECT grant_ciphertext FROM accounts_connections WHERE id=?')
        .get(linked.connectedAccountId!)?.grant_ciphertext,
    ).not.toBeNull();
  });

  it('paginates account summaries by created time and identity and can select a later account directly', async () => {
    const session = await signIn();
    for (const [id, createdAt] of [
      ['a', now],
      ['b', now],
      ['c', now + 1],
    ] as const) {
      await database.db
        .prepare(
          `INSERT INTO accounts_connections
        (id,google_subject,email,display_name,state,grant_ciphertext,created_at,updated_at)
        VALUES (?,?,?,?,'connected','sensitive-ciphertext',?,?)`,
        )
        .bind(id, 'subject-' + id, id + '@example.com', id, createdAt, createdAt)
        .run();
    }
    const first = await service.listConnectionSummaries(request('/', session), { limit: 2 });
    expect(first.items.map((account) => account.id)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await service.listConnectionSummaries(request('/', session), {
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.items.map((account) => account.id)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain('sensitive-ciphertext');
    await expect(service.getConnectionSummary(request('/', session), 'c')).resolves.toMatchObject({
      id: 'c',
    });
    await expect(
      service.listConnectionSummaries(request('/', session), { limit: 101 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      service.listConnectionSummaries(request('/', session), { cursor: 'bad-cursor' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('updates planning preferences with a revision compare-and-set', async () => {
    const session = await signIn();
    const linked = await link(session);
    const updated = await service.updatePreferences(
      request('/api/preferences', session, 'PATCH'),
      linked.connectedAccountId!,
      { revision: 0, planningZone: 'America/New_York', weekStart: 7 },
    );
    expect(updated).toMatchObject({ planningZone: 'America/New_York', weekStart: 7, revision: 1 });
    await expect(
      service.updatePreferences(
        request('/api/preferences', session, 'PATCH'),
        linked.connectedAccountId!,
        { revision: 0, planningZone: 'UTC' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

it('exports only account identity and preferences through the authenticated portability seam', async () => {
  const cookie = await signIn(),
    linked = await link(cookie);
  const portable = await service.getPortableIdentity(
    request('/', cookie),
    linked.connectedAccountId!,
  );
  expect(portable).toEqual({
    accountId: linked.connectedAccountId,
    googleSubject: 'secondary-subject',
    email: 'secondary-subject@example.com',
    planningZone: 'Europe/Istanbul',
    weekStart: 1,
    revision: 0,
  });
  expect(JSON.stringify(portable)).not.toMatch(/access-token|refresh-token|grant|cipher|session/i);
  await expect(
    service.getPortableIdentity(request(), linked.connectedAccountId!),
  ).rejects.toMatchObject({ code: 'unauthenticated' });
});
