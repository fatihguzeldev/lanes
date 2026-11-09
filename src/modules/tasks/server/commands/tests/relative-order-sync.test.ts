import { afterEach, expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { GoogleTasksClient, type GoogleTaskDTO } from '../../provider/google-tasks';
import { TaskProjectionStore } from '../../projection/store';
import { TaskQueries } from '../../queries/tasks';
import { TaskSyncService } from '../../sync/service';
import { TaskCommandService } from '../service';

const now = Date.parse('2026-11-09T10:00:00Z');
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

async function fixture() {
  const data = testDatabase();
  cleanup.push(data.close);
  await seedAccount(data.db, 'account', now);
  await data.db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at,last_synced_at)
    VALUES('list','account','google-list','work',1,?,?,?)`,
    )
    .bind(now, now, now)
    .run();
  const history = new HistoryService(data.db, { now: () => now });
  const projection = new TaskProjectionStore(data.db, {
    history,
    now: () => now,
    id: () => crypto.randomUUID(),
  });
  const tasks = new Map<string, GoogleTaskDTO>([
    [
      'google-a',
      {
        id: 'google-a',
        title: 'a',
        notes: 'keep this note',
        status: 'needsAction',
        etag: 'a-v1',
        position: '100',
      },
    ],
    [
      'google-b',
      { id: 'google-b', title: 'b', status: 'needsAction', etag: 'b-v1', position: '200' },
    ],
    [
      'google-c',
      { id: 'google-c', title: 'c', status: 'needsAction', etag: 'c-v1', position: '300' },
    ],
    [
      'google-child',
      {
        id: 'google-child',
        title: 'child',
        status: 'needsAction',
        parent: 'google-a',
        etag: 'child-v1',
        position: '100',
      },
    ],
  ]);
  await data.db.batch(
    (
      await projection.prepareConfirmedWrites('account', 'list', [...tasks.values()], {
        knownTaskIds: new Map([...tasks.keys()].map((id) => [id, id.replace('google-', '')])),
      })
    ).writes,
  );
  await data.db
    .prepare("UPDATE tasks_tasks SET starred=1,priority='high' WHERE id IN('a','child')")
    .run();
  const moved: Array<{ task: string; previous: string | null }> = [];
  const hooks: { beforeRead?: () => Promise<void>; beforeResponse?: () => Promise<void> } = {};
  const client = new GoogleTasksClient({
    accessToken: 'test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'GET') {
        await hooks.beforeRead?.();
        const task = tasks.get(url.pathname.split('/').at(-1)!);
        return task
          ? Response.json(task)
          : Response.json({ error: { code: 404 } }, { status: 404 });
      }
      if (init?.method === 'POST' && url.pathname.endsWith('/move')) {
        const id = url.pathname.split('/').at(-2)!;
        moved.push({ task: id, previous: url.searchParams.get('previous') });
        const value = {
          ...tasks.get(id)!,
          etag: `${id}-moved-${moved.length}`,
          position: String(400 + moved.length),
        };
        tasks.set(id, value);
        await hooks.beforeResponse?.();
        return Response.json(value);
      }
      throw new Error(`unexpected provider request: ${init?.method} ${url.pathname}`);
    },
  });
  const operations = createOperationStore(data.db);
  const queries = new TaskQueries(data.db);
  const sync = new TaskSyncService(data.db, {
    history,
    clientFor: async () => client,
    now: () => now,
  });
  const service = new TaskCommandService(data.db, {
    operations,
    queries,
    projection,
    history,
    clientFor: async () => client,
    now: () => now,
    providerOrderRefreshWrites: sync.providerOrderRefreshWrites.bind(sync),
  });
  const dirty = () =>
    data.db
      .prepare(
        "UPDATE tasks_lists SET projection_revision=projection_revision+1,tasks_complete_at=NULL,completed_complete_at=NULL,sync_cursor='next-page' WHERE id='list'",
      )
      .run();
  const capture = async (taskId: string, previousId: string | null, identity: string) => {
    const task = await queries.getTask('account', taskId);
    const previous = previousId ? await queries.getTask('account', previousId) : null;
    return service.capture.prepare({
      operationId: `${now}:${identity}`,
      accountId: 'account',
      ownerSubject: 'owner',
      command: {
        kind: 'task.move',
        taskId,
        revision: task.revision,
        listId: 'list',
        listRevision: 1,
        parentId: null,
        previousId,
        ...(previous ? { previousRevision: previous.revision } : {}),
      },
    });
  };
  return { ...data, service, queries, projection, operations, tasks, moved, hooks, dirty, capture };
}

it('settles a relative reorder when unrelated sync progresses during provider preflight and response', async () => {
  const f = await fixture();
  await f.capture('b', 'c', 'relative-order-race');
  f.hooks.beforeRead = async () => {
    delete f.hooks.beforeRead;
    await f.dirty();
  };
  f.hooks.beforeResponse = async () => {
    delete f.hooks.beforeResponse;
    await f.dirty();
  };
  const result = await f.service.advance('account', `${now}:relative-order-race`);
  expect(result.operation.state).toBe('succeeded');
  expect(f.moved).toEqual([{ task: 'google-b', previous: 'google-c' }]);
  expect(await f.queries.getTask('account', 'b')).toMatchObject({
    parentId: null,
    listId: 'list',
    provider: { etag: 'google-b-moved-1' },
  });
});

it('captures consecutive same-parent relative moves while the full provider scan remains incomplete', async () => {
  const f = await fixture();
  await f.dirty();
  await f.capture('a', 'c', 'relative-order-one');
  expect((await f.service.advance('account', `${now}:relative-order-one`)).operation.state).toBe(
    'succeeded',
  );
  await f.capture('c', null, 'relative-order-two');
  expect((await f.service.advance('account', `${now}:relative-order-two`)).operation.state).toBe(
    'succeeded',
  );
  expect(f.moved).toEqual([
    { task: 'google-a', previous: 'google-c' },
    { task: 'google-c', previous: null },
  ]);
  expect(
    await f.db
      .prepare("SELECT tasks_complete_at,completed_complete_at FROM tasks_lists WHERE id='list'")
      .first(),
  ).toEqual({ tasks_complete_at: null, completed_complete_at: null });
  expect(await f.queries.getTask('account', 'a')).toMatchObject({
    notes: 'keep this note',
    starred: true,
    priority: 'high',
  });
  expect(await f.queries.getTask('account', 'child')).toMatchObject({
    parentId: 'a',
    listId: 'list',
    revision: 1,
    starred: true,
    priority: 'high',
    provider: { id: 'google-child', etag: 'child-v1' },
  });
});

it('rebases only the selected task and predecessor after sync changes their order metadata', async () => {
  const f = await fixture();
  await f.capture('b', 'c', 'relative-order-targets');
  const updated = ['google-b', 'google-c'].map((id, index) => ({
    ...f.tasks.get(id)!,
    etag: `${id}-resequence`,
    position: String(210 + index),
  }));
  updated.forEach((task) => f.tasks.set(task.id, task));
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites('account', 'list', updated, {
        knownTaskIds: new Map([
          ['google-b', 'b'],
          ['google-c', 'c'],
        ]),
      })
    ).writes,
  );
  await f.dirty();
  const result = await f.service.advance('account', `${now}:relative-order-targets`);
  expect(result.operation.state).toBe('succeeded');
  expect(f.moved).toEqual([{ task: 'google-b', previous: 'google-c' }]);
  expect(
    (await f.operations.getStep(`${now}:relative-order-targets`, 'step-0'))?.input,
  ).toMatchObject({
    task: { provider: { etag: 'google-b-resequence' } },
    previous: { provider: { etag: 'google-c-resequence' } },
  });
});

it.each(['task-title', 'task-notes', 'task-parent', 'previous-title'])(
  'keeps a real %s change fenced while unrelated order refresh is incomplete',
  async (change) => {
    const f = await fixture();
    await f.capture('b', 'c', 'relative-order-conflict');
    const id = change === 'previous-title' ? 'google-c' : 'google-b';
    const updated = {
      ...f.tasks.get(id)!,
      etag: `${id}-changed`,
      ...(change.endsWith('title') ? { title: 'changed elsewhere' } : {}),
      ...(change === 'task-notes' ? { notes: 'changed elsewhere' } : {}),
      ...(change === 'task-parent' ? { parent: 'google-a' } : {}),
    };
    f.tasks.set(id, updated);
    await f.db.batch(
      (
        await f.projection.prepareConfirmedWrites('account', 'list', [updated], {
          knownTaskIds: new Map([
            [id, id.replace('google-', '')],
            ['google-a', 'a'],
          ]),
        })
      ).writes,
    );
    await f.dirty();
    expect(
      (await f.service.advance('account', `${now}:relative-order-conflict`)).operation.state,
    ).toBe('failed');
    expect(f.moved).toEqual([]);
    expect(await f.queries.getTask('account', id.replace('google-', ''))).toMatchObject(
      change === 'task-notes'
        ? { notes: 'changed elsewhere' }
        : change === 'task-parent'
          ? { parentId: 'a' }
          : { title: 'changed elsewhere' },
    );
  },
);

it('retains a lost relative-move response without sending the move twice', async () => {
  const f = await fixture();
  await f.dirty();
  await f.capture('b', 'c', 'relative-order-uncertain');
  f.hooks.beforeResponse = async () => {
    throw new TypeError('response lost after Google accepted the move');
  };
  const result = await f.service.advance('account', `${now}:relative-order-uncertain`);
  expect(result.operation.state).toBe('uncertain');
  await f.service.advance('account', `${now}:relative-order-uncertain`);
  expect(f.moved).toEqual([{ task: 'google-b', previous: 'google-c' }]);
  expect((await f.operations.getStep(`${now}:relative-order-uncertain`, 'step-0'))?.state).toBe(
    'uncertain',
  );
});

it('survives target order-only sync that lands during its provider preflight', async () => {
  const f = await fixture();
  await f.capture('b', 'c', 'relative-order-during-read');
  f.hooks.beforeRead = async () => {
    delete f.hooks.beforeRead;
    const updated = ['google-b', 'google-c'].map((id, index) => ({
      ...f.tasks.get(id)!,
      etag: `${id}-during-read`,
      position: String(220 + index),
    }));
    updated.forEach((task) => f.tasks.set(task.id, task));
    await f.db.batch(
      (
        await f.projection.prepareConfirmedWrites('account', 'list', updated, {
          knownTaskIds: new Map([
            ['google-b', 'b'],
            ['google-c', 'c'],
          ]),
        })
      ).writes,
    );
    await f.dirty();
  };
  const result = await f.service.advance('account', `${now}:relative-order-during-read`);
  expect(result.operation.state).toBe('succeeded');
  expect(f.moved).toEqual([{ task: 'google-b', previous: 'google-c' }]);
});

it('ignores list inventory revisions while the same provider list remains available', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "UPDATE tasks_lists SET title='renamed independently',provider_etag='list-inventory-v2',revision=revision+1,projection_revision=projection_revision+1 WHERE id='list'",
    )
    .run();
  await f.capture('b', 'c', 'relative-order-inventory');
  f.hooks.beforeRead = async () => {
    delete f.hooks.beforeRead;
    await f.db
      .prepare(
        "UPDATE tasks_lists SET provider_etag='list-inventory-v3',revision=revision+1,projection_revision=projection_revision+1 WHERE id='list'",
      )
      .run();
  };
  expect(
    (await f.service.advance('account', `${now}:relative-order-inventory`)).operation.state,
  ).toBe('succeeded');
  expect(f.moved).toEqual([{ task: 'google-b', previous: 'google-c' }]);
  expect(
    await f.db
      .prepare("SELECT title,provider_id,provider_etag FROM tasks_lists WHERE id='list'")
      .first(),
  ).toEqual({
    title: 'renamed independently',
    provider_id: 'google-list',
    provider_etag: 'list-inventory-v3',
  });
});

it.each(['deleted', 'missing', 'replaced'])(
  'does not dispatch a relative reorder after its provider list becomes %s',
  async (state) => {
    const f = await fixture();
    await f.capture('b', 'c', 'relative-order-list-conflict');
    f.hooks.beforeRead = async () => {
      delete f.hooks.beforeRead;
      await f.db
        .prepare(
          state === 'deleted'
            ? "UPDATE tasks_lists SET deleted_at=1,revision=revision+1 WHERE id='list'"
            : state === 'missing'
              ? "UPDATE tasks_lists SET provider_missing_at=1,revision=revision+1 WHERE id='list'"
              : "UPDATE tasks_lists SET provider_id='different-google-list',revision=revision+1 WHERE id='list'",
        )
        .run();
    };
    const result = await f.service.advance('account', `${now}:relative-order-list-conflict`);
    expect(result.operation.state).not.toBe('succeeded');
    expect(f.moved).toEqual([]);
  },
);

it('preserves independent metadata changes without blocking the relative order intent', async () => {
  const f = await fixture();
  await f.capture('b', 'c', 'relative-order-metadata');
  await f.db
    .prepare(
      "UPDATE tasks_tasks SET starred=1,priority='high',revision=revision+1 WHERE id IN('b','c')",
    )
    .run();
  expect(
    (await f.service.advance('account', `${now}:relative-order-metadata`)).operation.state,
  ).toBe('succeeded');
  expect(f.moved).toEqual([{ task: 'google-b', previous: 'google-c' }]);
  expect(await f.queries.getTask('account', 'b')).toMatchObject({
    starred: true,
    priority: 'high',
  });
  expect(await f.queries.getTask('account', 'c')).toMatchObject({
    starred: true,
    priority: 'high',
  });
});

it('does not reject a cached adjacent relative intent when sync starts after capture', async () => {
  const f = await fixture();
  await f.capture('b', 'a', 'relative-order-adjacent');
  await f.dirty();
  const result = await f.service.advance('account', `${now}:relative-order-adjacent`);
  expect(result.operation.state).toBe('succeeded');
  expect(f.moved.length).toBeLessThanOrEqual(1);
});
