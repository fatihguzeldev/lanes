import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { GoogleTasksClient } from '../../provider/google-tasks';
import type { GoogleTasksFetch } from '../../provider/google-tasks';
import { OperationStore } from '../../../../operations/server/journal/store';
import { TaskProjectionStore } from '../../projection/store';
import { TaskSyncService } from '../../sync/service';
import { TaskMetadataService } from '../../metadata/tasks';
import { TaskQueries } from '../../queries/tasks';
import { TaskCommandService } from '../service';
const now = Date.parse('2026-11-02T12:00:00Z');
const op = (suffix = 'abcdefghijklmnop') => now + ':' + suffix;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
async function fixture() {
  const f = testDatabase();
  closes.push(f.close);
  await seedAccount(f.db, 'account-a', now);
  await f.db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,provider_etag,title,revision,tasks_complete_at,completed_complete_at,last_synced_at) VALUES ('list-a','account-a','google-list','"list-v1"','home',1,?,?,?)`,
    )
    .bind(now, now, now)
    .run();
  let tick = now;
  const history = new HistoryService(f.db, { now: () => tick });
  const projection = new TaskProjectionStore(f.db, {
    history,
    now: () => tick,
    id: () => crypto.randomUUID(),
  });
  await f.db.batch(
    (
      await projection.prepareConfirmedWrites(
        'account-a',
        'list-a',
        [
          {
            id: 'google-task',
            title: 'original',
            notes: 'keep this note',
            status: 'needsAction',
            etag: '"task-v1"',
            position: '100',
            due: '2026-11-03T00:00:00Z',
          },
        ],
        { knownTaskIds: new Map([['google-task', 'task-a']]) },
      )
    ).writes,
  );
  const tasks = new Map<string, Record<string, unknown>>([
    [
      'google-task',
      {
        id: 'google-task',
        title: 'original',
        notes: 'keep this note',
        status: 'needsAction',
        etag: '"task-v1"',
        position: '100',
        due: '2026-11-03T00:00:00Z',
      },
    ],
  ]);
  const calls: { url: URL; method: string; body: Record<string, unknown> | null }[] = [];
  let createdCount = 0;
  const fetcher = vi.fn<GoogleTasksFetch>(async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    if (url.pathname === '/tasks/v1/users/@me/lists/google-list')
      return method === 'GET'
        ? Response.json({ id: 'google-list', title: 'home', etag: '"list-v1"' })
        : method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({ id: 'google-list', ...body, etag: '"list-v2"' });
    if (url.pathname === '/tasks/v1/users/@me/lists' && method === 'POST')
      return Response.json({ id: 'created-list', ...body, etag: '"created"' });
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (method === 'GET')
      return tasks.has(id)
        ? Response.json(tasks.get(id))
        : Response.json({ error: { code: 404 } }, { status: 404 });
    if (method === 'DELETE') {
      tasks.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.pathname.endsWith('/tasks')) {
      const createdId = ++createdCount === 1 ? 'created-task' : 'created-task-' + createdCount;
      const value: Record<string, unknown> = {
        id: createdId,
        ...(url.searchParams.get('parent') ? { parent: url.searchParams.get('parent') } : {}),
        status: 'needsAction',
        etag: '"created"',
        position: '200',
        ...body,
      };
      if (value.due === null) delete value.due;
      tasks.set(createdId, value);
      return Response.json(value);
    }
    if (method === 'PATCH') {
      const value: Record<string, unknown> = { ...tasks.get(id), ...body, etag: '"task-v2"' };
      for (const key of ['due', 'completed']) if (value[key] === null) delete value[key];
      tasks.set(id, value);
      return Response.json(value);
    }
    throw new Error('unexpected provider request');
  });
  const operations = new OperationStore(f.db),
    queries = new TaskQueries(f.db);
  const client = new GoogleTasksClient({ accessToken: 'token', fetch: fetcher });
  const metadata = new TaskMetadataService(f.db, {
    history,
    commitWrites: async (writes) => f.db.batch(writes),
  });
  const options = {
    operations,
    projection,
    history,
    queries,
    metadata,
    now: () => tick,
    clientFor: async () => client,
    validateBoardTarget: async () => {},
    placementWrites: () => [],
  };
  const service = new TaskCommandService(f.db, options);
  return {
    ...f,
    service,
    options,
    operations,
    projection,
    queries,
    tasks,
    calls,
    fetcher,
    advance: (ms: number) => {
      tick += ms;
    },
  };
}
const submit = (f: Awaited<ReturnType<typeof fixture>>, command: unknown, operationId = op()) =>
  f.service.prepare({
    operationId,
    accountId: 'account-a',
    ownerSubject: 'owner',
    command: command as never,
  });

describe('durable provider command foundation', () => {
  it('adopts an explicitly identified lost create through readback without sending create again', async () => {
    const f = await fixture();
    const lost = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () =>
        new GoogleTasksClient({
          accessToken: 'token',
          fetch: async (input, init) => {
            const result = await f.fetcher(input, init);
            if (init?.method === 'POST') throw new Error('response lost after provider success');
            return result;
          },
        }),
    });
    await lost.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.create',
        listId: 'list-a',
        listRevision: 1,
        title: 'identify this',
        notes: 'exact note',
      },
    });
    expect((await lost.advance('account-a', op())).operation.state).toBe('uncertain');
    f.advance(31_000);
    const preview = await f.service.resolutions.preview('account-a', op(), {
      candidateId: 'created-task',
    });
    expect(preview).toMatchObject({
      canConfirm: true,
      candidate: { providerId: 'created-task', title: 'identify this', notes: 'exact note' },
      context: { needsCandidate: true },
    });
    await expect(
      f.service.resolutions.confirm('account-a', op(), {
        candidateId: 'created-task',
        previewHash: preview.previewHash,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await f.service.resolutions.confirm('account-a', op(), {
      candidateId: 'created-task',
      previewHash: preview.previewHash,
      confirm: true,
      confirmIdentity: true,
    });
    expect((await f.service.advance('account-a', op())).operation.state).toBe('succeeded');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const retained = await f.db
      .prepare(
        "SELECT id FROM tasks_tasks WHERE account_id='account-a' AND provider_id='created-task'",
      )
      .first<{ id: string }>();
    expect(await f.queries.getTask('account-a', retained!.id)).toMatchObject({
      title: 'identify this',
      notes: 'exact note',
    });
  });
  it('fences a changed candidate and forbids retargeting a known-resource readback', async () => {
    const f = await fixture();
    const lost = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () =>
        new GoogleTasksClient({
          accessToken: 'token',
          fetch: async (input, init) => {
            const result = await f.fetcher(input, init);
            if (init?.method === 'PATCH') throw new Error('lost patch');
            return result;
          },
        }),
    });
    await lost.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.edit',
        taskId: 'task-a',
        revision: 1,
        patch: { title: 'the intended title' },
      },
    });
    await lost.advance('account-a', op());
    f.advance(31_000);
    await expect(
      f.service.resolutions.preview('account-a', op(), { candidateId: 'another-provider-task' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const preview = await f.service.resolutions.preview('account-a', op(), {});
    expect(preview.canConfirm).toBe(true);
    f.tasks.set('google-task', {
      ...f.tasks.get('google-task'),
      title: 'edited elsewhere',
      etag: '"external"',
    });
    await expect(
      f.service.resolutions.confirm('account-a', op(), {
        previewHash: preview.previewHash,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.resolutions.preview('account-a', op(), {})).canConfirm).toBe(false);
    expect((await f.operations.get(op(), 'account-a'))?.state).toBe('uncertain');
  });
  it('captures and creates once with real provider receipt, projection and history in one commit', async () => {
    const f = await fixture();
    const admitted = await submit(f, {
      kind: 'task.create',
      listId: 'list-a',
      listRevision: 1,
      title: '  new task  ',
      notes: 'new note',
    });
    expect(admitted.state).toBe('accepted');
    expect(f.calls).toEqual([]);
    const result = await f.service.advance('account-a', op());
    expect(result.operation.state).toBe('succeeded');
    const writes = f.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url.searchParams.get('previous')).toBe('google-task');
    const created = await f.db
      .prepare("SELECT id,title,notes FROM tasks_tasks WHERE provider_id='created-task'")
      .first<{ id: string; title: string; notes: string }>();
    expect(created).toMatchObject({ title: 'new task', notes: 'new note' });
    expect(
      (await f.db.prepare("SELECT kind FROM history_events WHERE kind='task_created'").all())
        .results,
    ).toHaveLength(1);
    await submit(f, {
      kind: 'task.create',
      listId: 'list-a',
      listRevision: 1,
      title: 'new task',
      notes: 'new note',
    });
    await f.service.advance('account-a', op());
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('rejects changed input under one identity and a stale editor without provider writes', async () => {
    const f = await fixture();
    await submit(f, { kind: 'task.edit', taskId: 'task-a', revision: 1, patch: { title: 'new' } });
    await expect(
      submit(f, {
        kind: 'task.edit',
        taskId: 'task-a',
        revision: 1,
        patch: { title: 'different' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      submit(
        f,
        { kind: 'task.edit', taskId: 'task-a', revision: 0, patch: { title: 'stale' } },
        op('differentidentity'),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.calls).toEqual([]);
  });
  it('patches only supplied provider fields and preserves unrelated notes', async () => {
    const f = await fixture();
    await submit(f, {
      kind: 'task.edit',
      taskId: 'task-a',
      revision: 1,
      patch: { title: 'renamed' },
    });
    await f.service.advance('account-a', op());
    expect(f.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ title: 'renamed' });
    expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
      title: 'renamed',
      notes: 'keep this note',
      scheduledDay: '2026-11-03',
    });
  });
  it('clears a provider day and its local schedule rather than reviving omitted response fields', async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE tasks_tasks SET scheduled_time='09:30',time_zone='Europe/Istanbul'")
      .run();
    await submit(f, {
      kind: 'task.edit',
      taskId: 'task-a',
      revision: 1,
      patch: { scheduledDay: null },
    });
    await f.service.advance('account-a', op());
    expect(f.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ due: null });
    expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
      scheduledDay: null,
      scheduledTime: null,
      timeZone: null,
    });
  });
  it('permits a local time edit during grant expiry without provider transport', async () => {
    const f = await fixture();
    await f.db.prepare("UPDATE accounts_connections SET state='reconnect_required'").run();
    await submit(f, {
      kind: 'task.edit',
      taskId: 'task-a',
      revision: 1,
      patch: { scheduledTime: '09:30', timeZone: 'Europe/Istanbul' },
    });
    await f.service.advance('account-a', op());
    expect(f.calls).toEqual([]);
    expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
      scheduledTime: '09:30',
      timeZone: 'Europe/Istanbul',
    });
  });
  it('records a transport-lost create as uncertain and does not resend it', async () => {
    const f = await fixture();
    const lost = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () =>
        new GoogleTasksClient({
          accessToken: 'token',
          fetch: async (input, init) => {
            if (init?.method === 'POST') throw new Error('lost response');
            return f.fetcher(input, init);
          },
        }),
    });
    await lost.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: { kind: 'task.create', listId: 'list-a', listRevision: 1, title: 'maybe created' },
    });
    expect((await lost.advance('account-a', op())).operation.state).toBe('uncertain');
    f.advance(31_000);
    expect((await lost.advance('account-a', op())).advanced).toBe(false);
  });
  it('repairs a recorded response after failed local commit without repeating create', async () => {
    const f = await fixture();
    let fail = true;
    const wrapped = {
      prepareConfirmedWrites: async (
        ...args: Parameters<TaskProjectionStore['prepareConfirmedWrites']>
      ) => {
        const prepared = await f.projection.prepareConfirmedWrites(...args);
        if (fail) {
          fail = false;
          prepared.writes.push(f.db.prepare('INSERT INTO tasks_write_guards(valid) VALUES(0)'));
        }
        return prepared;
      },
      retireTaskWrites: f.projection.retireTaskWrites.bind(f.projection),
    };
    const api = new TaskCommandService(f.db, {
      ...f.options,
      projection: wrapped as TaskProjectionStore,
    });
    await api.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: { kind: 'task.create', listId: 'list-a', listRevision: 1, title: 'create once' },
    });
    await expect(api.advance('account-a', op())).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    f.advance(31_000);
    expect((await api.advance('account-a', op())).operation.state).toBe('succeeded');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('requires blocker override and confirms completion and reopening with history', async () => {
    const f = await fixture();
    await f.db
      .prepare(
        `INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,completed) VALUES('blocker','account-a','list-a','google-blocker','blocked by this',0)`,
      )
      .run();
    await f.db
      .prepare("INSERT INTO tasks_dependencies VALUES('account-a','task-a','blocker')")
      .run();
    await expect(
      submit(f, { kind: 'task.complete', taskId: 'task-a', revision: 1 }),
    ).rejects.toMatchObject({ code: 'validation_failed', fields: { confirmation: 'required' } });
    await submit(f, { kind: 'task.complete', taskId: 'task-a', revision: 1, confirmBlocked: true });
    await f.service.advance('account-a', op());
    const completed = await f.queries.getTask('account-a', 'task-a');
    expect(completed.completed).toBe(true);
    await submit(
      f,
      { kind: 'task.reopen', taskId: 'task-a', revision: completed.revision },
      op('reopenidentity00'),
    );
    await f.service.advance('account-a', op('reopenidentity00'));
    expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
      completed: false,
      completedAt: null,
    });
    expect(
      (
        await f.db.prepare('SELECT kind FROM history_events ORDER BY kind').all<{ kind: string }>()
      ).results.map((row) => row.kind),
    ).toEqual(['task_completed', 'task_reopened']);
  });
  it('prevents default list deletion and requires exact list contents confirmation', async () => {
    const f = await fixture();
    await f.db.prepare('UPDATE tasks_lists SET is_default=1').run();
    await expect(
      submit(f, {
        kind: 'list.delete',
        listId: 'list-a',
        revision: 1,
        confirm: true,
        confirmTaskCount: 1,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await f.db.prepare('UPDATE tasks_lists SET is_default=0').run();
    await expect(
      submit(f, {
        kind: 'list.delete',
        listId: 'list-a',
        revision: 1,
        confirm: true,
        confirmTaskCount: 0,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', fields: { confirmation: 'required' } });
    expect(f.calls).toEqual([]);
  });
});

async function seedChildren(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  for (let offset = 0; offset < count; offset += 5) {
    const entries = Array.from({ length: Math.min(5, count - offset) }, (_, i) => ({
      id: 'google-child-' + (offset + i),
      title: 'child ' + (offset + i),
      notes: 'child notes',
      parent: 'google-task',
      status: 'needsAction' as const,
      etag: '"child-v1"',
      position: String(100 + offset + i),
    }));
    for (const entry of entries) f.tasks.set(entry.id, entry);
    await f.db.batch(
      (
        await f.projection.prepareConfirmedWrites('account-a', 'list-a', entries, {
          knownTaskIds: new Map(
            entries.map((entry) => [entry.id, entry.id.replace('google-', '')]),
          ),
        })
      ).writes,
    );
  }
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, id = op(), service = f.service) {
  for (let index = 0; index < 100; index++) {
    const value = await service.advance('account-a', id);
    if (value.operation.finished || value.operation.state === 'uncertain') return value.operation;
    if (!value.advanced) f.advance(31_000);
  }
  throw new Error('operation did not settle');
}

describe('grouped and copied provider commands', () => {
  it('captures large parent completion through SQL and bounded journal chunks before any provider write', async () => {
    const f = await fixture();
    await seedChildren(f, 12);
    const preview = await f.service.inspectTask('account-a', 'task-a');
    expect(preview).toMatchObject({
      openSubtaskCount: 12,
      subtaskCount: 12,
      coverageComplete: true,
    });
    const admitted = await submit(f, {
      kind: 'task.complete',
      taskId: 'task-a',
      revision: 1,
      confirmOpenSubtaskCount: 12,
    });
    expect(admitted.totalSteps).toBe(13);
    expect(admitted.inputSealed).toBe(false);
    expect(f.calls).toEqual([]);
    await f.service.advance('account-a', op());
    expect(f.calls).toEqual([]);
    expect((await drain(f)).state).toBe('succeeded');
    expect(f.calls.filter((call) => call.method === 'PATCH')).toHaveLength(13);
    expect(f.calls.filter((call) => call.method === 'PATCH').at(-1)?.url.pathname).toContain(
      '/google-task',
    );
  });
  it('aggregates blocked children and completion counts into one confirmation', async () => {
    const f = await fixture();
    await seedChildren(f, 1);
    await f.db
      .prepare("INSERT INTO tasks_dependencies VALUES('account-a','child-0','task-a')")
      .run();
    await expect(
      submit(f, { kind: 'task.complete', taskId: 'task-a', revision: 1 }),
    ).rejects.toMatchObject({
      fields: { confirmation: 'required', blockedSubtaskCount: '1', openSubtaskCount: '1' },
    });
  });
  it('copies a task subtree with fresh identities and retained source data', async () => {
    const f = await fixture();
    await seedChildren(f, 1);
    await submit(f, {
      kind: 'task.duplicate',
      taskId: 'task-a',
      revision: 1,
      listId: 'list-a',
      listRevision: 1,
    });
    expect((await drain(f)).state).toBe('succeeded');
    const posts = f.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.url.searchParams.get('parent')).toBe('created-task');
    const root = await f.db
      .prepare("SELECT id,notes FROM tasks_tasks WHERE provider_id='created-task'")
      .first<{ id: string; notes: string }>();
    expect(root?.id).not.toBe('task-a');
    expect(root?.notes).toBe('keep this note');
    const child = await f.db
      .prepare("SELECT parent_id FROM tasks_tasks WHERE provider_id='created-task-2'")
      .first<{ parent_id: string }>();
    expect(child?.parent_id).toBe(root?.id);
    expect((await f.queries.getTask('account-a', 'task-a')).title).toBe('original');
    expect(
      (
        await f.db
          .prepare("SELECT summary_json FROM history_events WHERE kind='task_created'")
          .all<{ summary_json: string }>()
      ).results.every((row) => JSON.parse(row.summary_json).source === 'duplication'),
    ).toBe(true);
  });
  it('duplicates a list with equal title into a distinct provider list and keeps the source', async () => {
    const f = await fixture();
    await submit(f, {
      kind: 'list.duplicate',
      listId: 'list-a',
      revision: 1,
      title: 'home',
      boardId: 'board',
    });
    expect((await drain(f)).state).toBe('succeeded');
    const lists = (
      await f.db
        .prepare(
          'SELECT id,title,provider_id FROM tasks_lists WHERE deleted_at IS NULL ORDER BY id',
        )
        .all<{ id: string; title: string; provider_id: string }>()
    ).results;
    expect(lists).toHaveLength(2);
    expect(lists.map((list) => list.title)).toEqual(['home', 'home']);
    expect(new Set(lists.map((list) => list.provider_id)).size).toBe(2);
  });
  it('rejects duplication with omitted dependency edges until the exact count is confirmed', async () => {
    const f = await fixture();
    await seedChildren(f, 1);
    await f.db
      .prepare("INSERT INTO tasks_dependencies VALUES('account-a','child-0','task-a')")
      .run();
    await expect(
      submit(f, {
        kind: 'task.duplicate',
        taskId: 'child-0',
        revision: 1,
        listId: 'list-a',
        listRevision: 1,
      }),
    ).rejects.toMatchObject({ fields: { omittedDependencyCount: '1' } });
    await submit(f, {
      kind: 'task.duplicate',
      taskId: 'child-0',
      revision: 1,
      listId: 'list-a',
      listRevision: 1,
      confirmOmittedDependencyCount: 1,
    });
    expect((await drain(f)).state).toBe('succeeded');
    const progress = await f.service.readCopyProgress(op(), 'account-a');
    expect(progress.items).toHaveLength(1);
    expect((await f.queries.getTask('account-a', progress.items[0]!.taskId)).blockedBy).toEqual([]);
  });
  it('settles mixed provider and lanes metadata in the same confirmed receipt', async () => {
    const f = await fixture();
    await submit(f, {
      kind: 'task.edit',
      taskId: 'task-a',
      revision: 1,
      patch: { title: 'new title', priority: 'high', starred: true },
    });
    expect((await drain(f)).state).toBe('succeeded');
    expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
      title: 'new title',
      priority: 'high',
      starred: true,
      notes: 'keep this note',
    });
  });
  it('serializes appends to one list and retains a deferred unsent command', async () => {
    const f = await fixture();
    await submit(f, {
      kind: 'task.create',
      listId: 'list-a',
      listRevision: 1,
      title: 'unknown first',
    });
    const api = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () =>
        new GoogleTasksClient({
          accessToken: 'token',
          fetch: async () => {
            throw new Error('lost');
          },
        }),
    });
    expect((await api.advance('account-a', op())).operation.state).toBe('uncertain');
    await submit(
      f,
      { kind: 'task.create', listId: 'list-a', listRevision: 1, title: 'second' },
      op('secondidentity000'),
    );
    const result = await f.service.advance('account-a', op('secondidentity000'));
    expect(result.operation.state).toBe('partial');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

function movedClient(f: Awaited<ReturnType<typeof fixture>>, changeChildIds = false) {
  let moves = 0;
  const destination = new Set<string>();
  const client = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/move')) {
        moves++;
        const original = f.tasks.get('google-task')!;
        const moved = { ...original, id: 'new-google-parent', etag: '"moved"' };
        f.tasks.delete('google-task');
        f.tasks.set('new-google-parent', moved);
        destination.add('new-google-parent');
        for (const [id, task] of [...f.tasks])
          if (task.parent === 'google-task') {
            const next = changeChildIds ? 'new-' + id : id;
            f.tasks.delete(id);
            f.tasks.set(next, { ...task, id: next, parent: 'new-google-parent' });
            destination.add(next);
          }
        return Response.json(moved);
      }
      if (
        (init?.method ?? 'GET') === 'GET' &&
        url.pathname.includes('/lists/google-destination/')
      ) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        return destination.has(id)
          ? Response.json(f.tasks.get(id))
          : Response.json({ error: { code: 404 } }, { status: 404 });
      }
      return f.fetcher(input, init);
    },
  });
  return { client, moves: () => moves };
}
async function seedDestination(f: Awaited<ReturnType<typeof fixture>>) {
  await f.db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES('list-b','account-a','google-destination','destination',1,?,?)`,
    )
    .bind(now, now)
    .run();
}

describe('provider boundaries and subtree verification', () => {
  it('moves a parent and verifies its child identity before atomically remapping the complete tree', async () => {
    const f = await fixture();
    await seedChildren(f, 1);
    await seedDestination(f);
    await f.db.prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE id='child-0'").run();
    const remote = movedClient(f);
    const api = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () => remote.client,
    });
    await api.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.move',
        taskId: 'task-a',
        revision: 1,
        listId: 'list-b',
        listRevision: 1,
        confirmSubtaskCount: 1,
      },
    });
    expect((await drain(f, op(), api)).state).toBe('succeeded');
    expect(remote.moves()).toBe(1);
    expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
      listId: 'list-b',
      provider: { id: 'new-google-parent' },
    });
    expect(await f.queries.getTask('account-a', 'child-0')).toMatchObject({
      listId: 'list-b',
      parentId: 'task-a',
      priority: 'high',
      starred: true,
    });
    expect(
      (
        await f.db
          .prepare("SELECT provider_parent_id FROM tasks_tasks WHERE id='child-0'")
          .first<{ provider_parent_id: string }>()
      )?.provider_parent_id,
    ).toBe('new-google-parent');
    expect(
      (await f.db.prepare("SELECT task_id FROM history_events WHERE kind='task_moved'").all())
        .results,
    ).toHaveLength(2);
  });
  it('checkpoints bounded child verification and never repeats the accepted parent move', async () => {
    const f = await fixture();
    await seedChildren(f, 7);
    await seedDestination(f);
    const remote = movedClient(f);
    const api = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () => remote.client,
      remainingProviderRequests: () => 2,
    });
    await api.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.move',
        taskId: 'task-a',
        revision: 1,
        listId: 'list-b',
        listRevision: 1,
        confirmSubtaskCount: 7,
      },
    });
    const first = await api.advance('account-a', op());
    expect(first.operation.state).toBe('partial');
    expect((await f.queries.getTask('account-a', 'task-a')).listId).toBe('list-a');
    expect((await drain(f, op(), api)).state).toBe('succeeded');
    expect(remote.moves()).toBe(1);
    expect(
      (
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM tasks_tasks WHERE list_id='list-b'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(8);
  });
  it('keeps the receipt and old mappings uncertain if changed child ids cannot be proven', async () => {
    const f = await fixture();
    await seedChildren(f, 1);
    await seedDestination(f);
    const remote = movedClient(f, true);
    const api = new TaskCommandService(f.db, {
      ...f.options,
      clientFor: async () => remote.client,
    });
    await api.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.move',
        taskId: 'task-a',
        revision: 1,
        listId: 'list-b',
        listRevision: 1,
        confirmSubtaskCount: 1,
      },
    });
    expect((await api.advance('account-a', op())).operation.state).toBe('uncertain');
    expect((await f.queries.getTask('account-a', 'task-a')).listId).toBe('list-a');
    expect((await f.operations.getStep(op(), 'step-0'))?.response).toMatchObject({
      id: 'new-google-parent',
    });
    f.advance(31_000);
    expect((await api.advance('account-a', op())).advanced).toBe(false);
    expect(remote.moves()).toBe(1);
  });
  it('refuses a stale provider etag before sending a narrow patch', async () => {
    const f = await fixture();
    await submit(f, {
      kind: 'task.edit',
      taskId: 'task-a',
      revision: 1,
      patch: { title: 'draft' },
    });
    f.tasks.set('google-task', { ...f.tasks.get('google-task'), etag: '"external-version"' });
    expect((await f.service.advance('account-a', op())).operation.state).toBe('failed');
    expect(f.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect((await f.queries.getTask('account-a', 'task-a')).title).toBe('original');
  });
  it('fences a child local-time edit after parent deletion was admitted', async () => {
    const f = await fixture();
    await seedChildren(f, 1);
    await f.db
      .prepare("UPDATE tasks_tasks SET scheduled_day='2026-11-03' WHERE id='child-0'")
      .run();
    await submit(f, {
      kind: 'task.delete',
      taskId: 'task-a',
      revision: 1,
      confirm: true,
      confirmSubtaskCount: 1,
    });
    const childOp = op('childtimeedit0000');
    await submit(
      f,
      {
        kind: 'task.edit',
        taskId: 'child-0',
        revision: 1,
        patch: { scheduledTime: '10:30', timeZone: 'UTC' },
      },
      childOp,
    );
    await f.service.advance('account-a', childOp);
    expect((await f.service.advance('account-a', op())).operation.state).toBe('failed');
    expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
  it('performs one explicit token refresh after a definitive401 and retries only in a later slice', async () => {
    const f = await fixture();
    let requests = 0;
    const refresh = vi.fn(async () => {});
    const api = new TaskCommandService(f.db, {
      ...f.options,
      refreshRejectedToken: refresh,
      clientFor: async () =>
        new GoogleTasksClient({
          accessToken: 'token',
          fetch: async (input, init) =>
            ++requests === 1
              ? Response.json({ error: { code: 401 } }, { status: 401 })
              : f.fetcher(input, init),
        }),
    });
    await api.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.create',
        listId: 'list-a',
        listRevision: 1,
        title: 'authorized later',
      },
    });
    expect((await api.advance('account-a', op())).operation.state).toBe('partial');
    expect(requests).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    f.advance(1000);
    expect((await api.advance('account-a', op())).operation.state).toBe('succeeded');
    expect(requests).toBe(2);
  });
  it('keeps an immutable duplicate snapshot when the source notes change after admission', async () => {
    const f = await fixture();
    await seedDestination(f);
    await submit(f, {
      kind: 'task.duplicate',
      taskId: 'task-a',
      revision: 1,
      listId: 'list-b',
      listRevision: 1,
    });
    await f.db
      .prepare("UPDATE tasks_tasks SET notes='later source edit',revision=revision+1")
      .run();
    expect((await drain(f)).state).toBe('succeeded');
    expect(
      (
        await f.db
          .prepare("SELECT notes FROM tasks_tasks WHERE provider_id='created-task'")
          .first<{ notes: string }>()
      )?.notes,
    ).toBe('keep this note');
  });
});

it('nests and promotes through real move calls without replacing task identity or metadata', async () => {
  const f = await fixture();
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites(
        'account-a',
        'list-a',
        [
          {
            id: 'google-parent-b',
            title: 'another parent',
            status: 'needsAction',
            etag: '"parent"',
            position: '200',
          },
        ],
        { knownTaskIds: new Map([['google-parent-b', 'parent-b']]) },
      )
    ).writes,
  );
  f.tasks.set('google-parent-b', {
    id: 'google-parent-b',
    title: 'another parent',
    status: 'needsAction',
    etag: '"parent"',
  });
  const transport = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/move')) {
        const value: Record<string, unknown> = { ...f.tasks.get('google-task'), etag: '"nested"' };
        const parent = url.searchParams.get('parent');
        if (parent) value.parent = parent;
        else delete value.parent;
        f.tasks.set('google-task', value);
        return Response.json(value);
      }
      return f.fetcher(input, init);
    },
  });
  const api = new TaskCommandService(f.db, { ...f.options, clientFor: async () => transport });
  await api.prepare({
    operationId: op(),
    accountId: 'account-a',
    ownerSubject: 'owner',
    command: {
      kind: 'task.move',
      taskId: 'task-a',
      revision: 1,
      listId: 'list-a',
      listRevision: 1,
      parentId: 'parent-b',
      parentRevision: 1,
    },
  });
  expect((await drain(f, op(), api)).state).toBe('succeeded');
  const nested = await f.queries.getTask('account-a', 'task-a');
  expect(nested).toMatchObject({ id: 'task-a', parentId: 'parent-b', notes: 'keep this note' });
  const promotedOp = op('promoteidentity0');
  await api.prepare({
    operationId: promotedOp,
    accountId: 'account-a',
    ownerSubject: 'owner',
    command: {
      kind: 'task.move',
      taskId: 'task-a',
      revision: nested.revision,
      listId: 'list-a',
      listRevision: 1,
      parentId: null,
      previousId: null,
    },
  });
  expect((await drain(f, promotedOp, api)).state).toBe('succeeded');
  expect((await f.queries.getTask('account-a', 'task-a')).parentId).toBeNull();
});
it('copies frozen label names and colors even when the source label is renamed later', async () => {
  const f = await fixture();
  await seedDestination(f);
  await f.db
    .prepare(
      "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES('label-a','account-a','old label','old label','#aabbcc')",
    )
    .run();
  await f.db.prepare("INSERT INTO tasks_task_labels VALUES('account-a','task-a','label-a')").run();
  await submit(f, {
    kind: 'task.duplicate',
    taskId: 'task-a',
    revision: 1,
    listId: 'list-b',
    listRevision: 1,
  });
  await f.db
    .prepare(
      "UPDATE tasks_labels SET name='renamed',name_key='renamed',color='#112233',revision=revision+1 WHERE id='label-a'",
    )
    .run();
  expect((await drain(f)).state).toBe('succeeded');
  const row = await f.db
    .prepare(
      "SELECT label.name,label.color FROM tasks_tasks task JOIN tasks_task_labels assignment ON assignment.task_id=task.id AND assignment.account_id=task.account_id JOIN tasks_labels label ON label.id=assignment.label_id AND label.account_id=assignment.account_id WHERE task.provider_id='created-task'",
    )
    .first<{ name: string; color: string }>();
  expect(row).toEqual({ name: 'old label', color: '#aabbcc' });
});
it('deletes one provider subtree and retires blocking edges while preserving recorded history', async () => {
  const f = await fixture();
  await seedChildren(f, 1);
  await f.db.prepare("INSERT INTO tasks_dependencies VALUES('account-a','child-0','task-a')").run();
  await submit(f, {
    kind: 'task.delete',
    taskId: 'task-a',
    revision: 1,
    confirm: true,
    confirmSubtaskCount: 1,
  });
  expect((await drain(f)).state).toBe('succeeded');
  expect(f.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect(
    (
      await f.db
        .prepare('SELECT COUNT(*) AS n FROM tasks_tasks WHERE deleted_at IS NOT NULL')
        .first<{ n: number }>()
    )?.n,
  ).toBe(2);
  expect(
    (await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_dependencies').first<{ n: number }>())?.n,
  ).toBe(0);
  expect(
    (await f.db.prepare('SELECT kind FROM history_events').first<{ kind: string }>())?.kind,
  ).toBe('task_deleted');
});

it('keeps a create uncertain when a received Google result could not be recorded as a receipt', async () => {
  const f = await fixture();
  const { AppError } = await import('../../../../../shared/contracts/errors');
  let fail = true;
  const operations = new Proxy(f.operations, {
    get(target, key, receiver) {
      if (key === 'recordResponse')
        return async (...args: Parameters<OperationStore['recordResponse']>) => {
          if (fail) {
            fail = false;
            throw new AppError('storage_unavailable', 'receipt storage failed', 503, true);
          }
          return target.recordResponse(...args);
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = new TaskCommandService(f.db, { ...f.options, operations });
  await service.prepare({
    operationId: op(),
    accountId: 'account-a',
    ownerSubject: 'owner',
    command: {
      kind: 'task.create',
      listId: 'list-a',
      listRevision: 1,
      title: 'accepted but unrecorded',
    },
  });
  const result = await service.advance('account-a', op());
  expect(result.operation.state).toBe('uncertain');
  f.advance(31000);
  await service.advance('account-a', op());
  expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

async function reorderingFixture() {
  const f = await fixture();
  const tail = {
    id: 'google-tail',
    title: 'last',
    status: 'needsAction' as const,
    etag: '"tail-v1"',
    position: '300',
  };
  f.tasks.set(tail.id, tail);
  await f.db.batch(
    (
      await f.projection.prepareConfirmedWrites('account-a', 'list-a', [tail], {
        knownTaskIds: new Map([[tail.id, 'task-b']]),
      })
    ).writes,
  );
  const sentEtags: (string | null)[] = [];
  let loseResponse = false;
  const client = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/move')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-2)!);
        const current = f.tasks.get(id)!;
        sentEtags.push(new Headers(init.headers).get('if-match'));
        if (sentEtags.at(-1) !== current.etag)
          return Response.json({ error: { code: 412 } }, { status: 412 });
        const moved = { ...current, position: '400', etag: '"move-v3"' };
        f.tasks.set(id, moved);
        if (loseResponse) throw new TypeError('response lost');
        return Response.json(moved);
      }
      return f.fetcher(input, init);
    },
  });
  const sync = new TaskSyncService(f.db, {
    history: f.options.history,
    clientFor: async () => client,
    now: f.options.now,
  });
  const service = new TaskCommandService(f.db, {
    ...f.options,
    clientFor: async () => client,
    providerOrderRefreshWrites: sync.providerOrderRefreshWrites.bind(sync),
  });
  const prepare = () =>
    service.prepare({
      operationId: op(),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.move',
        taskId: 'task-a',
        revision: 1,
        listId: 'list-a',
        listRevision: 1,
        parentId: null,
        previousId: 'task-b',
        previousRevision: 1,
        confirmSubtaskCount: 0,
      },
    });
  return {
    ...f,
    service,
    prepare,
    sentEtags,
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

it('keeps an already-adjacent move local without contacting Google or changing metadata', async () => {
  const f = await fixture();
  await submit(f, {
    kind: 'task.move',
    taskId: 'task-a',
    revision: 1,
    listId: 'list-a',
    listRevision: 1,
    parentId: null,
    previousId: null,
    confirmSubtaskCount: 0,
  });
  const result = await f.service.advance('account-a', op());
  expect(result.operation.state).toBe('succeeded');
  expect(f.calls).toHaveLength(0);
  expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
    revision: 1,
    notes: 'keep this note',
    provider: { position: '100', etag: '"task-v1"' },
  });
});

it('rebases a move after Google only resequenced siblings and refreshes their full order', async () => {
  const f = await reorderingFixture();
  f.tasks.set('google-task', { ...f.tasks.get('google-task'), position: '200', etag: '"sort-v2"' });
  await f.prepare();
  const result = await f.service.advance('account-a', op());
  expect(result.operation.state).toBe('succeeded');
  expect(f.sentEtags).toEqual(['"sort-v2"']);
  expect(await f.queries.getTask('account-a', 'task-a')).toMatchObject({
    notes: 'keep this note',
    provider: { position: '400', etag: '"move-v3"' },
  });
  const step = await f.operations.getStep(op(), 'step-0');
  expect(step?.input).toMatchObject({ task: { provider: { position: '200', etag: '"sort-v2"' } } });
  expect(
    await f.db
      .prepare('SELECT tasks_complete_at,completed_complete_at FROM tasks_lists WHERE id=?')
      .bind('list-a')
      .first(),
  ).toEqual({ tasks_complete_at: null, completed_complete_at: null });
  expect(
    await f.db.prepare('SELECT list_id,mode,page_token FROM tasks_sync_list_work').first(),
  ).toMatchObject({ list_id: 'list-a', mode: 'full', page_token: null });
  expect(
    await f.db.prepare('SELECT default_pending,inventory_pending FROM tasks_sync_jobs').first(),
  ).toEqual({ default_pending: 0, inventory_pending: 0 });
  await expect(
    f.service.prepare({
      operationId: op('second-order-intent'),
      accountId: 'account-a',
      ownerSubject: 'owner',
      command: {
        kind: 'task.move',
        taskId: 'task-b',
        revision: 1,
        listId: 'list-a',
        listRevision: 1,
        parentId: null,
        previousId: null,
        confirmSubtaskCount: 0,
      },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.sentEtags).toHaveLength(1);
});

it('retains the rebased dispatch evidence when a move response is lost', async () => {
  const f = await reorderingFixture();
  f.tasks.set('google-task', { ...f.tasks.get('google-task'), position: '200', etag: '"sort-v2"' });
  f.loseResponse();
  await f.prepare();
  const result = await f.service.advance('account-a', op());
  expect(result.operation.state).toBe('uncertain');
  expect((await f.operations.getStep(op(), 'step-0'))?.input).toMatchObject({
    task: { provider: { etag: '"sort-v2"', position: '200' } },
  });
  await f.service.advance('account-a', op());
  expect(f.sentEtags).toHaveLength(1);
});

it.each([
  ['notes', { notes: 'changed elsewhere' }],
  ['title', { title: 'changed elsewhere' }],
  ['completion', { status: 'completed', completed: '2026-11-02T12:00:00Z' }],
  ['day', { due: '2026-12-01T00:00:00Z' }],
  ['parent', { parent: 'another-parent' }],
])(
  'does not rebase a move when its %s changed with the provider position',
  async (_field, change) => {
    const f = await reorderingFixture();
    f.tasks.set('google-task', {
      ...f.tasks.get('google-task'),
      ...change,
      position: '200',
      etag: '"changed-v2"',
    });
    await f.prepare();
    const result = await f.service.advance('account-a', op());
    expect(result.operation.state).toBe('failed');
    expect(f.sentEtags).toHaveLength(0);
    expect((await f.operations.getStep(op(), 'step-0'))?.state).toBe('failed');
  },
);

it('keeps content edits protected when only the Google version and position changed', async () => {
  const f = await fixture();
  f.tasks.set('google-task', { ...f.tasks.get('google-task'), position: '200', etag: '"sort-v2"' });
  await submit(f, {
    kind: 'task.edit',
    taskId: 'task-a',
    revision: 1,
    patch: { title: 'owner draft' },
  });
  const result = await f.service.advance('account-a', op());
  expect(result.operation.state).toBe('failed');
  expect(f.calls.map((call) => call.method)).toEqual(['GET']);
  expect((await f.queries.getTask('account-a', 'task-a')).title).toBe('original');
});

it('keeps list etag checks when preparing a rename', async () => {
  const f = await fixture();
  const calls: string[] = [];
  const client = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (_input, init) => {
      calls.push(init?.method ?? 'GET');
      return Response.json({ id: 'google-list', title: 'home', etag: '"list-v2"' });
    },
  });
  const service = new TaskCommandService(f.db, { ...f.options, clientFor: async () => client });
  await service.prepare({
    operationId: op(),
    accountId: 'account-a',
    ownerSubject: 'owner',
    command: { kind: 'list.rename', listId: 'list-a', revision: 1, title: 'new name' },
  });
  expect((await service.advance('account-a', op())).operation.state).toBe('failed');
  expect(calls).toEqual(['GET']);
});

it('rejects a captured local no-op if the confirmed sibling order changed before settlement', async () => {
  const f = await fixture();
  await submit(f, {
    kind: 'task.move',
    taskId: 'task-a',
    revision: 1,
    listId: 'list-a',
    listRevision: 1,
    parentId: null,
    previousId: null,
    confirmSubtaskCount: 0,
  });
  await f.db
    .prepare('UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id=?')
    .bind('list-a')
    .run();
  expect((await f.service.advance('account-a', op())).operation.state).toBe('failed');
  expect(f.calls).toHaveLength(0);
});
