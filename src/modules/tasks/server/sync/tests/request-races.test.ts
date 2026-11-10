import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import { GoogleTasksError } from '../../provider/google-tasks';
import { TaskSyncService, type SyncReader } from '../service';

const now = Date.parse('2026-11-10T15:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((item) => item.close()));

async function fixture() {
  const data = testDatabase();
  databases.push(data);
  await seedAccount(data.db, 'account', now);
  for (const id of ['one', 'two'])
    await data.db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,tasks_complete_at,completed_complete_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(id, 'account', id, id, now, now)
      .run();
  const history = new HistoryService(data.db, { now: () => now });
  const reader: SyncReader = {
    getTaskList: async (id) => ({ id, title: id }),
    listTaskLists: async () => ({ items: [], nextPageToken: null }),
    listTasks: async () => ({ items: [], nextPageToken: null }),
    getTask: async (listId, id) => ({ id, title: `${listId}:${id}` }),
  };
  const service = (db = data.db) =>
    new TaskSyncService(db, {
      history,
      now: () => now,
      clientFor: async () => reader,
    });
  return { ...data, service, reader, history };
}

function afterRead(db: D1Database, match: string, run: () => Promise<void>): D1Database {
  let fired = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === 'first')
          return async (...args: unknown[]) => {
            const value = await Reflect.apply(target.first, target, args);
            if (!fired && sql.startsWith(match)) {
              fired = true;
              await run();
            }
            return value;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

it.each(['order', 'check'] as const)(
  'retains %s work admitted after the final pending-work snapshot',
  async (kind) => {
    const f = await fixture();
    const projection = new TaskProjectionStore(f.db, { history: f.history, now: () => now });
    await f.db.batch(
      (
        await projection.prepareConfirmedWrites(
          'account',
          'one',
          [{ id: 'target', title: 'target' }],
          { knownTaskIds: new Map([['target', 'target']]) },
        )
      ).writes,
    );
    await f.db
      .prepare(
        'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending) VALUES(?,?,?,0,0)',
      )
      .bind('account', now, now)
      .run();
    const writer = f.service();
    const sync = f.service(
      afterRead(f.db, 'SELECT 1 AS n FROM tasks_sync_jobs', async () => {
        if (kind === 'order')
          await f.db.batch(writer.providerOrderRefreshWrites('account', ['one'], 'create'));
        else await writer.requestTaskCheck('account', 'target');
      }),
    );
    const result = await sync.advanceForeground('account');
    expect(result.status.pending).toBe(true);
    expect(result.errorCode).toBeUndefined();
    if (kind === 'order')
      expect(await f.db.prepare('SELECT list_id FROM tasks_sync_list_work').first('list_id')).toBe(
        'one',
      );
    else
      expect(
        await f.db.prepare('SELECT resource_id FROM tasks_sync_checks').first('resource_id'),
      ).toBe('target');
    expect((await writer.advanceNext()).accountId).toBe('account');
  },
);

it('does not replace a newly reset full-order request with the old delta slice', async () => {
  const f = await fixture();
  const writer = f.service();
  await f.db.batch(writer.providerOrderRefreshWrites('account', ['one'], 'create'));
  await f.db
    .prepare("UPDATE tasks_sync_list_work SET mode='delta',updated_min=?")
    .bind(new Date(now - 1000).toISOString())
    .run();
  const sync = f.service(
    afterRead(f.db, 'SELECT w.* FROM tasks_sync_list_work', async () => {
      await f.db
        .prepare('UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id=?')
        .bind('one')
        .run();
      await f.db.batch(writer.providerOrderRefreshWrites('account', ['one'], 'create'));
    }),
  );
  const result = await sync.advanceForeground('account');
  expect(result.status.pending).toBe(true);
  expect(result.errorCode).toBeUndefined();
  expect(
    await f.db
      .prepare('SELECT mode FROM tasks_sync_list_work WHERE list_id=?')
      .bind('one')
      .first('mode'),
  ).toBe('full');
  await writer.advanceForeground('account');
  expect((await writer.getStatus('account')).pending).toBe(false);
});

it.each(['entry', 'manual', 'stale', 'reconnect', 'list_change'] as const)(
  'retains the broader %s refresh while targeted work owns an active claim',
  async (reason) => {
    const f = await fixture(),
      sync = f.service();
    await f.db.batch(sync.providerOrderRefreshWrites('account', ['one'], 'create'));
    await f.db
      .prepare('UPDATE tasks_sync_jobs SET claim_id=?,claim_until=?')
      .bind('worker', now + 60_000)
      .run();
    expect(await sync.requestRefresh('account', { reason })).toEqual({ coalesced: true });
    expect(
      await f.db.prepare('SELECT default_pending,inventory_pending FROM tasks_sync_jobs').first(),
    ).toEqual({ default_pending: 1, inventory_pending: 1 });
    expect(
      (
        await f.db
          .prepare('SELECT list_id FROM tasks_sync_list_work ORDER BY list_id')
          .all<{ list_id: string }>()
      ).results.map((row) => row.list_id),
    ).toEqual(['one', 'two']);
  },
);

it('does not erase a stronger refresh admitted during an inventory provider read', async () => {
  const f = await fixture(),
    sync = f.service();
  await f.db
    .prepare(
      'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending) VALUES(?,?,?,0,1)',
    )
    .bind('account', now, now)
    .run();
  f.reader.listTaskLists = async () => {
    await sync.requestRefresh('account', { reason: 'reconnect' });
    return { items: [], nextPageToken: null };
  };
  const result = await sync.advanceForeground('account');
  expect(result.phase).toBe('coalesced');
  expect(result.errorCode).toBeUndefined();
  expect(
    await f.db.prepare('SELECT default_pending,inventory_pending FROM tasks_sync_jobs').first(),
  ).toEqual({ default_pending: 1, inventory_pending: 1 });
});

it('coalesces an already broad refresh without invalidating its current generation', async () => {
  const f = await fixture(),
    sync = f.service();
  await sync.requestRefresh('account', { reason: 'entry' });
  const version = await f.db
    .prepare('SELECT request_revision FROM tasks_sync_jobs')
    .first('request_revision');
  await sync.requestRefresh('account', { reason: 'manual' });
  expect(
    await f.db.prepare('SELECT request_revision FROM tasks_sync_jobs').first('request_revision'),
  ).toBe(version);
});

it('admits a broader refresh when the targeted job finishes between lookup and admission', async () => {
  const f = await fixture(),
    writer = f.service();
  await f.db.batch(writer.providerOrderRefreshWrites('account', ['one'], 'create'));
  const sync = f.service(
    afterRead(
      f.db,
      'SELECT account_id,default_pending,inventory_pending FROM tasks_sync_jobs',
      async () => {
        await f.db.batch([
          f.db.prepare('DELETE FROM tasks_sync_list_work'),
          f.db.prepare('DELETE FROM tasks_sync_jobs'),
        ]);
      },
    ),
  );
  await sync.requestRefresh('account', { reason: 'manual' });
  expect((await sync.getStatus('account')).pending).toBe(true);
});

it('repairs only orphaned read work while preserving existing claims and backoff', async () => {
  const f = await fixture();
  await seedAccount(f.db, 'checks-only', now);
  await seedAccount(f.db, 'retained', now);
  await f.db.batch([
    f.db
      .prepare('INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES(?,?,?)')
      .bind('account', 'one', now + 5000),
    f.db
      .prepare('INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) VALUES(?,?,?,?)')
      .bind('account', 'task', 'target', now - 1000),
    f.db
      .prepare('INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) VALUES(?,?,?,?)')
      .bind('checks-only', 'task', 'target', now + 1234),
    f.db
      .prepare('INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at) VALUES(?,?,?,?)')
      .bind('retained', 'task', 'target', now),
    f.db
      .prepare(
        'INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,claim_id,claim_until,attempts,error_code) VALUES(?,?,?,?,?,?,?)',
      )
      .bind('retained', now + 300_000, now, 'worker', now + 60_000, 3, 'provider_rate_limited'),
  ]);
  const retained = await f.db
    .prepare('SELECT * FROM tasks_sync_jobs WHERE account_id=?')
    .bind('retained')
    .first();
  const migration = readFileSync(
    new URL('../../../../../../migrations/0030_sync_request_generation.sql', import.meta.url),
    'utf8',
  );
  await f.db.exec(migration.slice(migration.indexOf(';') + 1));
  expect(
    await f.db
      .prepare(
        'SELECT next_at,default_pending,inventory_pending FROM tasks_sync_jobs WHERE account_id=?',
      )
      .bind('account')
      .first(),
  ).toEqual({ next_at: now - 1000, default_pending: 0, inventory_pending: 0 });
  expect(
    await f.db
      .prepare('SELECT next_at FROM tasks_sync_jobs WHERE account_id=?')
      .bind('checks-only')
      .first('next_at'),
  ).toBe(now + 1234);
  expect(
    await f.db.prepare('SELECT * FROM tasks_sync_jobs WHERE account_id=?').bind('retained').first(),
  ).toEqual(retained);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_sync_list_work').first('n')).toBe(1);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_sync_checks').first('n')).toBe(3);
});

it('does not apply an old provider failure to a newer admitted refresh', async () => {
  const f = await fixture(),
    sync = f.service();
  await f.db.batch(sync.providerOrderRefreshWrites('account', ['one'], 'create'));
  f.reader.listTasks = async () => {
    await sync.requestRefresh('account', { reason: 'reconnect' });
    throw new GoogleTasksError('permission_required', { status: 403 });
  };
  const result = await sync.advanceForeground('account');
  expect(result.phase).toBe('coalesced');
  expect(result.errorCode).toBeUndefined();
  expect(
    await f.db.prepare('SELECT next_at,error_code,attempts FROM tasks_sync_jobs').first(),
  ).toEqual({ next_at: now, error_code: null, attempts: 0 });
});
