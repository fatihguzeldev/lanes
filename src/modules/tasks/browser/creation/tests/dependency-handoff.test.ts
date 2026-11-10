import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../../server/projection/store';
import { TaskMetadataService } from '../../../server/metadata/tasks';
import { TaskQueries } from '../../../server/queries/tasks';
import { TaskCommandService } from '../../../server/commands/service';
import { GoogleTasksClient } from '../../../server/provider/google-tasks';
import { CreateTaskSchema } from '../../../contracts/task';
import { useTaskChanges } from '../../changes/useTaskChanges';
import { useTaskActions } from '../../actions/useTaskActions';
import { useTaskCreations } from '../useTaskCreations';
import { RequestError } from '../../../../../shared/browser/http/http';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  read: vi.fn(),
  submit: vi.fn(),
  created: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useRef: (current: unknown) => (hooks.slots[hooks.cursor++] ??= { current }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      },
    ];
  },
}));
vi.mock('../../../../../shared/browser/http/http', async (original) => ({
  ...(await original<typeof import('../../../../../shared/browser/http/http')>()),
  request: hooks.read,
}));
vi.mock('../creation-receipt', () => ({ readCreatedTask: hooks.created }));
vi.mock('../../../../operations/browser/submission/useCommands', () => ({
  useCommands: () => ({ submit: hooks.submit, busy: false }),
}));

const now = Date.parse('2026-11-10T12:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.read.mockReset();
  hooks.submit.mockReset();
  hooks.created.mockReset();
});

async function fixture() {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  await seedAccount(db, 'account-a', now);
  await seedAccount(db, 'account-b', now);
  for (const account of ['a', 'b'])
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES (?,?,?,?,1,?,?)',
      )
      .bind('list-' + account, 'account-' + account, 'google-list-' + account, account, now, now)
      .run();
  const history = new HistoryService(db, { now: () => now });
  const projection = new TaskProjectionStore(db, { history, now: () => now });
  const metadata = new TaskMetadataService(db, {
    history,
    commitWrites: async (writes) => {
      await db.batch(writes);
    },
  });
  const queries = new TaskQueries(db);
  await db.batch(
    (
      await projection.prepareConfirmedWrites(
        'account-a',
        'list-a',
        ['A', 'B'].map((id) => ({ id, title: id, status: 'needsAction', etag: id, position: id })),
        {
          knownTaskIds: new Map([
            ['A', 'A'],
            ['B', 'B'],
          ]),
        },
      )
    ).writes,
  );
  await db.batch(
    (
      await projection.prepareConfirmedWrites(
        'account-b',
        'list-b',
        [
          {
            id: 'foreign',
            title: 'foreign',
            status: 'needsAction',
            etag: 'foreign',
            position: '0',
          },
        ],
        { knownTaskIds: new Map([['foreign', 'foreign']]) },
      )
    ).writes,
  );
  const client = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/tasks'))
        return Response.json({
          id: 'google-created',
          title: 'pending',
          status: 'needsAction',
          etag: 'created',
          position: '0',
        });
      if (url.pathname.endsWith('/lists/google-list-a'))
        return Response.json({ id: 'google-list-a', title: 'a' });
      throw new Error('unexpected provider request: ' + url.pathname);
    },
  });
  const service = new TaskCommandService(db, {
    operations: createOperationStore(db),
    projection,
    history,
    queries,
    metadata,
    now: () => now,
    clientFor: async () => client,
    validateBoardTarget: async () => {},
    placementWrites: () => [],
  });
  let sequence = 0;
  const operation = () => `${now}:operation-${String(++sequence).padStart(8, '0')}`;
  const drain = async (id: string) => {
    for (let turn = 0; turn < 20; turn++) {
      const result = await service.advance('account-a', id);
      if (result.operation.finished) return result.operation;
    }
    throw new Error('operation did not finish');
  };
  const input = CreateTaskSchema.parse({
    accountId: 'account-a',
    listId: 'list-a',
    title: 'pending',
    blockedBy: ['A'],
  });
  const createdOperation = operation();
  const { accountId: _accountId, ...create } = input;
  await service.capture.prepare({
    accountId: 'account-a',
    ownerSubject: 'owner',
    operationId: createdOperation,
    command: {
      kind: 'task.create',
      ...create,
      listRevision: 1,
      previousId: null,
      expectedGraphRevision: 0,
    } as never,
  });
  expect((await drain(createdOperation)).state).toBe('succeeded');
  const created = (
    await queries.listTasks('account-a', { listIds: ['list-a'] }, { today: '2026-11-10', now })
  ).items.find((task) => task.title === 'pending')!;
  expect(await metadata.getGraphRevision('account-a')).toBe(1);
  let afterGraphRead: (() => Promise<void>) | undefined;
  hooks.created.mockImplementation(() => queries.getTask('account-a', created.id));
  hooks.read.mockImplementation(async (path: string) => {
    if (path.endsWith('/dependency-graph')) {
      const revision = await metadata.getGraphRevision('account-a');
      await afterGraphRead?.();
      return { revision };
    }
    return queries.getTask('account-a', decodeURIComponent(path.split('/').at(-1)!));
  });
  hooks.submit.mockImplementation(async (command, _category, _identity, onFailure) => {
    const id = operation();
    try {
      await service.capture.prepare({
        accountId: 'account-a',
        ownerSubject: 'owner',
        operationId: id,
        command,
      });
      return await drain(id);
    } catch (error) {
      const failure = error as { code: string; message: string };
      onFailure?.(new RequestError(failure.code, failure.message));
      return null;
    }
  });
  const options = {
    accountId: 'account-a',
    submit: vi.fn(),
    confirm: vi.fn(),
    onNotice: vi.fn(),
    onChanged: vi.fn(),
    onRepeat: vi.fn(),
    onReopen: vi.fn(),
    onTaskDeleted: vi.fn(),
    onListDeleteReady: vi.fn(),
  };
  const render = () => {
    hooks.cursor = 0;
    const changes = useTaskChanges('account-a', 0);
    const actions = useTaskActions({ ...options, changes }, 0);
    return useTaskCreations('account-a', 0, { onReady: actions.applyCreation });
  };
  render().start(1, input);
  const patchEdges = async (taskId: string, blockedBy: string[]) => {
    const task = await queries.getTask('account-a', taskId);
    await metadata.patchTask(
      'account-a',
      taskId,
      { blockedBy },
      task.revision,
      {
        operationId: operation(),
        stepKey: 'metadata',
        origin: 'owner',
        recordedAt: new Date(now).toISOString(),
      },
      await metadata.getGraphRevision('account-a'),
    );
  };
  return {
    render,
    input,
    created,
    createdOperation,
    metadata,
    queries,
    patchEdges,
    onGraphRead: (callback: () => Promise<void>) => {
      afterGraphRead = callback;
    },
  };
}

it('rebases pending dependency edits over their own confirmed create graph change', async () => {
  const f = await fixture();
  f.render().update(1, { ...f.input, blockedBy: [] }, 0);
  await f.render().finish(1, f.createdOperation);
  expect(f.render().items[0]!.failure).toBeUndefined();
  expect((await f.queries.getTask('account-a', f.created.id)).blockedBy).toEqual([]);
  expect(hooks.submit.mock.calls[0]![0]).toMatchObject({ expectedGraphRevision: 1 });
  expect(hooks.submit.mock.calls[0]![0]).not.toHaveProperty('baselineBlockedBy');
});

it('does not replace external edges observed before the first identity read', async () => {
  const f = await fixture();
  await f.patchEdges(f.created.id, ['B']);
  f.render().update(1, { ...f.input, blockedBy: [] }, 2);
  await f.render().finish(1, f.createdOperation);
  expect(hooks.submit).not.toHaveBeenCalled();
  expect((await f.queries.getTask('account-a', f.created.id)).blockedBy).toEqual(['B']);
  expect(f.render().items[0]!.failure?.message).toContain('changed');
});

it('rebases a later pending edit over the graph revision produced by its preceding edit', async () => {
  const f = await fixture();
  f.render().update(1, { ...f.input, blockedBy: [] }, 0);
  await f.render().finish(1, f.createdOperation);
  f.render().update(1, { ...f.input, blockedBy: ['B'] }, 0);
  await f.render().finish(1, f.createdOperation);
  expect((await f.queries.getTask('account-a', f.created.id)).blockedBy).toEqual(['B']);
  expect(hooks.submit.mock.calls.map((call) => call[0].expectedGraphRevision)).toEqual([1, 2]);
  expect(f.render().items[0]!.failure).toBeUndefined();
});

it('still rejects a dependency graph changed after the fresh graph read', async () => {
  const f = await fixture();
  f.onGraphRead(() => f.patchEdges('A', ['B']));
  f.render().update(1, { ...f.input, blockedBy: [] }, 0);
  await f.render().finish(1, f.createdOperation);
  expect(await f.metadata.getGraphRevision('account-a')).toBe(2);
  expect((await f.queries.getTask('account-a', f.created.id)).blockedBy).toEqual(['A']);
  expect(f.render().items[0]!.failure?.message).toContain('graph changed');
});

it.each(['cycle', 'foreign'])('retains server validation for %s blocker choices', async (kind) => {
  const f = await fixture();
  if (kind === 'cycle') await f.patchEdges('B', [f.created.id]);
  f.render().update(1, { ...f.input, blockedBy: [kind === 'cycle' ? 'B' : 'foreign'] }, 0);
  await f.render().finish(1, f.createdOperation);
  expect((await f.queries.getTask('account-a', f.created.id)).blockedBy).toEqual(['A']);
  expect(f.render().items[0]!.failure?.message).toBe(
    kind === 'cycle'
      ? 'this dependency would create a cycle'
      : 'choose retained blockers from this account',
  );
});
