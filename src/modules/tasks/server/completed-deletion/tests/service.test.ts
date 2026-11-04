import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { GoogleTasksClient, type GoogleTaskDTO, type GoogleTasksFetch } from '../../provider/google-tasks';
import { OperationStore } from '../../../../operations/server/journal/store';
import { TaskProjectionStore } from '../../projection/store';
import { TaskCommandService } from '../../commands/service';
import { TaskQueries } from '../../queries/tasks';
import { CompletedTaskDeletionService } from '../service';
import { AppError } from '../../../../../shared/contracts/errors';
import { invocationDatabase } from '../../../../../../tests/d1-invocation';
import type { D1Database } from '@cloudflare/workers-types';

const initial = Date.parse('2026-11-02T12:00:00Z'),
  id = `${initial}:completeddelete1`;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
async function fixture() {
  const database = testDatabase();
  closes.push(database.close);
  let invocation = invocationDatabase(database.db, 100000);
  const db = new Proxy(database.db, {
    get(_target, key) {
      return Reflect.get(invocation.db, key);
    },
  }) as D1Database;
  await seedAccount(db, 'a', initial);
  let now = initial;
  await db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at)VALUES('list','a','google-list','home',1,?,?)",
    )
    .bind(initial, initial)
    .run();
  const history = new HistoryService(db, { now: () => now }),
    projection = new TaskProjectionStore(db, { history, now: () => now });
  const entries: GoogleTaskDTO[] = [
    {
      id: 'parent',
      title: 'completed parent',
      status: 'completed',
      completed: new Date(initial).toISOString(),
      etag: 'p1',
    },
    {
      id: 'open-child',
      title: 'open child will also be deleted',
      parent: 'parent',
      status: 'needsAction',
      etag: 'c1',
      assignmentInfo: { surfaceType: 'DOCUMENT' },
    },
    {
      id: 'done-child',
      title: 'completed child',
      parent: 'parent',
      status: 'completed',
      completed: new Date(initial).toISOString(),
      etag: 'c2',
    },
    { id: 'open-parent', title: 'preserved open parent', status: 'needsAction', etag: 'o1' },
    {
      id: 'leaf',
      title: 'completed child of open parent',
      parent: 'open-parent',
      status: 'completed',
      completed: new Date(initial).toISOString(),
      etag: 'l1',
    },
  ];
  await db.batch(
    (
      await projection.prepareConfirmedWrites('a', 'list', entries, {
        knownTaskIds: new Map(entries.map((item) => [item.id, item.id])),
      })
    ).writes,
  );
  const provider = new Map(entries.map((item) => [item.id, item])),
    calls: string[] = [];
  let rejectTask: string | undefined;
  let onDelete: (() => Promise<void>) | undefined;
  let lose = false,
    onRead: (() => Promise<void>) | undefined;
  const transport: GoogleTasksFetch = async (input, init) => {
    const method = init?.method ?? 'GET',
      taskId = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1)!);
    calls.push(method + ':' + taskId);
    const task = provider.get(taskId);
    if (method === 'GET' && onRead) {
      const callback = onRead;
      onRead = undefined;
      await callback();
    }
    if (method === 'GET')
      return task ? Response.json(task) : Response.json({ error: { code: 404 } }, { status: 404 });
    if (method === 'DELETE') {
      if (taskId === rejectTask) return Response.json({ error: { code: 403 } }, { status: 403 });
      provider.delete(taskId);
      for (const child of provider.values()) if (child.parent === taskId) provider.delete(child.id);
      if (onDelete) {
        const callback = onDelete;
        onDelete = undefined;
        await callback();
      }
      if (lose) throw Error('accepted deletion but response lost');
      return new Response(null, { status: 204 });
    }
    throw Error('unexpected mutation');
  };
  let service: CompletedTaskDeletionService;
  const operations = new OperationStore(db),
    commands = new TaskCommandService(db, {
      operations,
      projection,
      history,
      now: () => now,
      clientFor: async () => new GoogleTasksClient({ accessToken: 'fixture', fetch: transport }),
      confirmedTaskDeletionWrites: (account, operation, task) =>
        service.prepareConfirmedDeletionWrites(account, operation, task),
      taskDeletionDispatchGuards: (account, operation, task) =>
        service.prepareDispatchGuards(account, operation, task),
    });
  service = new CompletedTaskDeletionService(db, { operations, commands, now: () => now });
  const begin = () =>
    service.begin({ id, accountId: 'a', listId: 'list', listRevision: 1, ownerSubject: 'owner' });
  async function preview() {
    let summary = await begin();
    for (let n = 0; n < 10 && summary.state === 'capturing'; n++)
      summary = await service.captureNext('a', id);
    return summary;
  }
  return {
    ...database,
    db,
    service,
    operations,
    commands,
    provider,
    calls,
    begin,
    preview,
    queries: new TaskQueries(db),
    lose: () => {
      lose = true;
    },
    reject: (task: string) => {
      rejectTask = task;
    },
    onRead: (callback: () => Promise<void>) => {
      onRead = callback;
    },
    onDelete: (callback: () => Promise<void>) => {
      onDelete = callback;
    },
    resetBudget: (limit = 50) => {
      invocation = invocationDatabase(database.db, limit);
    },
    queriesUsed: () => invocation.queries,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
it('freezes completed selection and named open descendants before explicit consequence acknowledgements and permanent task deletes', async () => {
  const f = await fixture(),
    preview = await f.preview();
  expect(preview).toMatchObject({
    state: 'preview',
    selectedCompletedCount: 3,
    totalDeleteCount: 4,
    openDescendantCount: 1,
    assignedTaskCount: 1,
    rootCount: 2,
    capturedCount: 4,
  });
  expect(f.calls).toHaveLength(0);
  expect((await f.service.readPreview('a', id)).items.map((item) => item.title)).toContain(
    'open child will also be deleted',
  );
  await expect(
    f.service.confirm('a', id, {
      previewHash: preview.previewHash,
      confirm: true,
      confirmOpenDescendantCount: 0,
      confirmAssignedTaskCount: 1,
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(f.calls).toHaveLength(0);
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  let summary = await f.service.get('a', id);
  for (let n = 0; n < 10 && summary.state === 'running'; n++)
    summary = await f.service.advance('a', id);
  expect(summary).toMatchObject({
    state: 'finished',
    deletedCount: 4,
    deletedRootCount: 2,
    failedRootCount: 0,
  });
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(2);
  expect([...f.provider.keys()]).toEqual(['open-parent']);
  expect(
    (await f.service.readPreview('a', id)).items.every((item) => item.state === 'deleted'),
  ).toBe(true);
});

it('captures at most ten records per slice and keeps the single active list selection visible before old receipts', async () => {
  const f = await fixture();
  for (let n = 0; n < 12; n++)
    await f.db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,completed)VALUES(?,'a','list',?,'another completed task',1)",
      )
      .bind('extra-' + String(n).padStart(2, '0'), 'extra-' + n)
      .run();
  let summary = await f.begin();
  summary = await f.service.captureNext('a', id);
  expect(summary).toMatchObject({ capturedCount: 10, state: 'capturing' });
  summary = await f.service.captureNext('a', id);
  expect(summary).toMatchObject({ capturedCount: 16, state: 'preview' });
  await expect(
    f.service.begin({
      id: `${initial}:anotherdelete001`,
      accountId: 'a',
      listId: 'list',
      listRevision: 1,
      ownerSubject: 'owner',
    }),
  ).rejects.toMatchObject({ code: 'conflict', fields: { deletionId: id } });
  for (let n = 0; n < 11; n++)
    await f.db
      .prepare(
        "INSERT INTO tasks_completed_deletions SELECT ?,account_id,owner_subject,list_id,provider_list_id,list_title,list_revision,projection_revision,?, 'cancelled',selected_count,total_count,open_count,assigned_count,root_count,captured_count,deleted_count,deleted_roots,failed_roots,cancelled_roots,capture_cursor,capture_hash,preview_hash,NULL,NULL,NULL,work_order,error_code,created_at-1,updated_at,created_at,payload_pruned_at FROM tasks_completed_deletions WHERE id=?",
      )
      .bind(`${initial}:oldreceipt${String(n).padStart(6, '0')}`, 'old-hash-' + n, id)
      .run();
  expect((await f.service.list('a', 'list')).items[0]?.id).toBe(id);
  const first = await f.service.readPreview('a', id, { limit: 10 });
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).not.toBe(null);
  const second = await f.service.readPreview('a', id, { cursor: first.nextCursor! });
  expect(second.items).toHaveLength(6);
  expect(new Set([...first.items, ...second.items].map((item) => item.taskId)).size).toBe(16);
  expect(f.calls).toHaveLength(0);
});

it('keeps per-root definite failures and confirmed output while an explicit resume continues only the remaining roots', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  f.reject('leaf');
  await f.service.advance('a', id);
  let summary = await f.service.advance('a', id);
  expect(summary).toMatchObject({
    state: 'partial',
    failedRootCount: 1,
    deletedCount: 0,
    pendingRootCount: 1,
  });
  await f.service.resume('a', id);
  summary = await f.service.get('a', id);
  for (let n = 0; n < 10 && summary.state === 'running'; n++)
    summary = await f.service.advance('a', id);
  expect(summary).toMatchObject({
    state: 'partial',
    deletedCount: 3,
    deletedRootCount: 1,
    failedRootCount: 1,
    pendingRootCount: 0,
  });
  expect(summary.finishedAt).not.toBe(null);
  expect(f.calls.filter((call) => call === 'DELETE:leaf')).toHaveLength(1);
  expect(f.calls.filter((call) => call === 'DELETE:parent')).toHaveLength(1);
  expect(
    (await f.service.readPreview('a', id)).items.find((item) => item.taskId === 'leaf'),
  ).toMatchObject({ state: 'failed', error: { code: 'forbidden' } });
});

it('cancels a captured but unadmitted child journal without creating provider work', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  const admit = f.operations.admit.bind(f.operations);
  f.operations.admit = async () => {
    throw new AppError('storage_unavailable', 'injected admission interruption', 503, true);
  };
  expect((await f.service.advance('a', id)).state).toBe('paused');
  f.operations.admit = admit;
  const result = await f.service.cancel('a', id);
  expect(result.state).toBe('cancelled');
  expect(result.finishedAt).not.toBe(null);
  expect(f.calls).toHaveLength(0);
  expect(
    (await f.operations.list('a')).items.every(
      (item) => item.finished && item.state === 'cancelled',
    ),
  ).toBe(true);
});

it('fences cancellation during provider preflight before the irreversible DELETE is dispatched', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  await f.service.advance('a', id);
  f.onRead(async () => {
    await f.service.cancel('a', id);
  });
  expect((await f.service.advance('a', id)).state).toBe('cancelled');
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(0);
  expect(f.provider.size).toBe(5);
});

it('settles a cancelled ambiguous deletion only from the common exact-address resolution and leaves unsent roots intact', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  await f.service.advance('a', id);
  f.lose();
  const uncertain = await f.service.advance('a', id);
  expect(uncertain.state).toBe('uncertain');
  const cancelled = await f.service.cancel('a', id);
  expect(cancelled.finishedAt).toBe(null);
  f.tick(31_000);
  const proof = await f.commands.resolutions.preview('a', uncertain.operationId!, {});
  await f.commands.resolutions.confirm('a', uncertain.operationId!, {
    previewHash: proof.previewHash,
    confirm: true,
  });
  await f.commands.advance('a', uncertain.operationId!);
  const result = await f.service.cancel('a', id);
  expect(result).toMatchObject({ state: 'cancelled', deletedCount: 1, deletedRootCount: 1 });
  expect(result.finishedAt).not.toBe(null);
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
  expect(f.provider.has('parent')).toBe(true);
});

it('keeps a confirmed root checkpoint separate from a later external list edit', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  await f.service.advance('a', id);
  expect((await f.service.advance('a', id)).deletedCount).toBe(1);
  await f.db
    .prepare("UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id='list'")
    .run();
  expect(await f.service.advance('a', id)).toMatchObject({ state: 'stale', deletedCount: 1 });
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
});

it('does not absorb an external edit made while an earlier DELETE was in flight into its own bulk progress', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  await f.service.advance('a', id);
  f.onDelete(async () => {
    await f.db
      .prepare("UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id='list'")
      .run();
  });
  expect((await f.service.advance('a', id)).deletedCount).toBe(1);
  expect(await f.service.advance('a', id)).toMatchObject({ state: 'stale', deletedCount: 1 });
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
});
it('finishes an empty selection without provider calls and measures each nonempty advance within the free invocation headroom', async () => {
  const empty = await fixture();
  await empty.db.prepare('UPDATE tasks_tasks SET completed=0').run();
  const zero = await empty.preview();
  expect(zero.totalDeleteCount).toBe(0);
  expect(
    await empty.service.confirm('a', id, {
      previewHash: zero.previewHash,
      confirm: true,
      confirmOpenDescendantCount: 0,
      confirmAssignedTaskCount: 0,
    }),
  ).toMatchObject({ state: 'finished', deletedCount: 0 });
  expect(empty.calls).toHaveLength(0);
  const f = await fixture(),
    preview = await f.preview();
  f.resetBudget(40);
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  expect(f.queriesUsed()).toBeLessThanOrEqual(40);
  let summary = await f.service.get('a', id);
  const measured: number[] = [];
  for (let n = 0; n < 10 && summary.state === 'running'; n++) {
    f.resetBudget(40);
    summary = await f.service.advance('a', id);
    measured.push(f.queriesUsed());
    expect(f.queriesUsed()).toBeLessThanOrEqual(40);
  }
  expect(summary.state).toBe('finished');
  expect(Math.max(...measured)).toBeLessThanOrEqual(30);
});

it('admits one concurrent list capture and replays the same actor and selection independently of property order', async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([
    f.begin(),
    f.service.begin({
      ownerSubject: 'owner',
      listRevision: 1,
      listId: 'list',
      accountId: 'a',
      id: `${initial}:concurrentdelete1`,
    }),
  ]);
  expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  const rejected = attempts.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: 'conflict' });
  const winner = (
    attempts.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof f.begin>>
    >
  ).value;
  expect(
    await f.service.begin({
      ownerSubject: 'owner',
      listRevision: 1,
      listId: 'list',
      accountId: 'a',
      id: winner.id,
    }),
  ).toMatchObject({ id: winner.id });
  expect(f.calls).toHaveLength(0);
});

it('prunes only settled payloads within an actual shared row budget and rejects the expired identity after receipt cleanup', async () => {
  const f = await fixture();
  await f.preview();
  await f.service.cancel('a', id);
  const changes = () => Number(f.sqlite.prepare('SELECT total_changes()AS n').get()?.n);
  for (let n = 0; n < 10; n++) {
    const before = changes(),
      count = await f.service.cleanup(2, initial + 2 * 86400000);
    expect(count).toBeLessThanOrEqual(2);
    expect(changes() - before).toBe(count);
  }
  expect(
    (await f.service.readPreview('a', id)).items.every(
      (item) => item.title === null && !item.payloadRetained,
    ),
  ).toBe(true);
  await f.db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
  expect(await f.begin()).toMatchObject({ state: 'cancelled', payloadRetained: false });
  for (let n = 0; n < 10; n++) {
    const before = changes(),
      count = await f.service.cleanup(2, initial + 91 * 86400000);
    expect(changes() - before).toBe(count);
    expect(count).toBeLessThanOrEqual(2);
  }
  f.tick(91 * 86400000);
  await expect(f.begin()).rejects.toMatchObject({ code: 'conflict' });
  const g = await fixture(),
    preview = await g.preview();
  await g.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  await g.service.advance('a', id);
  g.lose();
  await g.service.advance('a', id);
  await g.service.cancel('a', id);
  expect(await g.service.cleanup(100, initial + 91 * 86400000)).toBe(0);
  expect((await g.service.readPreview('a', id)).items.every((item) => item.payloadRetained)).toBe(
    true,
  );
});

it('removes deletion evidence child first only in the account-removal phase with an exact mutation budget', async () => {
  const f = await fixture();
  await f.preview();
  await f.service.cancel('a', id);
  await expect(f.service.removeAccountSlice('a', 2)).rejects.toBeDefined();
  await f.db
    .prepare(
      "UPDATE accounts_connections SET state='disconnected',removal_requested_at=?,grant_ciphertext=NULL WHERE id='a'",
    )
    .bind(initial)
    .run();
  const changes = () => Number(f.sqlite.prepare('SELECT total_changes()AS n').get()?.n);
  let done = false;
  for (let n = 0; n < 10 && !done; n++) {
    const before = changes(),
      result = await f.service.removeAccountSlice('a', 2);
    expect(result.deleted).toBeLessThanOrEqual(2);
    expect(changes() - before).toBe(result.deleted);
    done = result.done;
  }
  expect(done).toBe(true);
  expect(
    await f.db.prepare('SELECT COUNT(*)AS n FROM tasks_completed_deletion_items').first('n'),
  ).toBe(0);
  expect(await f.db.prepare('SELECT COUNT(*)AS n FROM tasks_tasks').first('n')).toBe(5);
});

function delayFirstBatch(db: D1Database) {
  let ready!: () => void,
    release!: () => void,
    held = true;
  const started = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  return {
    started,
    release,
    db: new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: Parameters<D1Database['batch']>[0]) => {
            if (held) {
              held = false;
              ready();
              await released;
            }
            return target.batch(statements);
          };
        return Reflect.get(target, key);
      },
    }),
  };
}
it('returns an active-selection conflict when another capture wins after its initial active check', async () => {
  const f = await fixture(),
    delay = delayFirstBatch(f.db),
    service = new CompletedTaskDeletionService(delay.db, {
      operations: f.operations,
      commands: f.commands,
      now: () => initial,
    });
  const pending = service.begin({
    id,
    accountId: 'a',
    ownerSubject: 'owner',
    listId: 'list',
    listRevision: 1,
  });
  await delay.started;
  const winner = await f.service.begin({
    id: `${initial}:concurrentwinner1`,
    accountId: 'a',
    ownerSubject: 'owner',
    listId: 'list',
    listRevision: 1,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'conflict',
    fields: { deletionId: winner.id },
  });
  delay.release();
  await rejected;
  expect(f.calls).toHaveLength(0);
});
it('returns the same admitted selection when an identical confirmation wins its atomic fence first', async () => {
  const f = await fixture(),
    preview = await f.preview(),
    delay = delayFirstBatch(f.db),
    service = new CompletedTaskDeletionService(delay.db, {
      operations: f.operations,
      commands: f.commands,
      now: () => initial,
    });
  const input = {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  };
  const pending = service.confirm('a', id, input);
  await delay.started;
  await f.service.confirm('a', id, input);
  const replay = expect(pending).resolves.toMatchObject({ state: 'running' });
  delay.release();
  await replay;
  expect(f.calls).toHaveLength(0);
});

it('renews only a provably unadmitted expired child identity and retains the same frozen deletion selection', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  const admit = f.operations.admit.bind(f.operations);
  f.operations.admit = async () => {
    throw new AppError(
      'storage_unavailable',
      'capture committed before admission interruption',
      503,
      true,
    );
  };
  await f.service.advance('a', id);
  f.operations.admit = admit;
  const old = (await f.service.get('a', id)).operationId!;
  expect(await f.operations.get(old, 'a')).toBe(null);
  f.tick(2 * 86400000);
  await f.service.resume('a', id);
  await f.service.advance('a', id);
  const renewed = await f.service.advance('a', id);
  expect(renewed.operationId).not.toBe(old);
  expect(renewed.previewHash).toBe(preview.previewHash);
  expect(f.calls).toHaveLength(0);
  expect((await f.service.advance('a', id)).deletedCount).toBe(1);
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
});
it('keeps a stale frozen preview and never silently captures a replacement selection', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.db
    .prepare("UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id='list'")
    .run();
  await expect(
    f.service.confirm('a', id, {
      previewHash: preview.previewHash,
      confirm: true,
      confirmOpenDescendantCount: 1,
      confirmAssignedTaskCount: 1,
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.service.get('a', id)).toMatchObject({ state: 'stale', deletedCount: 0 });
  expect(f.calls).toHaveLength(0);
});
it('retains an ambiguous per-task outcome and never repeats the issued deletion', async () => {
  const f = await fixture(),
    preview = await f.preview();
  await f.service.confirm('a', id, {
    previewHash: preview.previewHash,
    confirm: true,
    confirmOpenDescendantCount: 1,
    confirmAssignedTaskCount: 1,
  });
  f.lose();
  await f.service.advance('a', id); // admit only; no provider write in this slice
  const summary = await f.service.advance('a', id);
  expect(summary).toMatchObject({ state: 'uncertain' });
  expect(summary.operationId).not.toBe(null);
  f.tick(31_000);
  await f.service.advance('a', id);
  await f.service.resume('a', id);
  expect((await f.service.get('a', id)).state).toBe('uncertain');
  expect(f.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
});
