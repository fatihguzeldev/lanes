import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import { TaskSyncService } from '../../sync/service';
import { TaskQueries } from '../tasks';

const now = Date.parse('2026-11-10T15:00:00Z');
const context = { today: '2026-11-10', now };
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((item) => item.close()));

async function fixture() {
  const data = testDatabase();
  databases.push(data);
  await seedAccount(data.db, 'account', now);
  for (const id of ['list', 'other'])
    await data.db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,tasks_complete_at,completed_complete_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(id, 'account', id, id, now, now)
      .run();
  const history = new HistoryService(data.db, { now: () => now });
  const projection = new TaskProjectionStore(data.db, {
    history,
    now: () => now,
  });
  const tasks = ['a', 'b', 'c', 'd'].map((id, index) => ({
    id,
    title: id,
    position: `00${index}`,
    status: 'needsAction' as const,
    etag: `${id}-v1`,
  }));
  const knownTaskIds = new Map(tasks.map((task) => [task.id, task.id]));
  await data.db.batch(
    (await projection.prepareConfirmedWrites('account', 'list', tasks, { knownTaskIds })).writes,
  );
  const queries = new TaskQueries(data.db);
  const input = { listIds: ['list'], limit: 2 };
  const first = await queries.listTasks('account', input, context);
  expect(first.items.map((task) => task.id)).toEqual(['a', 'b']);
  const reorder = async (id: string, position: string) =>
    data.db.batch([
      ...(
        await projection.prepareConfirmedWrites(
          'account',
          'list',
          [{ ...tasks.find((task) => task.id === id)!, position, etag: `${id}-v2` }],
          { knownTaskIds },
        )
      ).writes,
      data.db
        .prepare('UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id=?')
        .bind('list'),
    ]);
  return { ...data, history, tasks, queries, input, first, reorder };
}

it('rejects a next page when an unchanged anchor hides a sibling reordered across its boundary', async () => {
  const f = await fixture();
  await f.reorder('c', '0005');
  await expect(
    f.queries.listTasks('account', { ...f.input, cursor: f.first.nextCursor! }, context),
  ).rejects.toMatchObject({ code: 'conflict' });
  const fresh = await f.queries.listTasks('account', { listIds: ['list'] }, context);
  expect(fresh.items.map((task) => task.id)).toEqual(['a', 'c', 'b', 'd']);
});

it('validates an anchor in the same snapshot that selects the next page', async () => {
  const f = await fixture();
  let changed = false;
  const change = async () => {
    if (changed) return;
    changed = true;
    await f.reorder('b', '004');
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === 'first')
          return async (...args: unknown[]) => {
            const value = await Reflect.apply(target.first, target, args);
            if (sql.includes('FROM candidates WHERE id=? AND revision=?')) await change();
            return value;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (
            statements.some((statement) =>
              (statement as unknown as { sql: string }).sql.includes('cursor_anchor'),
            )
          )
            await change();
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new TaskQueries(db).listTasks('account', { ...f.input, cursor: f.first.nextCursor! }, context),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(changed).toBe(true);
});

it('rejects a legacy task cursor without a selection fingerprint', async () => {
  const f = await fixture();
  const cursor = JSON.parse(Buffer.from(f.first.nextCursor!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  delete cursor.selectionRevision;
  await expect(
    f.queries.listTasks(
      'account',
      { ...f.input, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') },
      context,
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('keeps a cursor usable when only an unselected list changes', async () => {
  const f = await fixture();
  await f.db
    .prepare('UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id=?')
    .bind('other')
    .run();
  const page = await f.queries.listTasks(
    'account',
    { ...f.input, cursor: f.first.nextCursor! },
    context,
  );
  expect(page.items.map((task) => task.id)).toEqual(['c', 'd']);
  expect(page.nextCursor).toBeNull();
});

it('keeps a cursor usable across an unchanged full sync and its bookkeeping revisions', async () => {
  const f = await fixture();
  const sync = new TaskSyncService(f.db, {
    history: f.history,
    now: () => now,
    clientFor: async () => ({
      getTaskList: async (id) => ({ id }),
      listTaskLists: async () => ({ items: [], nextPageToken: null }),
      listTasks: async () => ({ items: f.tasks, nextPageToken: null }),
      getTask: async (_listId, id) => f.tasks.find((task) => task.id === id)!,
    }),
  });
  await f.db.batch(sync.providerOrderRefreshWrites('account', ['list'], 'create'));
  await sync.advanceForeground('account');
  const page = await f.queries.listTasks(
    'account',
    { ...f.input, cursor: f.first.nextCursor! },
    context,
  );
  expect(page.items.map((task) => task.id)).toEqual(['c', 'd']);
  expect(page.nextCursor).toBeNull();
});

it('invalidates the selected list when a blocker in another list changes query membership', async () => {
  const f = await fixture();
  await f.db
    .prepare('INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES(?,?,?,?,?)')
    .bind('blocker', 'account', 'other', 'blocker', 'blocker')
    .run();
  await f.db
    .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
    .bind('account', 'c', 'blocker')
    .run();
  const input = { ...f.input, filter: { dependencyStates: ['unblocked' as const] } };
  const first = await f.queries.listTasks('account', input, context);
  expect(first.items.map((task) => task.id)).toEqual(['a', 'b']);
  await f.db
    .prepare('UPDATE tasks_tasks SET completed=1,revision=revision+1 WHERE id=?')
    .bind('blocker')
    .run();
  await expect(
    f.queries.listTasks('account', { ...input, cursor: first.nextCursor! }, context),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it.each(['label', 'label name', 'dependency'])(
  'invalidates a cursor when its %s changes without a task revision update',
  async (kind) => {
    const f = await fixture();
    await f.db
      .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES(?,?,?,?,?)')
      .bind('label', 'account', 'label', 'label', '#123456')
      .run();
    if (kind === 'label name')
      await f.db
        .prepare('INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES(?,?,?)')
        .bind('account', 'c', 'label')
        .run();
    const first = await f.queries.listTasks('account', f.input, context);
    if (kind === 'label')
      await f.db
        .prepare('INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES(?,?,?)')
        .bind('account', 'c', 'label')
        .run();
    else if (kind === 'label name')
      await f.db
        .prepare('UPDATE tasks_labels SET name=?,name_key=? WHERE id=?')
        .bind('renamed', 'renamed', 'label')
        .run();
    else
      await f.db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
        .bind('account', 'c', 'a')
        .run();
    await expect(
      f.queries.listTasks('account', { ...f.input, cursor: first.nextCursor! }, context),
    ).rejects.toMatchObject({ code: 'conflict' });
  },
);
