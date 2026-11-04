import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../tests/support/sqlite-d1';
import { invocationDatabase } from '../../../tests/support/d1-invocation';
import {
  AccountService,
  accountGrantContext,
} from '../../modules/accounts/server/oauth/account-service';
import { encryptToken } from '../../modules/accounts/server/credentials/crypto';
import { BoardService } from '../../modules/boards/server/boards/service';
import { accountToday } from '../../modules/tasks/model/planning';
import { parseConfiguration, type Env } from '../configuration/env';
import worker, { handleRequest } from '../index';
import { OperationStore } from '../../modules/operations/server/journal/store';
import type { ImportSummary } from '../../modules/transfer/contracts/import';
import type { CompletedDeletionSummary } from '../../modules/tasks/contracts/completed-deletion';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => open.splice(0).forEach((database) => database.close()));
async function fixture() {
  const database = testDatabase();
  open.push(database);
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
  await seedAccount(database.db, 'account-a');
  await seedAccount(database.db, 'account-b');
  const auth = new AccountService(database.db, config, {
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
  const start = await auth.startOAuth(
    new Request(config.origin + '/auth/google/start', {
      method: 'POST',
      headers: { origin: config.origin },
    }),
    { purpose: 'signin' },
  );
  const state = new URL(start.authorizationUrl).searchParams.get('state');
  const finished = await auth.finishOAuth(
    new Request(`${config.origin}/auth/google/callback?code=test&state=${state}`, {
      headers: { cookie: start.cookie.split(';')[0]! },
    }),
  );
  const cookie = finished.cookies.map((value) => value.split(';')[0]).join('; ');
  const boards = new BoardService(database.db, { assertLocalWritable: async () => {} });
  const main = await boards.ensureMainBoard('account-a');
  await boards.ensureMainBoard('account-b');
  const requestQueries: { path: string; queries: number }[] = [];
  const scheduledQueries: { start: number; queries: number }[] = [];
  const scheduledFrom = async (start: number) => {
    let turn = 1;
    while (turn % 10 === 0 || (turn - Math.floor(turn / 10) - 1) % 12 !== start) turn++;
    await database.db
      .prepare('UPDATE worker_scheduler SET turn=? WHERE singleton=1')
      .bind(turn - 1)
      .run();
    const invocation = invocationDatabase(database.db);
    try {
      await worker.scheduled({ scheduledTime: Date.now() }, { ...env, DB: invocation.db });
    } finally {
      scheduledQueries.push({ start, queries: invocation.queries });
    }
    expect(invocation.queries).toBeLessThanOrEqual(50);
  };
  const call = async (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const invocation = invocationDatabase(database.db);
    const response = await handleRequest(
      new Request(config.origin + path, {
        method,
        headers: {
          cookie,
          origin: config.origin,
          'x-lanes-api': '1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { ...env, DB: invocation.db },
    );
    requestQueries.push({ path, queries: invocation.queries });
    return response;
  };
  return { ...database, env, call, main, requestQueries, scheduledFrom, scheduledQueries };
}
describe('authenticated workspace composition', () => {
  it('finishes a four-candidate sync page with OAuth refresh and both live addresses within ten provider requests', async () => {
    const f = await fixture();
    const now = Date.now();
    const scopes = ['https://www.googleapis.com/auth/tasks'];
    const grant = await encryptToken(
      JSON.stringify({
        accessToken: 'expired-access',
        refreshToken: 'fixture-refresh',
        expiresAt: now - 1000,
        scopes,
        tokenType: 'Bearer',
      }),
      parseConfiguration(f.env).tokenKey,
      accountGrantContext('account-a'),
    );
    await f.db
      .prepare(
        'UPDATE accounts_connections SET grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=? WHERE id=?',
      )
      .bind(grant, JSON.stringify(scopes), now - 1000, now + 7 * 86400000, 'account-a')
      .run();
    for (const [id, providerId, isDefault] of [
      ['source', 'google-source', 1],
      ['destination', 'google-destination', 0],
    ] as const) {
      await f.db
        .prepare(
          'INSERT INTO tasks_lists(id,account_id,provider_id,title,is_default,tasks_complete_at,completed_complete_at,last_full_sync_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(id, 'account-a', providerId, id, isDefault, now, now, now)
        .run();
    }
    const records = Array.from({ length: 4 }, (_, index) => ({
      id: `google-task-${index}`,
      title: `task ${index}`,
      etag: `version-${index}`,
      status: 'needsAction',
    }));
    for (const [index, task] of records.entries())
      await f.db
        .prepare(
          'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,provider_etag) VALUES (?,?,?,?,?,?)',
        )
        .bind(`source-task-${index}`, 'account-a', 'source', task.id, task.title, task.etag)
        .run();
    await f.db
      .prepare(
        'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending) VALUES (?,?,?,0,0)',
      )
      .bind('account-a', now, now)
      .run();
    await f.db
      .prepare('INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES (?,?,?)')
      .bind('account-a', 'destination', now)
      .run();
    const requests: string[] = [];
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.href);
      if (url.href === 'https://oauth2.googleapis.com/token') {
        expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe(
          'fixture-refresh',
        );
        return Response.json({
          access_token: 'fresh-access',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: scopes.join(' '),
        });
      }
      expect(url.origin).toBe('https://tasks.googleapis.com');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fresh-access');
      if (url.pathname.endsWith('/lists/google-destination/tasks')) {
        expect(url.searchParams.get('maxResults')).toBe('4');
        return Response.json({ items: records });
      }
      const task = records.find((task) => url.pathname.endsWith('/tasks/' + task.id));
      if (task && /\/lists\/google-(?:source|destination)\/tasks\//.test(url.pathname))
        return Response.json(task);
      throw new Error('unexpected sync provider request: ' + url.href);
    });
    try {
      const response = await f.call('/api/accounts/account-a/sync/advance', {});
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        accountId: 'account-a',
        phase: 'tasks',
        continued: false,
      });
      expect(requests).toHaveLength(10);
      expect(
        requests.filter((url) => url.startsWith('https://oauth2.googleapis.com/')),
      ).toHaveLength(1);
      expect(requests.filter((url) => url.includes('/lists/google-source/tasks/'))).toHaveLength(4);
      expect(
        requests.filter((url) => url.includes('/lists/google-destination/tasks/')),
      ).toHaveLength(4);
      expect(
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id='account-a' AND list_id='destination'",
          )
          .first('n'),
      ).toBe(4);
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM tasks_sync_jobs WHERE account_id='account-a'")
          .first('n'),
      ).toBe(0);
      expect(f.requestQueries.at(-1)!.queries).toBeLessThanOrEqual(50);
    } finally {
      provider.mockRestore();
    }
  });
  it('validates a full 2000-task dependency-chain import through authenticated bounded HTTP checkpoints before its first provider write', async () => {
    const f = await fixture(),
      now = Date.now(),
      id = `${now}:${'h'.repeat(32)}`,
      totalTasks = 2000;
    const scopes = ['https://www.googleapis.com/auth/tasks'];
    const grant = await encryptToken(
      JSON.stringify({
        accessToken: 'fixture-access',
        refreshToken: null,
        expiresAt: now + 3600000,
        scopes,
        tokenType: 'Bearer',
      }),
      parseConfiguration(f.env).tokenKey,
      accountGrantContext('account-a'),
    );
    await f.db
      .prepare(
        'UPDATE accounts_connections SET grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=? WHERE id=?',
      )
      .bind(grant, JSON.stringify(scopes), now + 3600000, now + 7 * 86400000, 'account-a')
      .run();
    let confirmed = false;
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(confirmed).toBe(true);
      expect(url.origin).toBe('https://tasks.googleapis.com');
      const captured = await f.db
        .prepare(
          "SELECT json_extract(copy_context_json,'$.sealed') AS sealed FROM tasks_command_plans WHERE operation_id=?",
        )
        .bind(id)
        .first('sealed');
      expect(captured).toBe(1);
      expect(
        await f.db
          .prepare('SELECT input_sealed FROM tasks_operations WHERE id=?')
          .bind(id)
          .first('input_sealed'),
      ).toBe(1);
      if (init?.method === 'POST' && url.pathname === '/tasks/v1/users/@me/lists')
        return Response.json({ id: 'imported-google-list', title: 'whole chain', etag: 'list-v1' });
      throw new Error('unexpected provider request during first-write checkpoint');
    });
    const base = '/api/accounts/account-a/transfer/imports',
      path = base + '/' + encodeURIComponent(id);
    const call = async (suffix: string, input: unknown, status = 200) => {
      const response = await f.call(path + suffix, input);
      expect(response.status, await response.clone().text()).toBe(status);
      return (await response.json()) as ImportSummary;
    };
    const admitted = await f.call(base, {
      id,
      source: { kind: 'file', name: 'whole-chain.csv', format: 'csv' },
      destination: { kind: 'new', boardId: f.main.id, boardRevision: f.main.revision },
      totalLists: 1,
      totalTasks,
    });
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    await call('/chunks', { lists: [{ position: 0, value: { key: 'l1', title: 'whole chain' } }] });
    for (let offset = 0; offset < totalTasks; offset += 10)
      await call('/chunks', {
        tasks: Array.from({ length: 10 }, (_, index) => {
          const position = offset + index;
          return {
            position,
            value: {
              key: 't' + (position + 1),
              listKey: 'l1',
              parentKey: null,
              title: 'task ' + (position + 1),
              notes: 'captured note ' + (position + 1),
              completed: false,
              completedAt: null,
              labels: [],
              priority: 'none',
              starred: false,
              dependencies: position ? ['t' + position] : [],
              order: position,
            },
          };
        }),
      });
    let summary = await call('/preview', {}),
      previewSlices = 1;
    while (summary.state === 'staging' && previewSlices++ < 600)
      summary = await call('/preview', {});
    expect(summary).toMatchObject({
      state: 'preview',
      capturedTasks: totalTasks,
      totalTasks,
      errorCount: 0,
      warningCount: 0,
    });
    expect(summary.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(provider).not.toHaveBeenCalled();
    summary = await call('/confirm', { previewHash: summary.previewHash }, 202);
    expect(summary).toMatchObject({ state: 'capturing', capturedTasks: totalTasks });
    expect(provider).not.toHaveBeenCalled();
    confirmed = true;
    let advanceSlices = 0,
      sawValidationCheckpoint = false,
      scheduledStarts = 0;
    while (!provider.mock.calls.length && advanceSlices++ < 800) {
      summary = await call('/advance', {});
      expect(summary.paused).toBe(false);
      const graph = await f.db
        .prepare('SELECT stage FROM tasks_command_copy_validation WHERE operation_id=?')
        .bind(id)
        .first<{ stage: string }>();
      if (graph && graph.stage !== 'ready') {
        sawValidationCheckpoint = true;
        expect(summary.state).toBe('capturing');
        expect(provider).not.toHaveBeenCalled();
        if (graph.stage === 'checking' && scheduledStarts < 12)
          await f.scheduledFrom(scheduledStarts++);
      }
    }
    expect(sawValidationCheckpoint).toBe(true);
    expect(scheduledStarts).toBe(12);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ state: 'running', capturedTasks: totalTasks, totalTasks });
    expect(
      await f.db
        .prepare('SELECT COUNT(*) AS n FROM tasks_command_copy_entries WHERE operation_id=?')
        .bind(id)
        .first('n'),
    ).toBe(totalTasks);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_operation_steps WHERE operation_id=? AND kind='task.create'",
        )
        .bind(id)
        .first('n'),
    ).toBe(totalTasks);
    expect(
      await f.db
        .prepare(
          "SELECT json_extract(input_json,'$.notes') AS notes FROM tasks_command_copy_entries WHERE operation_id=? AND item_key='t2000'",
        )
        .bind(id)
        .first('notes'),
    ).toBe('captured note 2000');
    expect(
      await f.db
        .prepare('SELECT checked_tasks FROM tasks_command_copy_validation WHERE operation_id=?')
        .bind(id)
        .first('checked_tasks'),
    ).toBe(totalTasks);
    const maxima = Object.fromEntries(
      ['chunks', 'preview', 'confirm', 'advance'].map((phase) => [
        phase,
        Math.max(
          ...f.requestQueries
            .filter((item) => item.path.endsWith('/' + phase))
            .map((item) => item.queries),
        ),
      ]),
    );
    for (const queries of Object.values(maxima)) {
      expect(queries).toBeGreaterThan(0);
      expect(queries).toBeLessThanOrEqual(50);
    }
    // Query limits bound each request; allow runner slack for the full checkpoint sequence.
  }, 90000);
  it('advances confirmed two-root completed deletion through actual scheduled workers from every work-family cursor within the D1 budget', async () => {
    const allStats: { start: number; queries: number }[] = [];
    for (const { start, refresh } of [
      ...Array.from({ length: 12 }, (_, start) => ({ start, refresh: false })),
      { start: 1, refresh: true },
    ]) {
      const f = await fixture(),
        now = Date.now(),
        id = `${now}:${String(start).padStart(2, '0')}${'j'.repeat(30)}`,
        scopes = ['https://www.googleapis.com/auth/tasks'];
      const grant = await encryptToken(
        JSON.stringify({
          accessToken: 'fixture-access',
          refreshToken: refresh ? 'fixture-refresh' : null,
          expiresAt: refresh ? now - 1000 : now + 3600000,
          scopes,
          tokenType: 'Bearer',
        }),
        parseConfiguration(f.env).tokenKey,
        accountGrantContext('account-a'),
      );
      await f.db
        .prepare(
          'UPDATE accounts_connections SET grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=? WHERE id=?',
        )
        .bind(
          grant,
          JSON.stringify(scopes),
          refresh ? now - 1000 : now + 3600000,
          now + 7 * 86400000,
          'account-a',
        )
        .run();
      await f.db
        .prepare(
          "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at,last_full_sync_at)VALUES('delete-list','account-a','google-delete-list','completed roots',1,?,?,?)",
        )
        .bind(now, now, now)
        .run();
      await f.db
        .prepare(
          "INSERT INTO boards_memberships(account_id,list_id,board_id,position)VALUES('account-a','delete-list',?,0)",
        )
        .bind(f.main.id)
        .run();
      const tasks = new Map(
        ['one', 'two'].map((key) => [
          key,
          {
            id: key,
            title: key,
            status: 'completed',
            completed: new Date(now).toISOString(),
            etag: 'v1',
          },
        ]),
      );
      for (const item of tasks.values())
        await f.db
          .prepare(
            "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,completed,completed_at,provider_etag,revision)VALUES(?,'account-a','delete-list',?,?,1,?,'v1',1)",
          )
          .bind(item.id, item.id, item.title, item.completed)
          .run();
      const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input)),
          key = decodeURIComponent(url.pathname.split('/').at(-1)!);
        if (url.href === 'https://oauth2.googleapis.com/token') {
          expect(refresh).toBe(true);
          return Response.json({
            access_token: 'renewed-fixture-access',
            expires_in: 3600,
            scope: scopes.join(' '),
            token_type: 'Bearer',
          });
        }
        expect(url.origin).toBe('https://tasks.googleapis.com');
        if ((init?.method ?? 'GET') === 'GET')
          return tasks.has(key)
            ? Response.json(tasks.get(key))
            : Response.json({ error: {} }, { status: 404 });
        if (init?.method === 'DELETE') {
          tasks.delete(key);
          return new Response(null, { status: 204 });
        }
        throw new Error('unexpected completed deletion request');
      });
      const base = '/api/accounts/account-a/lists/delete-list/completed-deletions',
        path = base + '/' + encodeURIComponent(id);
      const begun = await f.call(base, { id, listRevision: 1 });
      expect(begun.status, await begun.clone().text()).toBe(202);
      let summary = (await begun.json()) as CompletedDeletionSummary;
      for (let n = 0; n < 10 && summary.state === 'capturing'; n++) {
        const response = await f.call(path + '/capture', {});
        expect(response.status, await response.clone().text()).toBe(200);
        summary = (await response.json()) as CompletedDeletionSummary;
      }
      expect(summary).toMatchObject({ state: 'preview', rootCount: 2, totalDeleteCount: 2 });
      const callsBefore = provider.mock.calls.length,
        refreshCallsBefore = provider.mock.calls.filter(
          (item) => String(item[0]) === 'https://oauth2.googleapis.com/token',
        ).length;
      const confirmed = await f.call(path + '/confirm', {
        previewHash: summary.previewHash,
        confirm: true,
        confirmOpenDescendantCount: 0,
        confirmAssignedTaskCount: 0,
      });
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      expect(provider.mock.calls.length).toBe(callsBefore);
      for (let n = 0; n < 15 && summary.state !== 'finished'; n++) {
        await f.scheduledFrom(start);
        const read = await f.call(path);
        expect(read.status, await read.clone().text()).toBe(200);
        summary = (await read.json()) as CompletedDeletionSummary;
        expect(summary.state).not.toBe('paused');
        expect(summary.state).not.toBe('uncertain');
      }
      expect(
        summary,
        JSON.stringify({
          refresh,
          summary,
          scheduled: f.scheduledQueries,
          operations: (
            await f.db.prepare('SELECT state,error_code,error_message FROM tasks_operations').all()
          ).results,
        }),
      ).toMatchObject({ state: 'finished', deletedCount: 2, deletedRootCount: 2 });
      expect(tasks.size).toBe(0);
      expect(
        provider.mock.calls.filter(
          (item) => String(item[0]) === 'https://oauth2.googleapis.com/token',
        ).length - refreshCallsBefore,
      ).toBe(refresh ? 1 : 0);
      allStats.push(...f.scheduledQueries);
    }
    expect(new Set(allStats.map((item) => item.start)).size).toBe(12);
    expect(Math.max(...allStats.map((item) => item.queries))).toBeLessThanOrEqual(50);
  }, 30000);
  it('reopens a historical completed task given a new repeat rule within the HTTP query budget', async () => {
    const { call, db, env, main } = await fixture();
    const now = Date.now(),
      scopes = ['https://www.googleapis.com/auth/tasks'];
    const grant = await encryptToken(
      JSON.stringify({
        accessToken: 'fixture-access',
        refreshToken: null,
        expiresAt: now + 3600_000,
        scopes,
        tokenType: 'Bearer',
      }),
      parseConfiguration(env).tokenKey,
      accountGrantContext('account-a'),
    );
    await db
      .prepare(
        'UPDATE accounts_connections SET grant_ciphertext=?,scopes_json=?,access_expires_at=?,grant_expires_at=? WHERE id=?',
      )
      .bind(grant, JSON.stringify(scopes), now + 3600_000, now + 7 * 86_400_000, 'account-a')
      .run();
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,tasks_complete_at,completed_complete_at,last_full_sync_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind('list', 'account-a', 'google-list', 'home', now, now, now)
      .run();
    await db
      .prepare(
        'INSERT INTO boards_memberships(account_id,list_id,board_id,position) VALUES (?,?,?,0)',
      )
      .bind('account-a', 'list', main.id)
      .run();
    let task: Record<string, unknown> | null = null,
      etag = 1;
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET';
      if (url.origin !== 'https://tasks.googleapis.com')
        throw new Error('unexpected provider destination');
      if (method === 'GET' && url.pathname.endsWith('/lists/google-list'))
        return Response.json({ id: 'google-list', title: 'home', etag: 'list-1' });
      if (method === 'POST' && url.pathname.endsWith('/tasks')) {
        task = {
          id: 'google-task',
          title: '',
          notes: '',
          status: 'needsAction',
          position: '1',
          ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
          etag: 'v' + etag++,
        };
        if (task.due === null) delete task.due;
        return Response.json(task);
      }
      if (!task) return Response.json({ error: {} }, { status: 404 });
      if (method === 'PATCH') {
        Object.assign(task, JSON.parse(String(init?.body)), { etag: 'v' + etag++ });
        for (const key of ['due', 'completed']) if (task[key] === null) delete task[key];
      }
      return Response.json(task);
    });
    let serial = 0;
    const submit = async (command: unknown) => {
      const operationId = `${Date.now()}:${String(++serial).repeat(32)}`;
      const admitted = await call('/api/accounts/account-a/commands/provider', {
        operationId,
        command,
      });
      expect(admitted.status, await admitted.clone().text()).toBe(202);
      for (let turn = 0; turn < 10; turn++) {
        const response = await call(
          `/api/accounts/account-a/operations/${encodeURIComponent(operationId)}/advance`,
          {},
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const body = (await response.json()) as { finished: boolean; state: string };
        if (body.finished) {
          expect(body.state).toBe('succeeded');
          return;
        }
      }
      throw new Error('provider operation did not settle');
    };
    await submit({
      kind: 'task.create',
      listId: 'list',
      listRevision: 0,
      title: 'a historical task',
    });
    const read = async () =>
      await db
        .prepare('SELECT id,revision FROM tasks_tasks WHERE provider_id=?')
        .bind('google-task')
        .first<{ id: string; revision: number }>();
    let current = (await read())!;
    await submit({
      kind: 'task.complete',
      taskId: current.id,
      revision: current.revision,
      confirmOpenSubtaskCount: 0,
    });
    current = (await read())!;
    await submit({
      kind: 'task.edit',
      taskId: current.id,
      revision: current.revision,
      patch: {
        scheduledDay: '2026-11-03',
        repeatRule: { frequency: 'daily', interval: 1, anchorDay: '2026-11-03', zone: 'UTC' },
      },
    });
    current = (await read())!;
    expect(
      await (await call(`/api/accounts/account-a/tasks/${current.id}/recurrence`)).json(),
    ).toMatchObject({ occurrenceId: null });
    await submit({ kind: 'task.reopen', taskId: current.id, revision: current.revision });
    expect(await (await call(`/api/accounts/account-a/tasks/${current.id}`)).json()).toMatchObject({
      completed: false,
    });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM tasks_recurrence_occurrences').first('n'),
    ).toBe(0);
    expect(provider.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('disconnects and removes only one local account while retaining its authorized completion receipt', async () => {
    const { call, db } = await fixture();
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no provider request expected'));
    const start = await call('/api/accounts/account-a/lifecycle/disconnect', { confirm: true });
    expect(start.status).toBe(202);
    let disconnected = false;
    for (let turn = 0; turn < 30; turn++) {
      const response = await call('/api/accounts/account-a/lifecycle/disconnect/advance', {});
      expect(response.status).toBe(200);
      const body = (await response.json()) as { pending: boolean; state: string };
      if (!body.pending) {
        expect(body.state).toBe('disconnected');
        disconnected = true;
        break;
      }
    }
    expect(disconnected).toBe(true);
    const current = (await (await call('/api/accounts/account-a')).json()) as { revision: number };
    expect(
      (
        await call('/api/accounts/account-a/lifecycle/remove', {
          confirm: true,
          revision: current.revision,
        })
      ).status,
    ).toBe(202);
    let completed = false;
    for (let turn = 0; turn < 100; turn++) {
      const response = await call('/api/accounts/account-a/lifecycle/remove/advance', {});
      expect(response.status).toBe(200);
      if (((await response.json()) as { state: string }).state === 'completed') {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect((await call('/api/accounts/account-a')).status).toBe(404);
    const receipt = await call('/api/accounts/account-a/lifecycle');
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({
      removal: { state: 'completed', accountId: 'account-a' },
    });
    expect((await call('/api/accounts/account-b')).status).toBe(200);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE account_id='account-b'")
        .first('n'),
    ).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });
  it('stages a bounded transfer under server-owned actor and account references without provider writes', async () => {
    const { call, db, main } = await fixture();
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('preview cannot use provider transport'));
    const input = {
      id: `${Date.now()}:${'f'.repeat(32)}`,
      source: { kind: 'file', name: 'notes.csv', format: 'csv' },
      destination: { kind: 'new', boardId: main.id, boardRevision: main.revision },
      totalLists: 1,
      totalTasks: 1,
    };
    expect(
      (await call('/api/accounts/account-a/transfer/imports', { ...input, ownerSubject: 'forged' }))
        .status,
    ).toBe(400);
    const start = await call('/api/accounts/account-a/transfer/imports', input);
    expect(start.status).toBe(202);
    expect(await start.json()).toMatchObject({ state: 'staging', totalTasks: 1 });
    const path = '/api/accounts/account-a/transfer/imports/' + encodeURIComponent(input.id);
    expect(
      (
        await call(path + '/chunks', {
          lists: [{ position: 0, value: { key: 'l1', title: 'notes' } }],
          tasks: [
            {
              position: 0,
              value: {
                key: 't1',
                listKey: 'l1',
                parentKey: null,
                title: 'a task',
                notes: 'private task note',
                completed: false,
                completedAt: null,
                labels: [],
                priority: 'none',
                starred: false,
                dependencies: [],
                order: 0,
              },
            },
          ],
        })
      ).status,
    ).toBe(200);
    const preview = await call(path + '/preview', {});
    expect(await preview.json()).toMatchObject({
      state: 'preview',
      capturedTasks: 1,
      requiredListSlots: 1,
      errorCount: 0,
    });
    expect(
      (await call('/api/accounts/account-b/transfer/imports/' + encodeURIComponent(input.id)))
        .status,
    ).toBe(404);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_lists').first('n')).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });
  it('exposes only allowlisted confirmed result references from a paginated operation', async () => {
    const { call, db } = await fixture();
    const operations = new OperationStore(db),
      now = Date.now(),
      id = `${now}:${'g'.repeat(32)}`;
    await operations.admit(
      {
        id,
        accountId: 'account-a',
        ownerSubject: 'owner',
        kind: 'test',
        resourceKey: 'refs',
        input: { notes: 'private captured note' },
        steps: [{ key: 'one', kind: 'task.local', input: { token: 'private-input' } }],
      },
      now,
    );
    await operations.claimNext(id, 'worker', now);
    await operations.commitLocalStep(
      id,
      'one',
      'worker',
      { taskId: 'confirmed-task', listId: 'confirmed-list', token: 'never-return-this' },
      [],
      now,
    );
    const response = await call(
      '/api/accounts/account-a/operations/' + encodeURIComponent(id) + '/steps',
    );
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      items: [{ taskId: 'confirmed-task', listId: 'confirmed-list', state: 'confirmed' }],
    });
    expect(body).not.toContain('never-return-this');
    expect(body).not.toContain('private-input');
    expect(body).not.toContain('private captured note');
    expect(
      (await call('/api/accounts/account-b/operations/' + encodeURIComponent(id) + '/steps'))
        .status,
    ).toBe(404);
  });
  it('queries the explicit account in its planning zone and never returns another account task', async () => {
    const { db, call, main } = await fixture();
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key) VALUES('list','account-a','google-list','notes','notes')",
      )
      .run();
    await db
      .prepare(
        'INSERT INTO boards_memberships(account_id,list_id,board_id,position) VALUES(?,?,?,0)',
      )
      .bind('account-a', 'list', main.id)
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,scheduled_day) VALUES('task','account-a','list','google-task','today task',?)",
      )
      .bind(accountToday('UTC'))
      .run();
    const result = await call('/api/accounts/account-a/tasks/query', {
      filter: { scheduled: { kind: 'today' } },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      items: [{ id: 'task', accountId: 'account-a', title: 'today task' }],
    });
    expect((await call('/api/accounts/account-b/tasks/task')).status).toBe(404);
    const resolved = await call('/api/accounts/account-b/tasks/resolve', { ids: ['task'] });
    expect(await resolved.json()).toEqual({ items: [] });
  });
  it('replays a board create receipt rather than creating another board', async () => {
    const { call, db } = await fixture();
    const input = {
      operationId: `${Date.now()}:${'a'.repeat(32)}`,
      command: { kind: 'board.create', input: { title: 'writing' } },
    };
    expect((await call('/api/accounts/account-a/commands/local', input)).status).toBe(200);
    const again = await call('/api/accounts/account-a/commands/local', input);
    expect(await again.json()).toMatchObject({ state: 'succeeded', confirmedSteps: 1 });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM boards_boards WHERE account_id='account-a' AND title='writing'",
        )
        .first('n'),
    ).toBe(1);
    const changed = await call('/api/accounts/account-a/commands/local', {
      ...input,
      command: { kind: 'board.create', input: { title: 'changed' } },
    });
    expect(changed.status).toBe(409);
  });
  it('commits preferences with their operation, so a retry keeps the original revision', async () => {
    const { call, db } = await fixture();
    const input = {
      operationId: `${Date.now()}:${'b'.repeat(32)}`,
      command: {
        kind: 'account.preferences',
        input: { revision: 0, planningZone: 'Europe/Istanbul', weekStart: 7 },
      },
    };
    const first = await call('/api/accounts/account-a/commands/local', input);
    expect(await first.json()).toMatchObject({ state: 'succeeded' });
    expect((await call('/api/accounts/account-a/commands/local', input)).status).toBe(200);
    expect(
      await db
        .prepare("SELECT revision FROM accounts_connections WHERE id='account-a'")
        .first('revision'),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT planning_zone FROM accounts_connections WHERE id='account-a'")
        .first('planning_zone'),
    ).toBe('Europe/Istanbul');
  });
  it('returns redacted operation summaries without owner identifiers, captured text, or provider receipts', async () => {
    const { call } = await fixture();
    await call('/api/accounts/account-a/commands/local', {
      operationId: `${Date.now()}:${'c'.repeat(32)}`,
      command: { kind: 'board.create', input: { title: 'private captured title' } },
    });
    const result = await call('/api/accounts/account-a/operations');
    const body = await result.text();
    expect(body).not.toContain('private captured title');
    expect(body).not.toContain('ownerSubject');
    expect(body).not.toContain('inputHash');
    expect((await call('/api/accounts/account-b/operations')).status).toBe(200);
  });
  it('saves a gallery snapshot with its receipt, scopes its content, and previews real capacity', async () => {
    const { call, db } = await fixture();
    const gallery = await call('/api/accounts/account-a/templates/gallery?kind=list');
    expect(await gallery.json()).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: 'weekly-reset' })]),
    });
    const input = {
      operationId: `${Date.now()}:${'d'.repeat(32)}`,
      command: { kind: 'template.list.gallery', galleryId: 'weekly-reset' },
    };
    const first = await call('/api/accounts/account-a/commands/local', input);
    expect(await first.json()).toMatchObject({ state: 'succeeded', confirmedSteps: 1 });
    expect((await call('/api/accounts/account-a/commands/local', input)).status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_list_templates').first('n')).toBe(1);
    const templateId = 'template:' + input.operationId;
    const template = (await (
      await call('/api/accounts/account-a/templates/list/' + encodeURIComponent(templateId))
    ).json()) as { snapshot: { id: string } };
    const content = await call(
      '/api/accounts/account-a/templates/snapshots/' +
        encodeURIComponent(template.snapshot.id) +
        '/tasks',
    );
    expect(await content.json()).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ title: 'gather the loose ends' })]),
    });
    expect(
      (
        await call(
          '/api/accounts/account-b/templates/snapshots/' +
            encodeURIComponent(template.snapshot.id) +
            '/tasks',
        )
      ).status,
    ).toBe(404);
    await db
      .prepare(
        "UPDATE tasks_account_state SET inventory_count=1997,inventory_complete_at=? WHERE account_id='account-a'",
      )
      .bind(Date.now())
      .run();
    const preview = await call('/api/accounts/account-a/templates/application-preview', {
      template: { kind: 'list', id: templateId, contentRevision: 1 },
      options: { applicationDay: accountToday('UTC'), useRelativeDates: true, listPrefix: '' },
    });
    expect(await preview.json()).toMatchObject({
      preview: { listCount: 1, taskCount: 3, requiredListSlots: 1 },
      capacity: { known: 1997, reserved: 0, available: 3, stale: false },
    });
    expect((await call('/api/accounts/account-a/templates/list?limit=1000')).status).toBe(400);
  });
});
