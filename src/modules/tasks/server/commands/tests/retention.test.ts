import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { TaskCommandService } from '../service';
import { TaskProjectionStore } from '../../projection/store';
import { OperationStore } from '../../../../operations/server/journal/store';
import { HistoryService } from '../../../../history/server/events/event-store';
const initial = Date.parse('2026-11-02T12:00:00Z'),
  day = 86_400_000;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
async function fixture() {
  const database = testDatabase();
  closes.push(database.close);
  await seedAccount(database.db, 'account', initial);
  await database.db
    .prepare(
      `INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES('list','account','provider-list','home',1,?,?)`,
    )
    .bind(initial, initial)
    .run();
  let now = initial;
  const clock = () => now;
  const history = new HistoryService(database.db, { now: clock }),
    projection = new TaskProjectionStore(database.db, { history, now: clock }),
    operations = new OperationStore(database.db),
    clientFor = vi.fn(async () => {
      throw new Error('retention must not access google');
    });
  const commands = new TaskCommandService(database.db, {
    history,
    projection,
    operations,
    clientFor,
    now: clock,
  });
  return {
    ...database,
    operations,
    commands,
    clock,
    clientFor,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const operationId = (suffix = 'abcdefghijklmnop') => initial + ':' + suffix;
const command = {
  kind: 'task.create' as const,
  listId: 'list',
  listRevision: 1,
  title: 'task',
  notes: 'private task note body',
};
async function prepare(f: Awaited<ReturnType<typeof fixture>>, id = operationId()) {
  return f.commands.prepare({
    operationId: id,
    accountId: 'account',
    ownerSubject: 'owner',
    command,
  });
}
async function finishPruning(f: Awaited<ReturnType<typeof fixture>>, limit = 100) {
  for (let i = 0; i < 200; i++)
    if ((await f.commands.cleanupCaptures(limit, f.clock())) === 0) return;
  throw new Error('cleanup did not settle');
}

describe('bounded command payload retention', () => {
  it('drops finished note bodies after24h while hashes return the same90day outcome', async () => {
    const f = await fixture();
    await prepare(f);
    await f.operations.cancel(operationId(), 'account', f.clock());
    f.advance(day + 1);
    await finishPruning(f);
    const plan = await f.db
      .prepare('SELECT request_json,request_hash,payload_pruned_at FROM tasks_command_plans')
      .first<{ request_json: string; request_hash: string; payload_pruned_at: number }>();
    expect(plan?.request_json).toBe('{}');
    expect(plan?.request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan?.payload_pruned_at).toBe(f.clock());
    expect(
      (
        await f.db
          .prepare('SELECT input_json FROM tasks_command_steps')
          .all<{ input_json: string }>()
      ).results.every((row) => row.input_json === '{}'),
    ).toBe(true);
    expect((await prepare(f)).state).toBe('cancelled');
    await expect(
      f.commands.prepare({
        operationId: operationId(),
        accountId: 'account',
        ownerSubject: 'owner',
        command: { ...command, notes: 'different request' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.clientFor).not.toHaveBeenCalled();
  });
  it('retains exact copy chunk hashes and minimal identity baselines after bodies are removed', async () => {
    const f = await fixture(),
      id = operationId('copyidentity0000'),
      header = {
        operationId: id,
        accountId: 'account',
        ownerSubject: 'owner',
        source: 'duplication' as const,
        origin: 'owner' as const,
        listId: 'list',
        listRevision: 1,
        totalTasks: 1,
        requestKey: 'frozen-copy',
      },
      entry = { key: 'source', position: 0, title: 'copied task', notes: 'private copied note' };
    await f.commands.beginCapturedCopy(header);
    await f.commands.appendCapturedCopy(id, 'account', [entry]);
    await f.commands.sealCapturedCopy(id, 'account');
    await f.operations.cancel(id, 'account', f.clock());
    f.advance(day + 1);
    await finishPruning(f);
    const saved = await f.db
      .prepare('SELECT input_json,input_hash,task_id FROM tasks_command_copy_entries')
      .first<{ input_json: string; input_hash: string; task_id: string }>();
    expect(saved?.input_json).toBe('{}');
    expect(saved?.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved?.task_id).toMatch(/^task-/);
    await expect(f.commands.appendCapturedCopy(id, 'account', [entry])).resolves.toBeUndefined();
    await expect(
      f.commands.appendCapturedCopy(id, 'account', [{ ...entry, notes: 'changed' }]),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.commands.beginCapturedCopy(header)).state).toBe('cancelled');
  });
  it('never prunes an unfinished or uncertain capture even after90days', async () => {
    const f = await fixture();
    await prepare(f);
    const uncertainId = operationId('uncertainidentity');
    await prepare(f, uncertainId);
    const step = await f.operations.claimNext(uncertainId, 'claim', f.clock());
    await f.operations.markDispatched(uncertainId, step!.key, 'claim', f.clock());
    await f.operations.rejectStep(
      uncertainId,
      step!.key,
      'claim',
      { code: 'outcome_uncertain', definitelyRejected: false },
      f.clock(),
    );
    f.advance(100 * day);
    expect(await f.commands.cleanupCaptures(100, f.clock())).toBe(0);
    expect(
      (
        await f.db
          .prepare('SELECT input_json FROM tasks_command_steps')
          .all<{ input_json: string }>()
      ).results.every((row) => row.input_json.includes('private task note body')),
    ).toBe(true);
    expect((await f.operations.get(uncertainId, 'account'))?.state).toBe('uncertain');
  });
  it('bounds a2000step cleanup to100changed rows and expires replay only after the receipt window', async () => {
    const f = await fixture();
    await prepare(f);
    await f.db.batch(
      Array.from({ length: 1999 }, (_, index) =>
        f.db
          .prepare(
            'INSERT INTO tasks_command_steps(operation_id,item_key,position,kind,input_json) VALUES(?,?,?,?,?)',
          )
          .bind(operationId(), 'extra-' + index, index + 1, 'task.patch', '{}'),
      ),
    );
    await f.operations.cancel(operationId(), 'account', f.clock());
    f.advance(91 * day);
    expect(await f.operations.cleanup(100, f.clock())).toBe(0);
    const before = (await f.db
      .prepare('SELECT COUNT(*) AS n FROM tasks_command_steps')
      .first<{ n: number }>())!.n;
    expect(before).toBe(2000);
    const changed = await f.commands.cleanupCaptures(100, f.clock()),
      after = (await f.db
        .prepare('SELECT COUNT(*) AS n FROM tasks_command_steps')
        .first<{ n: number }>())!.n;
    expect(changed).toBeLessThanOrEqual(100);
    expect(before - after).toBeLessThanOrEqual(100);
    expect(after).toBeGreaterThan(0);
    await finishPruning(f);
    expect(
      (await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_command_plans').first<{ n: number }>())
        ?.n,
    ).toBe(0);
    await f.operations.cleanup(100, f.clock());
    await expect(prepare(f)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.clientFor).not.toHaveBeenCalled();
  });
});
