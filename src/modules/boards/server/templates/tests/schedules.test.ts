import { afterEach, describe, expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { assertLocalWritable } from '../../../../accounts/server/connections/access';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskCommandService } from '../../../../tasks/server/commands/service';
import { TaskMetadataService } from '../../../../tasks/server/metadata/tasks';
import { TaskProjectionStore } from '../../../../tasks/server/projection/store';
import { GoogleTasksClient } from '../../../../tasks/server/provider/google-tasks';
import { ListSnapshotStore } from '../../../../tasks/server/templates/snapshots';
import { ListTemplateService } from '../../../../tasks/server/templates/definitions';
import { BoardProjection } from '../../boards/projection';
import { BoardService } from '../../boards/service';
import { BoardTemplateService, readTemplateListAppearance } from '../definitions';
import { TemplateApplicationService } from '../runs';
import { TemplateScheduleService } from '../schedules';
const start = Date.parse('2026-11-02T12:00:00Z');
const context = (key = 'one', now = start) => ({
  operationId: 'schedule-edit',
  stepKey: key,
  origin: 'owner' as const,
  recordedAt: new Date(now).toISOString(),
});
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  let tick = start;
  await seedAccount(db, 'a', tick);
  const boards = new BoardService(db, {
      assertLocalWritable: (account) => assertLocalWritable(db, account),
    }),
    boardProjection = new BoardProjection(db, boards),
    main = await boards.ensureMainBoard('a');
  await db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES ('source','a','provider-source','chores',1,?,?)",
    )
    .bind(tick, tick)
    .run();
  await db
    .prepare(
      "INSERT INTO boards_memberships(account_id,list_id,board_id,position) VALUES ('a','source',?,0)",
    )
    .bind(main.id)
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES ('task','a','source','provider-task','read')",
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
    }),
    saved = await listTemplates.create(
      'a',
      { name: 'weekly', listId: 'source', listRevision: 1 },
      { ...context(), saveDay: '2026-11-02', zone: 'Europe/Istanbul' },
    );
  const operations = createOperationStore(db),
    history = new HistoryService(db, { now: () => tick }),
    metadata = new TaskMetadataService(db, { history, commitWrites: (writes) => db.batch(writes) }),
    projection = new TaskProjectionStore(db, { history, now: () => tick });
  let providerCalls = 0,
    listNumber = 0,
    taskNumber = 0;
  const tasks = new Map<string, unknown>();
  const client = new GoogleTasksClient({
    accessToken: 'token',
    fetch: async (input, init) => {
      providerCalls++;
      const url = new URL(String(input)),
        body = init?.body ? JSON.parse(String(init.body)) : {};
      if (init?.method === 'POST' && url.pathname === '/tasks/v1/users/@me/lists')
        return Response.json({ id: 'list-' + ++listNumber, title: body.title, etag: 'one' });
      if (init?.method === 'POST' && url.pathname.endsWith('/tasks')) {
        const task = {
          id: 'task-' + ++taskNumber,
          title: body.title,
          notes: body.notes,
          status: 'needsAction',
          position: String(taskNumber),
          etag: 'one',
        };
        tasks.set(task.id, task);
        return Response.json(task);
      }
      return Response.json(tasks.get(url.pathname.split('/').at(-1)!) ?? { error: { code: 404 } });
    },
  });
  const commands = new TaskCommandService(db, {
    operations,
    history,
    metadata,
    projection,
    clientFor: async () => client,
    now: () => tick,
    validateBoardTarget: async (account, boardId, revision) => {
      const board = await boards.queries.getBoard(account, boardId);
      if (revision !== undefined && board.revision !== revision) throw new Error('revision');
    },
    boardTargetGuard: boardProjection.targetGuard.bind(boardProjection),
    placementWrites: boardProjection.creationWrites.bind(boardProjection),
  });
  const applications = new TemplateApplicationService(db, {
      snapshots,
      listTemplates,
      boardTemplates,
      boards,
      boardQueries: boards.queries,
      commands,
      operations,
      now: () => tick,
    }),
    schedules = new TemplateScheduleService(db, {
      applications,
      boardQueries: boards.queries,
      ownerSubjectFor: async () => 'owner',
      commitWrites: (writes) => db.batch(writes),
      now: () => tick,
    });
  return {
    ...database,
    boards,
    main,
    saved,
    snapshots,
    listTemplates,
    applications,
    schedules,
    operations,
    commands,
    calls: () => providerCalls,
    now: () => tick,
    setNow: async (value: number, refresh = true) => {
      tick = value;
      if (refresh)
        await db
          .prepare("UPDATE tasks_account_state SET inventory_complete_at=? WHERE account_id='a'")
          .bind(tick)
          .run();
    },
  };
}
const definition = (
  f: Awaited<ReturnType<typeof fixture>>,
  timing: unknown = {
    frequency: 'weekly',
    weekday: 1,
    zone: 'Europe/Istanbul',
    startsOn: '2026-11-02',
  },
) => ({
  template: { kind: 'list', id: f.saved.id, contentRevision: 1 },
  boardId: f.main.id,
  boardRevision: f.main.revision,
  timing,
  useRelativeDates: true,
  listPrefix: '',
});
describe('durable template schedule slots', () => {
  it('claims one schedule/local-day across overlapping ticks with captured input and zero premature provider calls', async () => {
    const f = await fixture(),
      schedule = await f.schedules.create('a', definition(f), context(), 'schedule');
    expect(schedule.nextRunAt).toBe('2026-11-01T21:00:00.000Z');
    await Promise.all([f.schedules.advanceOne(), f.schedules.advanceOne()]);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM boards_template_runs').first('n')).toBe(1);
    expect(
      await f.db
        .prepare("SELECT last_claimed_day FROM boards_template_schedules WHERE id='schedule'")
        .first('last_claimed_day'),
    ).toBe('2026-11-02');
    expect(f.calls()).toBe(0);
    expect((await f.schedules.get('a', 'schedule')).activeRunId).not.toBeNull();
  });
  it('uses latest missed slot and records older slots as a compressed skipped range without a backlog', async () => {
    const f = await fixture();
    await f.schedules.create('a', definition(f), context(), 'schedule');
    await f.setNow(Date.parse('2026-12-14T12:00:00Z'));
    const claim = await f.schedules.advanceOne();
    expect(claim.kind).toBe('claimed');
    expect(await f.db.prepare('SELECT slot_day FROM boards_template_runs').first('slot_day')).toBe(
      '2026-12-14',
    );
    expect(
      await f.db.prepare('SELECT after_day,through_day,reason FROM boards_template_skips').first(),
    ).toEqual({ after_day: '2026-11-01', through_day: '2026-12-07', reason: 'older_missed_slots' });
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM boards_template_runs').first('n')).toBe(1);
  });
  it('requires an explicit catch-up choice after expiry and can skip without claiming a fictitious run', async () => {
    const f = await fixture();
    await f.schedules.create('a', definition(f), context(), 'schedule');
    await f.db
      .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id='a'")
      .run();
    expect(await f.schedules.advanceOne()).toMatchObject({ kind: 'paused' });
    await f.setNow(Date.parse('2026-12-14T12:00:00Z'));
    await f.db.prepare("UPDATE accounts_connections SET state='connected' WHERE id='a'").run();
    expect(await f.schedules.advanceOne()).toMatchObject({ kind: 'idle' });
    const paused = await f.schedules.get('a', 'schedule');
    const resumed = await f.schedules.resume(
      'a',
      'schedule',
      paused.revision,
      'skip',
      context('resume', f.now()),
    );
    expect(resumed).toMatchObject({
      state: 'active',
      lastClaimedDay: null,
      lastResolvedDay: '2026-12-14',
      catchUpRequired: false,
    });
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM boards_template_runs').first('n')).toBe(0);
    expect((await f.schedules.advanceOne()).kind).toBe('idle');
  });
  it('captures the latest catch-up day and does not move an admitted partial run to a later slot', async () => {
    const f = await fixture();
    await f.schedules.create('a', definition(f), context(), 'schedule');
    await f.schedules.pause('a', 'schedule', 0, context('pause'));
    await f.setNow(Date.parse('2026-12-14T12:00:00Z'));
    const paused = await f.schedules.get('a', 'schedule');
    await f.schedules.resume(
      'a',
      'schedule',
      paused.revision,
      'latest',
      context('resume', f.now()),
    );
    const claimed = await f.schedules.advanceOne();
    expect(claimed.kind).toBe('claimed');
    await f.db
      .prepare("UPDATE boards_template_runs SET state='paused',error_code='uncertain' WHERE id=?")
      .bind(claimed.runId)
      .run();
    const schedule = await f.schedules.get('a', 'schedule');
    await f.schedules.pause('a', 'schedule', schedule.revision, context('pause-partial', f.now()));
    await f.setNow(Date.parse('2027-01-18T12:00:00Z'));
    const updated = await f.schedules.get('a', 'schedule');
    await expect(
      f.schedules.resume('a', 'schedule', updated.revision, 'latest', context('retry', f.now())),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.db.prepare('SELECT slot_day FROM boards_template_runs').first('slot_day')).toBe(
      '2026-12-14',
    );
  });
  it('uses local midnight through DST and rejects invalid monthly days and stale edits', async () => {
    const f = await fixture();
    await f.schedules.create(
      'a',
      definition(f, {
        frequency: 'weekly',
        weekday: 7,
        zone: 'America/New_York',
        startsOn: '2026-11-01',
      }),
      context(),
      'schedule',
    );
    expect((await f.schedules.get('a', 'schedule')).nextRunAt).toBe('2026-11-01T04:00:00.000Z');
    await expect(
      f.schedules.create(
        'a',
        definition(f, {
          frequency: 'monthly',
          dayOfMonth: 29,
          zone: 'UTC',
          startsOn: '2026-11-01',
        }),
        context(),
        'bad',
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await f.schedules.update('a', 'schedule', { listPrefix: 'new' }, 0, context('edit'));
    await expect(f.schedules.pause('a', 'schedule', 0, context('stale'))).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('pauses deleted template/destination hooks without deleting previous run output', async () => {
    const f = await fixture();
    await f.schedules.create('a', definition(f), context(), 'schedule');
    await f.db.batch(f.schedules.pauseTemplateWrites('a', 'list', f.saved.id));
    expect(await f.schedules.get('a', 'schedule')).toMatchObject({
      state: 'paused',
      pauseReason: 'template_deleted',
      catchUpRequired: true,
    });
    expect(f.calls()).toBe(0);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(1);
  });
  it.each([false, true])(
    'releases a paused run after generic progress without resuming a paused schedule (%s)',
    async (schedulePaused) => {
      const f = await fixture();
      await f.schedules.create('a', definition(f), context(), 'schedule');
      const claimed = await f.schedules.advanceOne();
      expect(claimed.runId).toBeDefined();
      const runId = claimed.runId!;
      let run = await f.applications.get('a', runId);
      for (
        let index = 0;
        index < 10 && !(await f.operations.get(run.operationId, 'a'))?.inputSealed;
        index++
      )
        run = await f.applications.advance('a', runId);
      expect((await f.operations.get(run.operationId, 'a'))?.inputSealed).toBe(true);
      // A repaired receipt can return its journal to runnable state while the
      // template's last observed state remains paused. Generic progress owns
      // no template tables and cannot silently release their retention pin.
      await f.db
        .prepare("UPDATE boards_template_runs SET state='paused',error_code='uncertain' WHERE id=?")
        .bind(runId)
        .run();
      if (schedulePaused) await f.schedules.pause('a', 'schedule', 0, context('pause'));
      for (
        let index = 0;
        index < 10 && !(await f.operations.get(run.operationId, 'a'))?.finished;
        index++
      )
        await f.commands.advance('a', run.operationId);
      expect((await f.operations.get(run.operationId, 'a'))?.state).toBe('succeeded');
      expect(
        await f.db
          .prepare('SELECT state FROM boards_template_runs WHERE id=?')
          .bind(runId)
          .first('state'),
      ).toBe('paused');
      expect(await f.applications.reconcileOperation('other-account', run.operationId)).toBeNull();
      expect(await f.applications.reconcileOperation('a', run.operationId)).toMatchObject({
        id: runId,
        state: 'succeeded',
      });
      expect(
        await f.db
          .prepare('SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key=?')
          .bind(`run:${runId}`)
          .first('n'),
      ).toBe(0);
      const calls = f.calls();
      expect(await f.schedules.advanceOne()).toMatchObject({
        kind: 'deferred',
        scheduleId: 'schedule',
      });
      expect(await f.schedules.get('a', 'schedule')).toMatchObject({
        activeRunId: null,
        state: schedulePaused ? 'paused' : 'active',
        nextRunAt: schedulePaused ? null : '2026-11-08T21:00:00.000Z',
      });
      expect(await f.applications.reconcileOperation('a', run.operationId)).toMatchObject({
        state: 'succeeded',
      });
      expect(f.calls()).toBe(calls);
      expect(
        await f.db.prepare("SELECT COUNT(*) AS n FROM tasks_lists WHERE account_id='a'").first('n'),
      ).toBe(2);
    },
  );
});
it('rotates bounded work slices fairly between already admitted runs even when the clock is unchanged', async () => {
  const f = await fixture();
  const input = {
    template: { kind: 'list', id: f.saved.id, contentRevision: 1 },
    destination: { kind: 'existing', boardId: f.main.id, boardRevision: f.main.revision },
    applicationDay: '2026-11-02',
    useRelativeDates: true,
    listPrefix: '',
    confirmed: true,
  };
  const first = await f.applications.begin('a', input, {
      operationId: `${start}:aaaaaaaaaaaaaaaa`,
      ownerSubject: 'owner',
    }),
    second = await f.applications.begin('a', input, {
      operationId: `${start}:bbbbbbbbbbbbbbbb`,
      ownerSubject: 'owner',
    });
  expect(await f.schedules.advanceOne()).toMatchObject({ kind: 'run', runId: first.id });
  expect(await f.schedules.advanceOne()).toMatchObject({ kind: 'run', runId: second.id });
  expect(
    (
      await f.db
        .prepare('SELECT lists_captured FROM boards_template_runs ORDER BY work_order')
        .all<{
          lists_captured: number;
        }>()
    ).results.map((row) => row.lists_captured),
  ).toEqual([1, 1]);
  expect(f.calls()).toBe(0);
});
it('restores a schedule paused in its creation transaction so cron cannot run it before owner confirmation', async () => {
  const f = await fixture();
  const imported = await f.schedules.createPaused('a', definition(f), context(), 'imported');
  expect(imported).toMatchObject({
    state: 'paused',
    pauseReason: 'imported',
    catchUpRequired: true,
    nextRunAt: null,
  });
  expect(await f.schedules.advanceOne()).toMatchObject({ kind: 'idle' });
  expect(f.calls()).toBe(0);
});
