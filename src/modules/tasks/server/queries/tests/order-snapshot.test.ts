import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import { TaskSyncService } from '../../sync/service';
import { TaskQueries } from '../tasks';

const now = Date.parse('2026-11-10T15:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((item) => item.close()));
async function fixture() {
  const data = testDatabase();
  databases.push(data);
  await seedAccount(data.db, 'account', now);
  await data.db
    .prepare(
      'INSERT INTO tasks_lists(id,account_id,provider_id,title,tasks_complete_at,completed_complete_at) VALUES(?,?,?,?,?,?)',
    )
    .bind('list', 'account', 'google', 'work', now, now)
    .run();
  const history = new HistoryService(data.db, { now: () => now });
  const projection = new TaskProjectionStore(data.db, { history, now: () => now });
  return { ...data, history, projection };
}

function afterTaskRead(
  db: D1Database,
  run: () => Promise<void>,
  matches = (sql: string) => sql.startsWith('SELECT t.id,t.account_id,t.list_id,t.parent_id'),
): D1Database {
  let fired = false;
  const once = async () => {
    if (!fired) {
      fired = true;
      await run();
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === 'all')
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.all, target, args);
            if (matches(sql)) await once();
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (
            statements.some((statement) => matches((statement as unknown as { sql: string }).sql))
          )
            await once();
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

it('does not attach newly complete coverage to a task snapshot taken before order reconciliation', async () => {
  const f = await fixture();
  const old = {
    id: 'old',
    title: 'old first',
    position: '000',
    status: 'needsAction' as const,
    etag: 'v1',
  };
  const moved = {
    id: 'moved',
    title: 'moved first',
    position: '000',
    status: 'needsAction' as const,
    etag: 'v1',
  };
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites('account', 'list', [old, moved], {
        knownTaskIds: new Map([
          ['old', 'a-old'],
          ['moved', 'z-moved'],
        ]),
      })
    ).writes,
  );
  const sync = new TaskSyncService(f.db, {
    history: f.history,
    now: () => now,
    clientFor: async () => ({
      listTasks: async () => ({
        items: [{ ...old, position: '001', etag: 'v2' }, moved],
        nextPageToken: null,
      }),
      getTask: async () => moved,
      getTaskList: async () => ({ id: 'google' }),
      listTaskLists: async () => ({ items: [], nextPageToken: null }),
    }),
  });
  await f.db.batch(sync.providerOrderRefreshWrites('account', ['list'], 'move'));
  const queries = new TaskQueries(
    afterTaskRead(f.db, async () => {
      await sync.advanceForeground('account');
    }),
  );
  const page = await queries.listTasks(
    'account',
    { listIds: ['list'], filter: { completion: 'all' } },
    { today: '2026-11-10', now },
  );
  expect(page.items.map((task) => task.title)).toEqual(['old first', 'moved first']);
  expect(page.providerCoverage.complete).toBe(false);
  expect(page.orderReadyListIds).toEqual([]);
  const fresh = await new TaskQueries(f.db).listTasks(
    'account',
    { listIds: ['list'] },
    { today: '2026-11-10', now },
  );
  expect(fresh.items.map((task) => task.title)).toEqual(['moved first', 'old first']);
  expect(fresh.orderReadyListIds).toEqual(['list']);
});

it('proves the selected empty or filtered list without requiring account inventory or returned tasks', async () => {
  const f = await fixture();
  await f.db
    .prepare('UPDATE tasks_account_state SET inventory_complete_at=NULL WHERE account_id=?')
    .bind('account')
    .run();
  const queries = new TaskQueries(f.db);
  for (const query of ['', 'filtered out']) {
    const page = await queries.listTasks(
      'account',
      { listIds: ['list'], query },
      { today: '2026-11-10', now },
    );
    expect(page.items).toEqual([]);
    expect(page.providerCoverage.complete).toBe(false);
    expect(page.orderReadyListIds).toEqual(['list']);
  }
});

it('does not attach a new order proof to an empty selection captured before an insertion', async () => {
  const f = await fixture();
  const db = afterTaskRead(
    f.db,
    async () => {
      await f.db.batch([
        ...(
          await f.projection.prepareConfirmedWrites('account', 'list', [
            { id: 'new', title: 'new first', position: '000' },
          ])
        ).writes,
        f.db
          .prepare('UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id=?')
          .bind('list'),
      ]);
    },
    (sql) =>
      sql.includes(
        'SELECT id,revision,parent_id,context_id,root_id,root_revision,estimated,parent_estimated FROM candidates',
      ),
  );
  await expect(
    new TaskQueries(db).listTasks('account', { listIds: ['list'] }, { today: '2026-11-10', now }),
  ).rejects.toMatchObject({ code: 'conflict' });
});
