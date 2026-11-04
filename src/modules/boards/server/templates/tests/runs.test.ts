import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { assertLocalWritable } from '../../../../accounts/server/connections/access';
import { HistoryService } from '../../../../history/server/events/event-store';
import { ListSnapshotStore, ListTemplateService } from '../../../../tasks/server/templates/lists';
import { TaskMetadataService } from '../../../../tasks/server/metadata/tasks';
import { TaskCommandService } from '../../../../tasks/server/commands/service';
import { OperationStore } from '../../../../operations/server/journal/store';
import { TaskProjectionStore } from '../../../../tasks/server/projection/store';
import { GoogleTasksClient } from '../../../../tasks/server/provider/google-tasks';
import { BoardService } from '../../boards/service';
import { BoardProjection } from '../../boards/projection';
import { BoardTemplateService, readTemplateListAppearance } from '../definitions';
import { TemplateApplicationService } from '../runs';
const now = Date.parse('2026-11-02T12:00:00Z');
const context = {
  operationId: 'save',
  stepKey: 'snapshot',
  origin: 'owner' as const,
  recordedAt: new Date(now).toISOString(),
  saveDay: '2026-11-02',
  zone: 'Europe/Istanbul',
};
const op = (suffix = 'abcdefghijklmnop') => `${now}:${suffix}`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const item of databases.splice(0)) item.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  await seedAccount(db, 'a', now);
  await seedAccount(db, 'b', now);
  const boards = new BoardService(db, {
      assertLocalWritable: (account) => assertLocalWritable(db, account),
    }),
    boardProjection = new BoardProjection(db, boards);
  const main = await boards.ensureMainBoard('a');
  await db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES ('source','a','provider-source','chores',1,?,?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO boards_memberships(account_id,list_id,board_id,position,color) VALUES ('a','source',?,0,'#aabbcc')",
    )
    .bind(main.id)
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,notes,scheduled_day,priority,starred) VALUES ('source-task','a','source','provider-task','read a little','a plain note','2026-11-01','high',1)",
    )
    .run();
  const snapshots = new ListSnapshotStore(db),
    listTemplates = new ListTemplateService(db, {
      snapshots,
      sourceListAppearance: (account, list) => readTemplateListAppearance(db, account, list),
      commitWrites: (writes) => db.batch(writes),
    }),
    boardTemplates = new BoardTemplateService(db, {
      snapshots,
      commitWrites: (writes) => db.batch(writes),
    });
  const saved = await listTemplates.create(
    'a',
    { name: 'weekly', listId: 'source', listRevision: 1 },
    context,
  );
  const boardSaved = await boardTemplates.create(
    'a',
    { name: 'home', boardId: main.id, boardRevision: main.revision },
    context,
  );
  const operations = new OperationStore(db),
    history = new HistoryService(db, { now: () => now }),
    metadata = new TaskMetadataService(db, { history, commitWrites: (writes) => db.batch(writes) }),
    projection = new TaskProjectionStore(db, { history, now: () => now });
  const calls: {
      method: string;
      url: string;
    }[] = [],
    tasks = new Map<string, Record<string, unknown>>();
  let taskNumber = 0,
    listNumber = 0;
  const client = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET',
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ method, url: url.pathname });
      if (method === 'POST' && url.pathname === '/tasks/v1/users/@me/lists')
        return Response.json({
          id: 'new-list-' + ++listNumber,
          title: body.title,
          etag: 'list-v1',
        });
      if (method === 'POST' && url.pathname.endsWith('/tasks')) {
        const value = {
          id: 'new-task-' + ++taskNumber,
          title: body.title,
          notes: body.notes,
          status: 'needsAction',
          etag: 'task-v1',
          position: String(taskNumber),
          ...(body.due ? { due: body.due } : {}),
          ...(url.searchParams.get('parent') ? { parent: url.searchParams.get('parent') } : {}),
        };
        tasks.set(value.id, value);
        return Response.json(value);
      }
      const id = url.pathname.split('/').at(-1)!;
      if (method === 'GET' && tasks.has(id)) return Response.json(tasks.get(id));
      throw new Error('unexpected provider call ' + method + ' ' + url.pathname);
    },
  });
  let application: TemplateApplicationService;
  const commands = new TaskCommandService(db, {
    operations,
    projection,
    history,
    metadata,
    now: () => now,
    clientFor: async () => client,
    validateBoardTarget: async (account, boardId, expectedRevision, operationId) => {
      try {
        const board = await boards.getBoard(account, boardId);
        if (expectedRevision !== undefined && expectedRevision !== board.revision)
          throw new Error('revision');
      } catch (error) {
        if (!operationId) throw error;
        await application.validatePendingBoardTarget(
          account,
          boardId,
          expectedRevision,
          operationId,
        );
      }
    },
    boardTargetGuard: boardProjection.targetGuard.bind(boardProjection),
    placementWrites: boardProjection.creationWrites.bind(boardProjection),
    copyBeginWrites: (account, operationId) => application.prepareBeginWrites(account, operationId),
  });
  application = new TemplateApplicationService(db, {
    snapshots,
    listTemplates,
    boardTemplates,
    boards,
    commands,
    operations,
    now: () => now,
  });
  return {
    ...database,
    boards,
    main,
    snapshots,
    listTemplates,
    boardTemplates,
    saved,
    boardSaved,
    operations,
    commands,
    application,
    calls,
  };
}
const input = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => ({
  template: { kind: 'list', id: f.saved.id, contentRevision: 1 },
  destination: { kind: 'existing', boardId: f.main.id, boardRevision: f.main.revision },
  applicationDay: '2026-12-01',
  useRelativeDates: true,
  listPrefix: 'december',
  confirmed: true,
  ...extra,
});
async function finish(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  for (let turn = 0; turn < 30; turn++) {
    const run = await f.application.advance('a', runId);
    if (run.state === 'succeeded' || run.state === 'paused') return run;
  }
  throw new Error('run failed to settle in bounded steps');
}
describe('template application through captured task commands', () => {
  it('resumes into capture until the copy is fully validated and admitted, without dispatching during validation', async () => {
    const f = await fixture();
    const run = await f.application.begin('a', input(f), {
      operationId: op(),
      ownerSubject: 'owner',
    });
    await f.application.advance('a', run.id);
    await f.application.advance('a', run.id);
    expect(f.calls).toEqual([]);
    await f.db
      .prepare("UPDATE boards_template_runs SET state='paused' WHERE account_id='a' AND id=?")
      .bind(run.id)
      .run();
    expect(await f.application.resume('a', run.id)).toMatchObject({ state: 'capturing' });
    expect(f.calls).toEqual([]);
    expect(await finish(f, run.id)).toMatchObject({ state: 'succeeded' });
  });
  it('previews without writes and creates fresh lists/open tasks with relative days and metadata', async () => {
    const f = await fixture();
    const preview = await f.application.preview(
      'a',
      { kind: 'list', id: f.saved.id, contentRevision: 1 },
      { applicationDay: '2026-12-01', useRelativeDates: true, listPrefix: 'december' },
    );
    expect(preview).toMatchObject({
      listCount: 1,
      taskCount: 1,
      requiredListSlots: 1,
      negativeDateCount: 1,
    });
    expect(f.calls).toEqual([]);
    const run = await f.application.begin('a', input(f), {
      operationId: op(),
      ownerSubject: 'owner',
    });
    expect(f.calls).toEqual([]);
    expect(await finish(f, run.id)).toMatchObject({ state: 'succeeded' });
    expect(
      await f.db
        .prepare(
          "SELECT title,priority,starred,completed,scheduled_day FROM tasks_tasks WHERE provider_id='new-task-1'",
        )
        .first(),
    ).toEqual({
      title: 'read a little',
      priority: 'high',
      starred: 1,
      completed: 0,
      scheduled_day: '2026-11-30',
    });
    expect(
      await f.db
        .prepare("SELECT title FROM tasks_lists WHERE provider_id='new-list-1'")
        .first('title'),
    ).toBe('december chores');
    expect(
      (
        await f.db
          .prepare("SELECT summary_json FROM history_events WHERE kind='task_created'")
          .all<{
            summary_json: string;
          }>()
      ).results.map((row) => JSON.parse(row.summary_json).source),
    ).toEqual(['template']);
    await f.application.begin('a', input(f), { operationId: op(), ownerSubject: 'owner' });
    await f.application.advance('a', run.id);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('captures one revision before deletion/replacement and resumes its own immutable input', async () => {
    const f = await fixture();
    const run = await f.application.begin('a', input(f), {
      operationId: op(),
      ownerSubject: 'owner',
    });
    await f.listTemplates.delete('a', f.saved.id, 0, { ...context, stepKey: 'delete' });
    await f.db
      .prepare(
        "UPDATE tasks_tasks SET title='source changed',notes='different' WHERE id='source-task'",
      )
      .run();
    expect(await finish(f, run.id)).toMatchObject({ state: 'succeeded' });
    expect(
      await f.db
        .prepare("SELECT title,notes FROM tasks_tasks WHERE provider_id='new-task-1'")
        .first(),
    ).toEqual({ title: 'read a little', notes: 'a plain note' });
  });
  it('creates a board only in the initial sealed/quota-admitted local marker', async () => {
    const f = await fixture();
    const before = await f.db
      .prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE account_id='a'")
      .first('n');
    const run = await f.application.begin(
      'a',
      input(f, {
        template: { kind: 'board', id: f.boardSaved.id, contentRevision: 1 },
        destination: { kind: 'new', title: 'a fresh week' },
      }),
      { operationId: op(), ownerSubject: 'owner' },
    );
    expect(
      await f.db.prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE account_id='a'").first('n'),
    ).toBe(before);
    expect(await finish(f, run.id)).toMatchObject({ state: 'succeeded' });
    expect(
      await f.db
        .prepare("SELECT title FROM boards_boards WHERE title='a fresh week'")
        .first('title'),
    ).toBe('a fresh week');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('fails whole-plan quota preflight before creating even an empty destination board', async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE tasks_account_state SET inventory_count=2000 WHERE account_id='a'")
      .run();
    await expect(
      f.application.begin(
        'a',
        input(f, {
          template: { kind: 'board', id: f.boardSaved.id, contentRevision: 1 },
          destination: { kind: 'new', title: 'must not appear' },
        }),
        { operationId: op(), ownerSubject: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'list_limit_reached' });
    expect(f.calls).toEqual([]);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE title='must not appear'")
        .first('n'),
    ).toBe(0);
  });
  it('keeps pending board targets bound to the captured account and exact admitted operation', async () => {
    const f = await fixture();
    const run = await f.application.begin(
      'a',
      input(f, {
        template: { kind: 'board', id: f.boardSaved.id, contentRevision: 1 },
        destination: { kind: 'new', title: 'a fresh week' },
      }),
      { operationId: op(), ownerSubject: 'owner' },
    );
    const data = JSON.parse(
      (await f.db
        .prepare('SELECT captured_json FROM boards_template_runs WHERE id=?')
        .bind(run.id)
        .first<string>('captured_json'))!,
    );
    await f.application.validatePendingBoardTarget('a', data.destinationBoardId, 0, op());
    await expect(
      f.application.validatePendingBoardTarget('b', data.destinationBoardId, 0, op()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      f.application.validatePendingBoardTarget('a', 'arbitrary-board', 0, op()),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.application.prepareBeginWrites('a', op())).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
it('supports an empty board template and creates its board without a provider call', async () => {
  const f = await fixture();
  const empty = await f.boards.createBoard('a', { title: 'empty source' }, 'empty-source'),
    saved = await f.boardTemplates.create(
      'a',
      { name: 'empty', boardId: empty.id, boardRevision: empty.revision },
      context,
    );
  const run = await f.application.begin(
    'a',
    input(f, {
      template: { kind: 'board', id: saved.id, contentRevision: 1 },
      destination: { kind: 'new', title: 'empty copy' },
    }),
    { operationId: op(), ownerSubject: 'owner' },
  );
  expect(await finish(f, run.id)).toMatchObject({ state: 'succeeded' });
  expect(f.calls).toEqual([]);
  expect(
    await f.db
      .prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE title='empty copy'")
      .first('n'),
  ).toBe(1);
});
it('cancels an unadmitted capacity-blocked run without reviving it when the same identity replays', async () => {
  const f = await fixture();
  await f.db
    .prepare("UPDATE tasks_account_state SET inventory_count=2000 WHERE account_id='a'")
    .run();
  await expect(
    f.application.begin('a', input(f), { operationId: op(), ownerSubject: 'owner' }),
  ).rejects.toMatchObject({ code: 'list_limit_reached' });
  const id = await f.db.prepare('SELECT id FROM boards_template_runs').first<string>('id');
  expect(id).not.toBeNull();
  expect(await f.application.cancel('a', id!)).toMatchObject({ state: 'cancelled' });
  await f.db.prepare("UPDATE tasks_account_state SET inventory_count=1 WHERE account_id='a'").run();
  expect(
    await f.application.begin('a', input(f), { operationId: op(), ownerSubject: 'owner' }),
  ).toMatchObject({ state: 'cancelled' });
  expect(await f.operations.get(op(), 'a')).toBeNull();
  expect(f.calls).toEqual([]);
});
