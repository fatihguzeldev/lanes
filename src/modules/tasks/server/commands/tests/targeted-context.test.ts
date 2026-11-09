import { afterEach, expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskMetadataService } from '../../metadata/tasks';
import { GoogleTasksClient, type GoogleTaskDTO } from '../../provider/google-tasks';
import { TaskProjectionStore } from '../../projection/store';
import { TaskQueries } from '../../queries/tasks';
import { TaskSyncService } from '../../sync/service';
import { TaskCommandService } from '../service';

const now = Date.parse('2026-11-09T10:00:00Z');
const operationId = `${now}:targeted-context-command`;
const closes: Array<() => void> = [];
afterEach(() => closes.splice(0).forEach((close) => close()));

async function fixture(completed = false) {
  const data = testDatabase();
  closes.push(data.close);
  await seedAccount(data.db, 'account', now);
  await data.db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at)
      VALUES('list','account','google-list','work',1,?,?)`,
    )
    .bind(now, now)
    .run();
  const history = new HistoryService(data.db, { now: () => now });
  const projection = new TaskProjectionStore(data.db, { history, now: () => now });
  const tasks = new Map<string, GoogleTaskDTO>([
    [
      'google-parent',
      {
        id: 'google-parent',
        title: 'parent',
        notes: 'retained note',
        status: completed ? 'completed' : 'needsAction',
        ...(completed ? { completed: new Date(now).toISOString() } : {}),
        etag: 'parent-v1',
        position: '100',
      },
    ],
    [
      'google-child',
      {
        id: 'google-child',
        title: 'child',
        parent: 'google-parent',
        status: completed ? 'completed' : 'needsAction',
        ...(completed ? { completed: new Date(now).toISOString() } : {}),
        etag: 'child-v1',
        position: '100',
      },
    ],
  ]);
  await data.db.batch(
    (
      await projection.prepareConfirmedWrites('account', 'list', [...tasks.values()], {
        knownTaskIds: new Map([
          ['google-parent', 'parent'],
          ['google-child', 'child'],
        ]),
      })
    ).writes,
  );
  const calls: Array<{ method: string; url: URL }> = [];
  const hooks: { beforeRead?: () => Promise<void> } = {};
  const client = new GoogleTasksClient({
    accessToken: 'test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (method === 'GET') {
        await hooks.beforeRead?.();
        const task = tasks.get(url.pathname.split('/').at(-1)!);
        return task
          ? Response.json(task)
          : Response.json({ error: { code: 404 } }, { status: 404 });
      }
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const id = method === 'POST' ? 'created' : url.pathname.split('/').at(-1)!;
      const task = {
        ...(tasks.get(id) ?? { id, status: 'needsAction', position: '200' }),
        ...patch,
        ...(url.searchParams.get('parent') ? { parent: url.searchParams.get('parent')! } : {}),
        etag: `${id}-written`,
      } as GoogleTaskDTO;
      if (task.completed === null) delete task.completed;
      if (task.due === null) delete task.due;
      tasks.set(id, task);
      return Response.json(task);
    },
  });
  const operations = createOperationStore(data.db);
  const queries = new TaskQueries(data.db);
  const metadata = new TaskMetadataService(data.db, {
    history,
    commitWrites: async (writes) => data.db.batch(writes),
  });
  const options = {
    history,
    projection,
    operations,
    queries,
    metadata,
    clientFor: async () => client,
    now: () => now,
  };
  const service = new TaskCommandService(data.db, options);
  const sync = new TaskSyncService(data.db, options);
  const dirtyOrder = () => data.db.batch(sync.providerOrderRefreshWrites('account', ['list']));
  const capture = (command: unknown) =>
    service.capture.prepare({
      operationId,
      accountId: 'account',
      ownerSubject: 'owner',
      command: command as never,
    });
  const starChild = async () => {
    const child = await queries.getTask('account', 'child');
    await data.db.batch(
      (
        await metadata.prepareTaskPatch('account', child.id, { starred: true }, child.revision, {
          operationId: 'star-child',
          stepKey: 'star',
          origin: 'owner',
          recordedAt: new Date(now).toISOString(),
        })
      ).writes,
    );
  };
  return {
    ...data,
    tasks,
    calls,
    hooks,
    service,
    operations,
    queries,
    capture,
    dirtyOrder,
    starChild,
  };
}

it.each([null, 'parent'])(
  'creates at an explicit predecessor %s without full list coverage',
  async (previousId) => {
    const f = await fixture();
    await f.dirtyOrder();
    await f.capture({
      kind: 'task.create',
      listId: 'list',
      listRevision: 1,
      title: 'new task',
      parentId: null,
      previousId,
    });
    expect((await f.service.advance('account', operationId)).operation.state).toBe('succeeded');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.find((call) => call.method === 'POST')!.url.searchParams.get('previous')).toBe(
      previousId ? 'google-parent' : null,
    );
  },
);

it('keeps a captured first-position create valid when another task is starred', async () => {
  const f = await fixture();
  await f.capture({
    kind: 'task.create',
    listId: 'list',
    listRevision: 1,
    title: 'new task',
    previousId: null,
  });
  await f.starChild();
  expect((await f.service.advance('account', operationId)).operation.state).toBe('succeeded');
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

it('still requires complete coverage to infer the last sibling for creation', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  await expect(
    f.capture({ kind: 'task.create', listId: 'list', listRevision: 1, title: 'last task' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.calls).toEqual([]);
});

it('reopens an ordinary parent without completing or inspecting its children during order reconciliation', async () => {
  const f = await fixture(true);
  await f.dirtyOrder();
  await f.capture({ kind: 'task.reopen', taskId: 'parent', revision: 1 });
  await f.starChild();
  expect((await f.service.advance('account', operationId)).operation.state).toBe('succeeded');
  expect(await f.queries.getTask('account', 'parent')).toMatchObject({
    completed: false,
    notes: 'retained note',
  });
  expect(await f.queries.getTask('account', 'child')).toMatchObject({
    completed: true,
    starred: true,
  });
});

it('completes a supported leaf subtask while unrelated list coverage is incomplete', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  expect(await f.service.inspectTask('account', 'child')).toMatchObject({
    coverageComplete: false,
    completionCoverageComplete: true,
  });
  await f.capture({
    kind: 'task.complete',
    taskId: 'child',
    revision: 1,
    confirmOpenSubtaskCount: 0,
  });
  f.hooks.beforeRead = async () => {
    delete f.hooks.beforeRead;
    await f.dirtyOrder();
  };
  expect((await f.service.advance('account', operationId)).operation.state).toBe('succeeded');
  expect(await f.queries.getTask('account', 'child')).toMatchObject({ completed: true });
  expect(await f.queries.getTask('account', 'parent')).toMatchObject({ completed: false });
});

it('retains full coverage for parent completion and destructive task deletion', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  expect(await f.service.inspectTask('account', 'parent')).toMatchObject({
    coverageComplete: false,
    completionCoverageComplete: false,
  });
  await expect(
    f.capture({ kind: 'task.complete', taskId: 'parent', revision: 1, confirmOpenSubtaskCount: 1 }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    f.capture({
      kind: 'task.delete',
      taskId: 'child',
      revision: 1,
      confirm: true,
      confirmSubtaskCount: 0,
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.calls).toEqual([]);
});

it('creates a first subtask during an active scan and refreshes an unchanged parent reference', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  await f.db.prepare("UPDATE tasks_lists SET sync_cursor='scan-in-progress' WHERE id='list'").run();
  await f.capture({
    kind: 'task.create',
    listId: 'list',
    listRevision: 1,
    title: 'new child',
    parentId: 'parent',
    parentRevision: 1,
    previousId: null,
  });
  await f.db
    .prepare(
      "UPDATE tasks_tasks SET revision=revision+1,provider_position='999',provider_etag='parent-v2' WHERE id='parent'",
    )
    .run();
  expect((await f.service.advance('account', operationId)).operation.state).toBe('succeeded');
  const post = f.calls.find((call) => call.method === 'POST')!;
  expect(post.url.searchParams.get('parent')).toBe('google-parent');
  expect(post.url.searchParams.has('previous')).toBe(false);
});

it.each(['destination', 'predecessor', 'notes'] as const)(
  'rejects a changed %s before dispatching a relative create',
  async (changed) => {
    const f = await fixture();
    await f.capture({
      kind: 'task.create',
      listId: 'list',
      listRevision: 1,
      title: 'new task',
      previousId: 'parent',
      previousRevision: 1,
    });
    await f.db
      .prepare(
        changed === 'destination'
          ? "UPDATE tasks_lists SET provider_id='different-address' WHERE id='list'"
          : changed === 'predecessor'
            ? "UPDATE tasks_tasks SET deleted_at=1,revision=revision+1 WHERE id='parent'"
            : "UPDATE tasks_tasks SET notes='changed note',revision=revision+1 WHERE id='parent'",
      )
      .run();
    expect((await f.service.advance('account', operationId)).operation.state).toBe('failed');
    expect(f.calls.filter((call) => call.method === 'POST')).toEqual([]);
  },
);

it('reopens a child and its completed parent during order reconciliation', async () => {
  const f = await fixture(true);
  await f.dirtyOrder();
  await f.capture({ kind: 'task.reopen', taskId: 'child', revision: 1 });
  await f.service.advance('account', operationId);
  expect((await f.service.advance('account', operationId)).operation.state).toBe('succeeded');
  expect(await f.queries.getTask('account', 'parent')).toMatchObject({ completed: false });
  expect(await f.queries.getTask('account', 'child')).toMatchObject({ completed: false });
  expect(f.calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
});

it('does not dispatch a captured leaf completion if a descendant appears during provider preflight', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  await f.capture({
    kind: 'task.complete',
    taskId: 'child',
    revision: 1,
    confirmOpenSubtaskCount: 0,
  });
  f.hooks.beforeRead = async () => {
    delete f.hooks.beforeRead;
    await f.db
      .prepare(
        `INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,revision) VALUES('grandchild','account','list','child','google-grandchild','unexpected descendant',1)`,
      )
      .run();
  };
  expect((await f.service.advance('account', operationId)).operation.state).toBe('failed');
  expect(f.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
  expect(await f.queries.getTask('account', 'child')).toMatchObject({ completed: false });
});

it('does not blindly replay a lost relative create', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  await f.capture({
    kind: 'task.create',
    listId: 'list',
    listRevision: 1,
    title: 'one task',
    previousId: null,
  });
  const step = await f.operations.getStep(operationId, 'step-0');
  expect(step?.input).toMatchObject({ relativeCreate: true });
  const claim = await f.operations.claimNext(operationId, 'lost-claim', now);
  await f.operations.markDispatched(operationId, claim!.key, 'lost-claim', now);
  await f.db
    .prepare('UPDATE tasks_operation_steps SET claim_until=0 WHERE operation_id=?')
    .bind(operationId)
    .run();
  expect((await f.service.advance('account', operationId)).operation.state).toBe('uncertain');
  expect(f.calls).toEqual([]);
});

it('retains the full consequence context when a leaf has a dependency', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES('account','child','parent')",
    )
    .run();
  await f.dirtyOrder();
  expect(await f.service.inspectTask('account', 'child')).toMatchObject({
    coverageComplete: false,
    completionCoverageComplete: false,
    openBlockerCount: 1,
  });
  await expect(
    f.capture({ kind: 'task.complete', taskId: 'child', revision: 1, confirmBlocked: true }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.calls).toEqual([]);
});

it('does not dispatch a captured leaf completion if it becomes dependent during provider preflight', async () => {
  const f = await fixture();
  await f.dirtyOrder();
  await f.capture({ kind: 'task.complete', taskId: 'child', revision: 1 });
  f.hooks.beforeRead = async () => {
    delete f.hooks.beforeRead;
    await f.db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES('account','child','parent')",
      )
      .run();
  };
  expect((await f.service.advance('account', operationId)).operation.state).toBe('failed');
  expect(f.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
});

it('preserves conditional provider checks for ordinary reopening', async () => {
  const f = await fixture(true);
  await f.dirtyOrder();
  await f.capture({ kind: 'task.reopen', taskId: 'parent', revision: 1 });
  f.tasks.set('google-parent', {
    ...f.tasks.get('google-parent')!,
    title: 'changed elsewhere',
    etag: 'parent-v2',
  });
  expect((await f.service.advance('account', operationId)).operation.state).toBe('failed');
  expect(f.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
});
