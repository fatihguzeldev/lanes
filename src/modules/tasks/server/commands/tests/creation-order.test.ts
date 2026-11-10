import { afterEach, expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import { GoogleTasksClient, type GoogleTaskDTO } from '../../provider/google-tasks';
import { TaskQueries } from '../../queries/tasks';
import { TaskSyncService } from '../../sync/service';
import { TaskCommandService } from '../service';

const now = Date.parse('2026-11-10T12:00:00Z');
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

async function fixture(parentId: string | null = null) {
  const data = testDatabase();
  cleanup.push(data.close);
  await seedAccount(data.db, 'account', now);
  await data.db
    .prepare(
      `INSERT INTO tasks_lists
    (id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at,last_synced_at)
    VALUES('list','account','google-list','work',1,?,?,?)`,
    )
    .bind(now, now, now)
    .run();
  await data.db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,title)
    VALUES('other-list','account','other-google-list','not loaded')`,
    )
    .run();
  const history = new HistoryService(data.db, { now: () => now });
  const projection = new TaskProjectionStore(data.db, { history, now: () => now });
  const tasks = new Map<string, GoogleTaskDTO>([
    [
      'old',
      {
        id: 'old',
        title: 'survive',
        status: 'needsAction',
        position: '000',
        etag: 'old-v1',
        ...(parentId ? { parent: 'parent' } : {}),
      },
    ],
    ...(parentId
      ? [
          [
            'parent',
            {
              id: 'parent',
              title: 'parent',
              status: 'needsAction',
              position: '000',
              etag: 'parent-v1',
            },
          ] as [string, GoogleTaskDTO],
        ]
      : []),
  ]);
  await data.db.batch(
    (
      await projection.prepareConfirmedWrites('account', 'list', [...tasks.values()], {
        knownTaskIds: new Map([
          ['old', 'a-old'],
          ['parent', 'parent'],
        ]),
      })
    ).writes,
  );
  const calls: Array<{ method: string; path: string }> = [];
  let creates = 0;
  const client = new GoogleTasksClient({
    accessToken: 'test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname });
      if (method === 'POST' && url.pathname.endsWith('/tasks')) {
        expect(url.searchParams.has('previous')).toBe(false);
        creates++;
        for (const [id, task] of tasks) {
          if ((task.parent ?? null) === parentId)
            tasks.set(id, {
              ...task,
              position: String(Number(task.position) + 1).padStart(3, '0'),
              etag: `${id}-v${creates + 1}`,
            });
        }
        const task: GoogleTaskDTO = {
          id: `new-${creates}`,
          title: (JSON.parse(String(init?.body)) as { title: string }).title,
          status: 'needsAction',
          position: '000',
          etag: 'new-v1',
          ...(parentId ? { parent: 'parent' } : {}),
        };
        tasks.set(task.id, task);
        return Response.json(task);
      }
      if (method === 'GET' && url.pathname.endsWith('/tasks'))
        return Response.json({ items: [...tasks.values()] });
      if (method === 'GET' && tasks.has(url.pathname.split('/').at(-1)!))
        return Response.json(tasks.get(url.pathname.split('/').at(-1)!));
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    },
  });
  const queries = new TaskQueries(data.db);
  const operations = createOperationStore(data.db);
  const sync = new TaskSyncService(data.db, {
    history,
    clientFor: async () => client,
    now: () => now,
  });
  const service = new TaskCommandService(data.db, {
    history,
    projection,
    queries,
    operations,
    clientFor: async () => client,
    now: () => now,
    providerOrderRefreshWrites: sync.providerOrderRefreshWrites.bind(sync),
  });
  const create = async (title: string, first = true) => {
    const operationId = `${now}:first-position-create-${creates + 1}`;
    const parent = parentId ? await queries.getTask('account', parentId) : null;
    await service.capture.prepare({
      accountId: 'account',
      ownerSubject: 'owner',
      operationId,
      command: {
        kind: 'task.create',
        listId: 'list',
        listRevision: 1,
        parentId,
        ...(first ? { previousId: null } : {}),
        ...(parent ? { parentRevision: parent.revision } : {}),
        title,
      } as never,
    });
    const result = await service.advance('account', operationId);
    expect(result.operation.state).toBe('succeeded');
  };
  await create('gdg gaziantep');
  const query = () =>
    queries.listTasks(
      'account',
      { listIds: ['list'], filter: { completion: 'all' } },
      { today: '2026-11-10', now },
    );
  return { ...data, calls, sync, query, queries, create };
}

it.each([null, 'parent'])(
  'keeps creation order unverified until sibling positions reconcile (parent %s)',
  async (parentId) => {
    const f = await fixture(parentId);
    const before = await f.query();
    expect(
      before.items.filter((task) => task.parentId === parentId).map((task) => task.title),
    ).toEqual(['survive', 'gdg gaziantep']);
    expect(before.orderReadyTaskIds).toEqual([]);
    expect(before.providerCoverage.complete).toBe(true);
    expect((await f.sync.getStatus('account')).pending).toBe(true);
    for (let step = 0; step < 5 && (await f.sync.getStatus('account')).pending; step++)
      await f.sync.advanceForeground('account');
    const after = await f.query();
    expect(
      after.items.filter((task) => task.parentId === parentId).map((task) => task.title),
    ).toEqual(['gdg gaziantep', 'survive']);
    expect(after.providerCoverage.complete).toBe(true);
    expect(after.orderReadyTaskIds).toEqual(
      expect.arrayContaining(after.items.map((task) => task.id)),
    );
    const accountPage = await f.queries.listTasks(
      'account',
      { filter: { completion: 'all' } },
      { today: '2026-11-10', now },
    );
    expect(accountPage.providerCoverage.complete).toBe(false);
    expect(accountPage.orderReadyTaskIds).toContain(
      after.items.find((task) => task.title === 'gdg gaziantep')!.id,
    );
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.every((call) => !call.path.includes('other-google-list'))).toBe(true);
  },
);

it('accepts another first-position creation before order reads finish and coalesces their reconciliation', async () => {
  const f = await fixture();
  await f.create('newest');
  expect((await f.query()).orderReadyTaskIds).toEqual([]);
  const work = await f.db
    .prepare('SELECT list_id FROM tasks_sync_list_work WHERE account_id=?')
    .bind('account')
    .all<{ list_id: string }>();
  expect(work.results.map((row) => row.list_id)).toEqual(['list']);
  for (let step = 0; step < 5 && (await f.sync.getStatus('account')).pending; step++)
    await f.sync.advanceForeground('account');
  const after = await f.query();
  expect(after.items.map((task) => task.title)).toEqual(['newest', 'gdg gaziantep', 'survive']);
  expect(after.orderReadyTaskIds).toHaveLength(3);
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
});

it('does not infer a tail from stale sibling positions while explicit insertion remains available', async () => {
  const f = await fixture();
  await expect(f.create('inferred tail', false)).rejects.toThrow(
    'sibling order is still being reconciled',
  );
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});
