import { afterEach, describe, expect, it, vi } from 'vitest';
import { invocationDatabase } from '../../../tests/support/d1-invocation';
import { seedAccount, testDatabase } from '../../../tests/support/sqlite-d1';
import { createAccountServices } from '../../modules/accounts/server/create-services';
import { encryptToken } from '../../modules/accounts/server/credentials/crypto';
import { accountGrantContext } from '../../modules/accounts/server/credentials/grant-context';
import { BoardService } from '../../modules/boards/server/boards/service';
import { HistoryService } from '../../modules/history/server/events/event-store';
import { SyncForegroundSchema } from '../../modules/tasks/contracts/sync';
import { TaskProjectionStore } from '../../modules/tasks/server/projection/store';
import type { GoogleTaskDTO } from '../../modules/tasks/server/provider/google-tasks';
import { parseConfiguration, type Env } from '../configuration/env';
import { handleRequest } from '../request';

const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((database) => database.close());
});

async function fixture({ expired = false, connecting = false } = {}) {
  const database = testDatabase();
  databases.push(database);
  const now = Date.now();
  const env: Env = {
    DB: database.db,
    ASSETS: { fetch: async () => new Response('public') },
    APP_ORIGIN: 'https://lanes.example',
    OWNER_EMAIL: 'owner@example.com',
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    SESSION_KEY: Buffer.alloc(32, 1).toString('base64url'),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64url'),
  };
  const config = parseConfiguration(env);
  await seedAccount(database.db, 'account', now);
  const accounts = createAccountServices(database.db, config, {
    exchange: async () => ({
      accessToken: 'signin-access',
      refreshToken: null,
      idToken: 'signin-id',
      expiresAt: now + 3600_000,
      scopes: ['openid', 'email', 'profile'],
      tokenType: 'Bearer',
    }),
    verify: async () => ({ subject: 'owner', email: 'owner@example.com', name: 'owner' }),
  });
  const started = await accounts.oauth.startOAuth(
    new Request(`${config.origin}/auth/google/start`, {
      method: 'POST',
      headers: { origin: config.origin },
    }),
    { purpose: 'signin' },
  );
  const finished = await accounts.oauth.finishOAuth(
    new Request(
      `${config.origin}/auth/google/callback?code=test&state=${new URL(started.authorizationUrl).searchParams.get('state')}`,
      { headers: { cookie: started.cookie.split(';')[0]! } },
    ),
  );
  const cookie = finished.cookies.map((value) => value.split(';')[0]).join('; ');
  const scopes = ['https://www.googleapis.com/auth/tasks'];
  const expiresAt = now + (expired ? -1000 : 3600_000);
  const ciphertext = await encryptToken(
    JSON.stringify({
      accessToken: expired ? 'expired-access' : 'fresh-access',
      refreshToken: 'fixture-refresh',
      expiresAt,
      scopes,
      tokenType: 'Bearer',
    }),
    config.tokenKey,
    accountGrantContext('account'),
  );
  await database.db
    .prepare(
      'UPDATE accounts_connections SET state=?,grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=? WHERE id=?',
    )
    .bind(
      connecting ? 'connecting' : 'connected',
      ciphertext,
      JSON.stringify(scopes),
      expiresAt,
      now + 7 * 86400_000,
      'account',
    )
    .run();
  await new BoardService(database.db, {
    assertLocalWritable: async () => {},
  }).ensureMainBoard('account');
  const projection = new TaskProjectionStore(database.db, {
    history: new HistoryService(database.db),
  });
  const lists: { id: string; title: string; etag: string }[] = [];
  const records = new Map<string, GoogleTaskDTO[]>();
  const requests: { queries: number; provider: number; oauth: number }[] = [];
  let provider = 0;
  let oauth = 0;
  let taskPages = 0;
  let beforeRead: ((url: URL) => Promise<Response | void>) | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    provider++;
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') {
      oauth++;
      return Response.json({
        access_token: 'fresh-access',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: scopes.join(' '),
      });
    }
    expect(url.origin).toBe('https://tasks.googleapis.com');
    const intercepted = await beforeRead?.(url);
    if (intercepted) return intercepted;
    if (url.pathname.endsWith('/lists/@default')) return Response.json(lists[0]);
    if (url.pathname.endsWith('/users/@me/lists')) {
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const end = offset + Number(url.searchParams.get('maxResults') ?? 25);
      return Response.json({
        items: lists.slice(offset, end),
        ...(end < lists.length ? { nextPageToken: String(end) } : {}),
      });
    }
    const match = url.pathname.match(/\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
    const values = match ? records.get(match[1]!) : undefined;
    if (values && match?.[2]) {
      const task = values.find((task) => task.id === match[2]);
      return task ? Response.json(task) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    if (values) {
      taskPages++;
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const end = offset + Number(url.searchParams.get('maxResults') ?? 25);
      return Response.json({
        items: values.slice(offset, end),
        ...(end < values.length ? { nextPageToken: String(end) } : {}),
      });
    }
    throw new Error('unexpected sync address: ' + url.pathname);
  });

  async function addList(id: string, count: number, retained = true) {
    const list = { id: `google-${id}`, title: id, etag: 'list-v1' };
    lists.push(list);
    const tasks: GoogleTaskDTO[] = Array.from({ length: count }, (_, index) => ({
      id: `${list.id}-task-${index}`,
      title: `task ${index}`,
      etag: 'task-v1',
      status: 'needsAction',
      position: String(index).padStart(3, '0'),
    }));
    records.set(list.id, tasks);
    if (!retained) return;
    await database.db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,provider_etag,is_default,tasks_complete_at,completed_complete_at,last_full_sync_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        'account',
        list.id,
        list.title,
        list.title,
        list.etag,
        Number(lists.length === 1),
        now,
        now,
        now,
      )
      .run();
    for (let offset = 0; offset < tasks.length; offset += 4)
      await database.db.batch(
        (await projection.prepareConfirmedWrites('account', id, tasks.slice(offset, offset + 4)))
          .writes,
      );
    await database.db
      .prepare(
        'UPDATE tasks_account_state SET inventory_complete_at=?,inventory_count=? WHERE account_id=?',
      )
      .bind(now, lists.length, 'account')
      .run();
  }

  async function send(first = false) {
    provider = 0;
    oauth = 0;
    const invocation = invocationDatabase(database.db);
    const response = await handleRequest(
      new Request(
        `${config.origin}/api/accounts/account/sync${first ? '' : '/advance'}?status=1&changes=1`,
        {
          method: 'POST',
          headers: {
            cookie,
            origin: config.origin,
            'x-lanes-api': '1',
            'content-type': 'application/json',
          },
          body: JSON.stringify(first ? { reason: 'entry' } : {}),
        },
      ),
      { ...env, DB: invocation.db },
    );
    requests.push({ queries: invocation.queries, provider, oauth });
    expect(invocation.queries).toBeLessThanOrEqual(50);
    expect(provider).toBeLessThanOrEqual(10);
    return response;
  }

  async function call(first = false) {
    const response = await send(first);
    expect(response.status, await response.clone().text()).toBe(200);
    return SyncForegroundSchema.parse(await response.json());
  }

  async function finish() {
    const steps = [await call(true)];
    for (let index = 0; steps.at(-1)!.status.pending && index < 40; index++)
      steps.push(await call());
    expect(steps.at(-1)!.status.pending).toBe(false);
    return steps;
  }

  return {
    ...database,
    now,
    addList,
    records,
    requests,
    call,
    send,
    finish,
    taskPageCount: () => taskPages,
    beforeRead: (callback: typeof beforeRead) => (beforeRead = callback),
  };
}

describe('authenticated foreground sync budget', () => {
  it.each([false, true])(
    'combines an unchanged three-list board within full invocation limits with expired=%s',
    async (expired) => {
      const f = await fixture({ expired });
      await f.addList('todo', 6);
      await f.addList('progress', 4);
      await f.addList('done', 15);
      const steps = await f.finish();
      expect(steps.length).toBeLessThan(5);
      expect(f.taskPageCount()).toBe(3);
      expect(steps.every((step) => !step.changes.topology && !step.changes.tasks)).toBe(true);
      expect(f.requests.reduce((sum, request) => sum + request.oauth, 0)).toBe(Number(expired));
    },
  );

  it('initializes a connecting account with expired OAuth and resumable new task pages', async () => {
    const f = await fixture({ expired: true, connecting: true });
    await f.addList('todo', 25, false);
    const steps = await f.finish();
    expect(steps.at(-1)!.status.initialized).toBe(true);
    expect(steps.some((step) => step.changes.topology)).toBe(true);
    expect(steps.some((step) => step.changes.tasks)).toBe(true);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(25);
    expect(
      await f.db
        .prepare("SELECT state FROM accounts_connections WHERE id='account'")
        .first('state'),
    ).toBe('connected');
    expect(f.requests.reduce((sum, request) => sum + request.oauth, 0)).toBe(1);
  });

  it('paginates a full list inventory while preserving enough budget to return status', async () => {
    const f = await fixture({ expired: true });
    for (let index = 0; index < 25; index++) await f.addList(`list-${index}`, 0);
    const steps = await f.finish();
    expect(steps.at(-1)!.status.initialized).toBe(true);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_lists').first('n')).toBe(25);
    expect(steps.every((step) => !step.changes.topology && !step.changes.tasks)).toBe(true);
  });

  it('resolves live address collisions with an OAuth refresh inside the shared budget', async () => {
    const f = await fixture({ expired: true });
    await f.addList('source', 4);
    await f.addList('destination', 0);
    f.records.set('google-destination', f.records.get('google-source')!);
    await f.db
      .prepare(
        'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending) VALUES (?,?,?,0,0)',
      )
      .bind('account', f.now, f.now)
      .run();
    await f.db
      .prepare('INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES (?,?,?)')
      .bind('account', 'destination', f.now)
      .run();
    let step = await f.call();
    for (let index = 0; step.status.pending && index < 8; index++) step = await f.call();
    expect(step.status.pending).toBe(false);
    expect(
      await f.db.prepare("SELECT COUNT(*) AS n FROM tasks_tasks WHERE list_id='source'").first('n'),
    ).toBe(4);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM tasks_tasks WHERE list_id='destination'")
        .first('n'),
    ).toBe(4);
    expect(f.requests[0]!.provider).toBe(10);
    expect(f.requests[0]!.oauth).toBe(1);
  });

  it('stops provider reads when the account disconnects between foreground claims', async () => {
    const f = await fixture();
    await f.addList('todo', 0);
    await f.db
      .prepare('INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at) VALUES (?,?,?)')
      .bind('account', f.now, f.now)
      .run();
    f.beforeRead(async (url) => {
      if (url.pathname.endsWith('/lists/@default'))
        await f.db
          .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='account'")
          .run();
    });
    const response = await f.send();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
    expect(f.requests[0]!.provider).toBe(1);
    expect(
      await f.db
        .prepare('SELECT default_pending,inventory_pending,claim_id FROM tasks_sync_jobs')
        .first(),
    ).toEqual({ default_pending: 0, inventory_pending: 1, claim_id: null });
  });

  it('rolls back a stale projection without exceeding the full collision and OAuth budget', async () => {
    const f = await fixture({ expired: true });
    await f.addList('source', 4);
    await f.addList('destination', 0);
    f.records.set('google-destination', f.records.get('google-source')!);
    await f.db
      .prepare(
        'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending) VALUES (?,?,?,0,0)',
      )
      .bind('account', f.now, f.now)
      .run();
    await f.db
      .prepare('INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES (?,?,?)')
      .bind('account', 'destination', f.now)
      .run();
    f.beforeRead(async (url) => {
      if (url.pathname.endsWith('/lists/google-destination/tasks'))
        await f.db
          .prepare(
            "UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id='destination'",
          )
          .run();
    });
    const response = await f.send();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
    expect(f.requests[0]!.provider).toBe(10);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM tasks_tasks WHERE list_id='destination'")
        .first('n'),
    ).toBe(0);
    expect(
      await f.db.prepare('SELECT page_offset,page_json FROM tasks_sync_list_work').first(),
    ).toEqual({ page_offset: 0, page_json: null });
    expect(await f.db.prepare('SELECT claim_id,error_code FROM tasks_sync_jobs').first()).toEqual({
      claim_id: null,
      error_code: 'conflict',
    });
  });

  it('retains an earlier committed slice and its changes when a later slice needs OAuth repair', async () => {
    const f = await fixture();
    await f.addList('todo', 0);
    await f.db.prepare("UPDATE tasks_lists SET title='old title' WHERE id='todo'").run();
    await f.db
      .prepare('INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at) VALUES (?,?,?)')
      .bind('account', f.now, f.now)
      .run();
    f.beforeRead(async (url) => {
      if (url.pathname.endsWith('/users/@me/lists'))
        return Response.json({ error: { code: 401 } }, { status: 401 });
    });
    const step = await f.call();
    expect(step.status.pending).toBe(true);
    expect(step.status.nextAttemptAt).toBeGreaterThan(f.now);
    expect(step.changes).toEqual({ topology: true, tasks: false });
    expect(await f.db.prepare("SELECT title FROM tasks_lists WHERE id='todo'").first('title')).toBe(
      'todo',
    );
    expect(
      await f.db
        .prepare('SELECT default_pending,inventory_pending,claim_id FROM tasks_sync_jobs')
        .first(),
    ).toEqual({ default_pending: 0, inventory_pending: 1, claim_id: null });
  });

  it('keeps the committed slice and retry checkpoint when a later provider read fails', async () => {
    const f = await fixture();
    await f.addList('todo', 0);
    await f.db.prepare("UPDATE tasks_lists SET title='old title' WHERE id='todo'").run();
    await f.db
      .prepare('INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at) VALUES (?,?,?)')
      .bind('account', f.now, f.now)
      .run();
    f.beforeRead(async (url) => {
      if (url.pathname.endsWith('/users/@me/lists'))
        return Response.json({ error: { code: 500 } }, { status: 500 });
    });
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'provider_unavailable' } });
    expect(await f.db.prepare("SELECT title FROM tasks_lists WHERE id='todo'").first('title')).toBe(
      'todo',
    );
    expect(
      await f.db
        .prepare(
          'SELECT default_pending,inventory_pending,claim_id,error_code FROM tasks_sync_jobs',
        )
        .first(),
    ).toEqual({
      default_pending: 0,
      inventory_pending: 1,
      claim_id: null,
      error_code: 'provider_unavailable',
    });
  });
});
