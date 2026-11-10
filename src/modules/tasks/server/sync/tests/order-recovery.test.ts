import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import { TaskQueries } from '../../queries/tasks';
import { TaskSyncService } from '../service';

const now = Date.parse('2026-11-10T15:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((item) => item.close()));

async function fixture(alwaysOmit = false) {
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
  const tasks = ['new', 'old'].map((id, index) => ({
    id,
    title: id,
    position: `00${index}`,
    status: 'needsAction' as const,
    etag: `${id}-v1`,
  }));
  await data.db.batch(
    (
      await new TaskProjectionStore(data.db, { history, now: () => now }).prepareConfirmedWrites(
        'account',
        'list',
        tasks,
        { knownTaskIds: new Map(tasks.map((task) => [task.id, task.id])) },
      )
    ).writes,
  );
  const calls: string[] = [];
  let omitting = alwaysOmit;
  let scans = 0;
  const sync = new TaskSyncService(data.db, {
    history,
    now: () => now,
    clientFor: async () => ({
      getTaskList: async (id) => ({ id: id === '@default' ? 'google' : id, title: 'work' }),
      listTaskLists: async () => ({
        items: [{ id: 'google', title: 'work' }],
        nextPageToken: null,
      }),
      listTasks: async (listId, query) => {
        if (listId !== 'google') return { items: [], nextPageToken: null };
        calls.push(query?.pageToken ? 'page2' : 'page1');
        if (!query?.pageToken) scans++;
        const omit = omitting || scans === 1;
        return query?.pageToken
          ? { items: [], nextPageToken: null }
          : { items: omit ? [tasks[0]!] : tasks, nextPageToken: omit ? 'page2' : null };
      },
      getTask: async (_listId, id) => {
        calls.push(`get:${id}`);
        return tasks.find((task) => task.id === id)!;
      },
    }),
  });
  await data.db.batch(sync.providerOrderRefreshWrites('account', ['list'], 'create'));
  return { ...data, sync, calls, recover: () => (omitting = false) };
}

it('reconciles affected-list order after an omitted task is recovered at its correct address', async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) {
    await f.sync.advanceForeground('account');
    if (!(await f.sync.getStatus('account')).pending) break;
  }
  const page = await new TaskQueries(f.db).listTasks(
    'account',
    { listIds: ['list'] },
    { today: '2026-11-10', now },
  );
  expect(f.calls).toEqual(['page1', 'page2', 'get:old', 'page1']);
  expect((await f.sync.getStatus('account')).pending).toBe(false);
  expect(page.items.map((task) => task.id)).toEqual(['new', 'old']);
  expect(page.items.every((task) => !task.provider.missing)).toBe(true);
  expect(page.orderReadyListIds).toEqual(['list']);
});

it('retains paused order recovery when an unrelated list wakes the account job', async () => {
  const f = await fixture(true);
  for (let i = 0; i < 10; i++) {
    try {
      await f.sync.advanceForeground('account');
    } catch {
      break;
    }
  }
  expect(await f.sync.getStatus('account')).toMatchObject({
    pending: true,
    nextAttemptAt: null,
    errorCode: 'provider_unavailable',
  });
  await f.db
    .prepare(
      'INSERT INTO tasks_lists(id,account_id,provider_id,title,tasks_complete_at,completed_complete_at) VALUES(?,?,?,?,?,?)',
    )
    .bind('other', 'account', 'other', 'other', now, now)
    .run();
  await f.db.batch(f.sync.providerOrderRefreshWrites('account', ['other'], 'create'));
  let failure: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      await f.sync.advanceForeground('account');
    } catch (error) {
      failure = error;
      break;
    }
    if (!(await f.sync.getStatus('account')).pending) break;
  }
  expect(failure).toMatchObject({ code: 'provider_unavailable' });
  expect(await f.sync.getStatus('account')).toMatchObject({
    pending: true,
    nextAttemptAt: null,
    errorCode: 'provider_unavailable',
  });
  expect(
    await f.db
      .prepare('SELECT COUNT(*) AS n FROM tasks_sync_checks WHERE resource_id=?')
      .bind('old')
      .first('n'),
  ).toBe(1);
});

it('keeps an already queued full rescan responsible for order instead of prematurely pausing a check', async () => {
  const f = await fixture(true);
  for (let i = 0; i < 3; i++) await f.sync.advance('account');
  expect(
    await f.db
      .prepare('SELECT order_recovery_attempted FROM tasks_lists')
      .first('order_recovery_attempted'),
  ).toBe(1);
  await f.db.batch([
    f.db.prepare('UPDATE tasks_sync_list_work SET next_at=?').bind(now + 60_000),
    f.db
      .prepare('UPDATE tasks_tasks SET provider_missing_at=?,revision=revision+1 WHERE id=?')
      .bind(now, 'old'),
    f.db
      .prepare(
        'INSERT INTO tasks_sync_checks(account_id,kind,resource_id,next_at,order_recovery) VALUES(?,?,?,?,1)',
      )
      .bind('account', 'task', 'old', now),
  ]);
  await expect(f.sync.advanceForeground('account')).resolves.toMatchObject({
    status: { pending: true, errorCode: null },
  });
  expect((await f.sync.getStatus('account')).nextAttemptAt).not.toBeNull();
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_sync_list_work').first('n')).toBe(1);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_sync_checks').first('n')).toBe(0);
});

it('pauses repeated provider omissions after one recovery scan instead of polling indefinitely', async () => {
  const f = await fixture(true);
  let failure: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      await f.sync.advanceForeground('account');
    } catch (error) {
      failure = error;
      break;
    }
    if (!(await f.sync.getStatus('account')).pending) break;
  }
  expect(failure).toMatchObject({ code: 'provider_unavailable', retryable: false });
  expect(f.calls).toEqual(['page1', 'page2', 'get:old', 'page1', 'page2', 'get:old']);
  expect(await f.sync.getStatus('account')).toMatchObject({
    pending: true,
    nextAttemptAt: null,
    errorCode: 'provider_unavailable',
  });
  const page = await new TaskQueries(f.db).listTasks(
    'account',
    { listIds: ['list'] },
    { today: '2026-11-10', now },
  );
  expect(page.orderReadyListIds).toEqual([]);
  expect((await f.sync.advanceNext()).phase).toBe('idle');
  expect(f.calls).toHaveLength(6);
  f.recover();
  await f.sync.requestRefresh('account', { reason: 'manual' });
  expect(await f.sync.getStatus('account')).toMatchObject({
    pending: true,
    nextAttemptAt: now,
    errorCode: null,
  });
  expect(
    await f.db
      .prepare('SELECT order_recovery_attempted FROM tasks_lists WHERE id=?')
      .bind('list')
      .first('order_recovery_attempted'),
  ).toBe(0);
  for (let i = 0; i < 10; i++) {
    await f.sync.advanceForeground('account');
    if (!(await f.sync.getStatus('account')).pending) break;
  }
  expect((await f.sync.getStatus('account')).pending).toBe(false);
  expect(
    (
      await new TaskQueries(f.db).listTasks(
        'account',
        { listIds: ['list'] },
        { today: '2026-11-10', now },
      )
    ).orderReadyListIds,
  ).toEqual(['list']);
});

it('starts a new targeted recovery attempt for an explicit task check without resetting other lists', async () => {
  const f = await fixture(true);
  for (let i = 0; i < 10; i++) {
    try {
      await f.sync.advanceForeground('account');
    } catch {
      break;
    }
  }
  await f.db
    .prepare(
      'INSERT INTO tasks_lists(id,account_id,provider_id,title,order_recovery_attempted) VALUES(?,?,?,?,1)',
    )
    .bind('other', 'account', 'other', 'other')
    .run();
  f.recover();
  await f.sync.requestTaskCheck('account', 'old');
  expect(await f.sync.getStatus('account')).toMatchObject({
    pending: true,
    nextAttemptAt: now,
    errorCode: null,
  });
  expect(
    (
      await f.db
        .prepare('SELECT id,order_recovery_attempted AS attempted FROM tasks_lists ORDER BY id')
        .all()
    ).results,
  ).toEqual([
    { id: 'list', attempted: 0 },
    { id: 'other', attempted: 1 },
  ]);
  for (let i = 0; i < 10; i++) {
    await f.sync.advanceForeground('account');
    if (!(await f.sync.getStatus('account')).pending) break;
  }
  expect((await f.sync.getStatus('account')).pending).toBe(false);
  expect(
    (
      await new TaskQueries(f.db).listTasks(
        'account',
        { listIds: ['list'] },
        { today: '2026-11-10', now },
      )
    ).orderReadyListIds,
  ).toEqual(['list']);
});
