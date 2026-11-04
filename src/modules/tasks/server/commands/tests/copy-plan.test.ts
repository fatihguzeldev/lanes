import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { OperationStore } from '../../../../operations/server/journal/store';
import { CapturedCopyPlanner } from '../copy-plan';
import type { BeginCapturedCopy, CopyEntry } from '../copy-contract';
import { invocationDatabase } from '../../../../../../tests/support/d1-invocation';
import { CommandRetention } from '../retention';
import { TasksLifecycle } from '../../lifecycle/account';
const now = Date.parse('2026-11-02T12:00:00Z');
const operationId = (suffix = 'a') => `${now}:${suffix.repeat(16)}`;
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
  for (const account of ['a', 'b'])
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES (?,?,?,?,1,?,?)',
      )
      .bind(`list-${account}`, account, `google-${account}`, account, now, now)
      .run();
  const operations = new OperationStore(db);
  const planner = new CapturedCopyPlanner(db, {
    operations,
    now: () => now,
    validateBoardTarget: async (account, board, revision) => {
      if (account !== 'a' || board !== 'board' || (revision !== undefined && revision !== 4))
        throw new Error('invalid board');
    },
  });
  return { ...database, planner, operations };
}
const input = (extra: Partial<BeginCapturedCopy> = {}): BeginCapturedCopy => ({
  operationId: operationId(),
  ownerSubject: 'owner',
  accountId: 'a',
  source: 'template',
  origin: 'owner',
  totalTasks: 2,
  totalLists: 2,
  newListCount: 2,
  requestKey: 'template:revision-one',
  ...extra,
});
const list = (key: string, position: number) => ({
  key,
  position,
  title: key,
  boardId: 'board',
  boardRevision: 4,
});
const task = (key: string, position: number, extra: Partial<CopyEntry> = {}): CopyEntry => ({
  key,
  listKey: position ? 'second' : 'first',
  position,
  title: key,
  ...extra,
});
describe('checkpointed dependency validation', () => {
  // the timeout covers staging and all checkpoints; each invocation keeps its query budget.
  for (const count of [500, 2000])
    it(`validates a ${count}-task dependency chain in bounded resumable slices`, async () => {
      const f = await fixture();
      await f.planner.begin(input({ totalTasks: count, totalLists: 1, newListCount: 1 }));
      await f.planner.appendLists(operationId(), 'a', [list('first', 0)]);
      for (let offset = 0; offset < count; offset += 10)
        await f.planner.appendTasks(
          operationId(),
          'a',
          Array.from({ length: Math.min(10, count - offset) }, (_, n) =>
            task('node-' + (offset + n), offset + n, {
              listKey: 'first',
              dependencyKeys: offset + n ? ['node-' + (offset + n - 1)] : [],
            }),
          ),
        );
      let ready = false,
        previousChecked = 0,
        slices = 0;
      while (!ready && slices++ < 250) {
        const invocation = invocationDatabase(f.db, 35);
        const planner = new CapturedCopyPlanner(invocation.db, {
          operations: new OperationStore(invocation.db),
          now: () => now,
        });
        const result = await planner.seal(operationId(), 'a');
        expect(result.validation.checkedTasks - previousChecked).toBeLessThanOrEqual(1000);
        previousChecked = result.validation.checkedTasks;
        ready = result.captureSealed;
        expect(result.validation.remainingTasks).toBe(count - previousChecked);
        expect(invocation.queries).toBeLessThanOrEqual(35);
        if (!ready) {
          expect((await f.planner.context(operationId(), 'a')).sealed).toBe(false);
          expect(await f.operations.claimNext(operationId(), 'premature', now)).toBeNull();
          await expect(f.planner.promote(operationId(), 'a')).rejects.toMatchObject({
            code: 'conflict',
          });
        }
      }
      expect(ready).toBe(true);
      expect(slices).toBeGreaterThan(1);
      expect(previousChecked).toBe(count);
      const first = await f.planner.seal(operationId(), 'a');
      const repeated = await f.planner.seal(operationId(), 'a');
      expect(repeated).toEqual(first);
      expect(
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks_command_steps WHERE operation_id=? AND kind='task.create'",
          )
          .bind(operationId())
          .first('n'),
      ).toBe(count);
    }, 30_000);
  it('freezes normalization during checkpoints, rejects a late cycle, and never dispatches a partial validated graph', async () => {
    const f = await fixture(),
      count = 500;
    await f.planner.begin(input({ totalTasks: count, totalLists: 1, newListCount: 1 }));
    await f.planner.appendLists(operationId(), 'a', [list('first', 0)]);
    for (let offset = 0; offset < count; offset += 10)
      await f.planner.appendTasks(
        operationId(),
        'a',
        Array.from({ length: 10 }, (_, n) =>
          task('n' + (offset + n), offset + n, {
            listKey: 'first',
            dependencyKeys: [offset + n ? 'n' + (offset + n - 1) : 'n499'],
          }),
        ),
      );
    expect((await f.planner.seal(operationId(), 'a')).captureSealed).toBe(false);
    await f.planner.appendTasks(operationId(), 'a', [
      task('n0', 0, { listKey: 'first', dependencyKeys: ['n499'] }),
    ]);
    await expect(
      f.planner.appendTasks(operationId(), 'a', [
        task('n0', 0, { listKey: 'first', dependencyKeys: [] }),
      ]),
    ).rejects.toMatchObject({ code: 'conflict' });
    let rejected = false;
    for (let i = 0; i < 10; i++) {
      try {
        await f.planner.seal(operationId(), 'a');
      } catch (error) {
        expect(error).toMatchObject({ code: 'validation_failed' });
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    await expect(f.planner.seal(operationId(), 'a')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await f.planner.context(operationId(), 'a')).sealed).toBe(false);
    expect(await f.operations.claimNext(operationId(), 'worker', now)).toBeNull();
  });
  it('bounds high fanout edge removal and serializes overlapping checkpoints without losing decrements', async () => {
    const f = await fixture(),
      count = 200;
    await f.planner.begin(input({ totalTasks: count, totalLists: 1, newListCount: 1 }));
    await f.planner.appendLists(operationId(), 'a', [list('first', 0)]);
    for (let offset = 0; offset < count; offset += 10)
      await f.planner.appendTasks(
        operationId(),
        'a',
        Array.from({ length: 10 }, (_, n) =>
          task('n' + (offset + n), offset + n, {
            listKey: 'first',
            dependencyKeys: Array.from({ length: Math.min(50, offset + n) }, (_, k) => 'n' + k),
          }),
        ),
      );
    const concurrent = await Promise.allSettled([
      f.planner.seal(operationId(), 'a'),
      f.planner.seal(operationId(), 'a'),
    ]);
    expect(concurrent.some((item) => item.status === 'fulfilled')).toBe(true);
    for (const item of concurrent)
      if (item.status === 'rejected')
        expect(item.reason).toMatchObject({ code: 'conflict', retryable: true });
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      const before = await f.db
        .prepare('SELECT COUNT(*) AS n FROM tasks_command_copy_graph_edges')
        .first<number>('n');
      const result = await f.planner.seal(operationId(), 'a');
      ready = result.captureSealed;
      const after = await f.db
        .prepare('SELECT COUNT(*) AS n FROM tasks_command_copy_graph_edges')
        .first<number>('n');
      if (before! >= after!) expect(before! - after!).toBeLessThanOrEqual(5000);
    }
    expect(ready).toBe(true);
    expect(
      await f.db
        .prepare('SELECT MIN(remaining) AS n FROM tasks_command_copy_graph_nodes')
        .first('n'),
    ).toBe(0);
  });
  it('keeps unfinished checkpoints and explicitly clears graph scratch with bounded retention and account removal', async () => {
    const f = await fixture(),
      count = 200;
    await f.planner.begin(input({ totalTasks: count, totalLists: 1, newListCount: 1 }));
    await f.planner.appendLists(operationId(), 'a', [list('first', 0)]);
    for (let offset = 0; offset < count; offset += 10)
      await f.planner.appendTasks(
        operationId(),
        'a',
        Array.from({ length: 10 }, (_, n) =>
          task('n' + (offset + n), offset + n, {
            listKey: 'first',
            dependencyKeys: offset + n ? ['n' + (offset + n - 1)] : [],
          }),
        ),
      );
    expect((await f.planner.seal(operationId(), 'a')).captureSealed).toBe(false);
    const retention = new CommandRetention(f.db);
    expect(await retention.cleanup(1, now + 86400000)).toBe(0);
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++)
      ready = (await f.planner.seal(operationId(), 'a')).captureSealed;
    expect(ready).toBe(true);
    const before = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
    expect(await retention.cleanup(1, now)).toBe(1);
    expect((f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - before).toBe(1);
    await f.db
      .prepare(
        "UPDATE accounts_connections SET state='disconnected',removal_requested_at=? WHERE id='a'",
      )
      .bind(now)
      .run();
    const owner = new TasksLifecycle(f.db, {
      operations: f.operations,
      commands: {
        advance: async () => {
          throw new Error('no provider work');
        },
      },
    });
    let done = false;
    for (let i = 0; i < 80 && !done; i++) {
      const previous = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      const result = await owner.remove('a', 100);
      done = result.done;
      expect(
        (f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - previous,
      ).toBeLessThanOrEqual(100);
    }
    expect(done).toBe(true);
    for (const table of [
      'tasks_command_copy_validation',
      'tasks_command_copy_graph_nodes',
      'tasks_command_copy_graph_edges',
    ])
      expect(await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
  });
});
describe('captured copy admission', () => {
  it('reserves all list slots together before any execution and rejects one impossible batch', async () => {
    const { planner, operations, db } = await fixture();
    await db
      .prepare("UPDATE tasks_account_state SET inventory_count=1999 WHERE account_id='a'")
      .run();
    await expect(planner.begin(input())).rejects.toMatchObject({ code: 'list_limit_reached' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
    const accepted = await planner.begin(
      input({ operationId: operationId('b'), totalLists: 1, newListCount: 1 }),
    );
    expect(accepted.inputSealed).toBe(false);
    expect(
      await db
        .prepare('SELECT remaining FROM tasks_list_reservations WHERE operation_id=?')
        .bind(operationId('b'))
        .first('remaining'),
    ).toBe(1);
    expect(await operations.claimNext(operationId('b'), 'worker', now)).toBe(null);
  });
  it('binds operation replay to canonical input and never changes quota or captured data', async () => {
    const { planner, db } = await fixture();
    await planner.begin(input());
    await planner.appendLists(operationId(), 'a', [list('first', 0), list('second', 1)]);
    await planner.appendTasks(operationId(), 'a', [task('one', 0), task('two', 1)]);
    await planner.seal(operationId(), 'a');
    const replay = await planner.begin(input());
    expect(replay.id).toBe(operationId());
    await expect(planner.begin(input({ requestKey: 'different' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(planner.begin(input({ accountId: 'b' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await db.prepare('SELECT SUM(remaining) AS n FROM tasks_list_reservations').first('n'),
    ).toBe(2);
  });
  it('bounds creation to 100 lists and 2000 tasks, permitting empty-list copies', async () => {
    const { planner } = await fixture();
    for (const extra of [
      { totalTasks: 2001 },
      { totalLists: 101, newListCount: 101 },
      { totalLists: 2, newListCount: 3 },
    ])
      await expect(planner.begin(input(extra))).rejects.toMatchObject({
        code: 'validation_failed',
      });
    const empty = input({ totalTasks: 0, totalLists: 1, newListCount: 1 });
    await planner.begin(empty);
    await planner.appendLists(empty.operationId, 'a', [list('empty', 0)]);
    const operation = await planner.seal(empty.operationId, 'a');
    expect(operation.totalSteps).toBe(3); // marker, list, final marker
  });
});
describe('bounded immutable copy capture', () => {
  it('appends a chunk atomically and makes exact replays harmless even after sealing', async () => {
    const { planner, db } = await fixture();
    await planner.begin(input());
    await planner.appendLists(operationId(), 'a', [list('first', 0), list('second', 1)]);
    await expect(
      planner.appendTasks(operationId(), 'a', [task('one', 0), task('invalid', 1, { title: '' })]),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM tasks_command_copy_entries').first('n'),
    ).toBe(0);
    const records = [task('one', 0), task('two', 1)];
    await planner.appendTasks(operationId(), 'a', records);
    await planner.seal(operationId(), 'a');
    await planner.appendTasks(operationId(), 'a', records);
    await expect(
      planner.appendTasks(operationId(), 'a', [task('one', 0, { title: 'changed' })]),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM tasks_command_copy_entries').first('n'),
    ).toBe(2);
  });
  it('rejects duplicate positions, large chunks and cross-account existing destinations', async () => {
    const { planner } = await fixture();
    await planner.begin(input());
    await expect(
      planner.appendLists(operationId(), 'a', [
        { key: 'private', position: 0, existingListId: 'list-b', revision: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'not_found' });
    await planner.appendLists(operationId(), 'a', [list('first', 0), list('second', 1)]);
    await planner.appendTasks(operationId(), 'a', [task('one', 0)]);
    await expect(planner.appendTasks(operationId(), 'a', [task('other', 0)])).rejects.toMatchObject(
      { code: 'conflict' },
    );
    await expect(
      planner.appendTasks(
        operationId(),
        'a',
        Array.from({ length: 11 }, (_, n) => task(String(n), n)),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      planner.appendTasks(operationId(), 'a', [
        task('large', 1, { notes: '😀'.repeat(8192) }),
        task('large-2', 1, { notes: '😀'.repeat(8192) }),
      ]),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('does not seal incomplete plans or let an expired/disconnected account send provider work', async () => {
    const { planner, db, operations } = await fixture();
    await planner.begin(input());
    await planner.appendLists(operationId(), 'a', [list('first', 0)]);
    await expect(planner.seal(operationId(), 'a')).rejects.toMatchObject({ code: 'conflict' });
    await db
      .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id='a'")
      .run();
    await planner.appendLists(operationId(), 'a', [list('second', 1)]);
    await planner.appendTasks(operationId(), 'a', [task('one', 0), task('two', 1)]);
    await expect(planner.seal(operationId(), 'a')).rejects.toMatchObject({
      code: 'reconnect_required',
    });
    expect(await operations.claimNext(operationId(), 'worker', now)).toBeNull();
    await db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
    await expect(planner.appendTasks(operationId(), 'a', [task('one', 0)])).rejects.toMatchObject({
      code: 'reconnect_required',
    });
  });
});
describe('copy references and execution order', () => {
  it('rejects cross-list/deeper/missing parents and recursive dependency cycles before sealing', async () => {
    const cases: CopyEntry[][] = [
      [task('a', 0), task('b', 1, { parentKey: 'a' })],
      [task('a', 0, { parentKey: 'missing' }), task('b', 1)],
      [task('a', 0, { dependencyKeys: ['b'] }), task('b', 1, { dependencyKeys: ['a'] })],
      [task('a', 0, { previousKey: 'b' }), task('b', 1)],
    ];
    for (const [index, entries] of cases.entries()) {
      const { planner } = await fixture();
      const op = operationId(String(index));
      await planner.begin(input({ operationId: op }));
      await planner.appendLists(op, 'a', [list('first', 0), list('second', 1)]);
      await planner.appendTasks(op, 'a', entries);
      await expect(planner.seal(op, 'a')).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });
  it('creates all containers then parents then children, preserving input sibling order and remapped keys', async () => {
    const { planner, operations, db } = await fixture();
    await planner.begin(input({ totalTasks: 3 }));
    await planner.appendLists(operationId(), 'a', [list('first', 0), list('second', 1)]);
    await planner.appendTasks(operationId(), 'a', [
      task('parent', 0),
      task('child', 1, { listKey: 'first', parentKey: 'parent', dependencyKeys: ['other'] }),
      task('other', 2, { listKey: 'second' }),
    ]);
    await planner.seal(operationId(), 'a');
    const steps = (
      await db
        .prepare(
          'SELECT kind,input_json FROM tasks_command_steps WHERE operation_id=? ORDER BY position',
        )
        .bind(operationId())
        .all<{
          kind: string;
          input_json: string;
        }>()
    ).results.map((row) => ({ kind: row.kind, value: JSON.parse(row.input_json) }));
    expect(steps.map((step) => step.kind)).toEqual([
      'copy.begin',
      'list.create',
      'list.create',
      'task.create',
      'task.create',
      'task.create',
      'copy.metadata',
      'copy.begin',
    ]);
    expect(steps.slice(3, 6).map((step) => step.value.copyKey)).toEqual([
      'parent',
      'other',
      'child',
    ]);
    expect(steps[5]?.value).toMatchObject({
      copyListKey: 'first',
      copyParentKey: 'parent',
      copyPreviousKey: null,
    });
    expect((await operations.get(operationId(), 'a'))?.inputSealed).toBe(false);
    await planner.promote(operationId(), 'a');
    expect((await operations.get(operationId(), 'a'))?.inputSealed).toBe(true);
  });
});
it('makes overlapping exact capture chunks harmless and preserves a single immutable normalized record', async () => {
  const { planner, db } = await fixture();
  await planner.begin(input());
  await Promise.all([
    planner.appendLists(operationId(), 'a', [list('first', 0), list('second', 1)]),
    planner.appendLists(operationId(), 'a', [list('first', 0), list('second', 1)]),
  ]);
  await Promise.all([
    planner.appendTasks(operationId(), 'a', [task('one', 0), task('two', 1)]),
    planner.appendTasks(operationId(), 'a', [task('one', 0), task('two', 1)]),
  ]);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_command_copy_entries').first('n')).toBe(
    2,
  );
  await planner.seal(operationId(), 'a');
});

it('replays a terminal direct copy from retained hashes after its command bodies are pruned', async () => {
  const { planner, operations, db } = await fixture();
  const request = input({ totalTasks: 0, totalLists: 0, newListCount: 0 });
  await planner.begin(request);
  await planner.seal(operationId(), 'a');
  await planner.promote(operationId(), 'a');
  for (const claimId of ['first', 'last']) {
    const claim = await operations.claimNext(operationId(), claimId, now);
    expect(claim).not.toBeNull();
    await operations.commitLocalStep(operationId(), claim!.key, claimId, {}, [], now);
  }
  const before = await operations.get(operationId(), 'a');
  expect(before?.finished).toBe(true);
  const body = await db
    .prepare('SELECT request_json FROM tasks_command_plans WHERE operation_id=?')
    .bind(operationId())
    .first<string>('request_json');
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body!))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  await db
    .prepare(
      "UPDATE tasks_command_plans SET request_hash=?,request_json='{}',payload_pruned_at=?,copy_context_json=? WHERE operation_id=?",
    )
    .bind(
      hash,
      now,
      JSON.stringify({
        version: 2,
        totalTasks: 0,
        totalLists: 0,
        newListCount: 0,
        sealed: true,
        source: 'template',
        origin: 'owner',
      }),
      operationId(),
    )
    .run();
  await db
    .prepare("UPDATE tasks_command_steps SET input_json='{}' WHERE operation_id=?")
    .bind(operationId())
    .run();
  expect((await planner.begin(request)).state).toBe('succeeded');
  expect((await planner.admit(operationId(), 'a')).state).toBe('succeeded');
  expect((await planner.promote(operationId(), 'a')).state).toBe('succeeded');
  await expect(planner.begin({ ...request, requestKey: 'changed' })).rejects.toMatchObject({
    code: 'conflict',
  });
});
