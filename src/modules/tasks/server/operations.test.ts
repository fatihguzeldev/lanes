import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { OperationStore } from './operations';

const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const now = 1_793_641_000_000;
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'account-a', now);
  await seedAccount(database.db, 'account-b', now);
  return { ...database, store: new OperationStore(database.db) };
}
const id = (suffix = 'a') => `${now}:${suffix.repeat(32)}`;
const input = (operationId = id()) => ({
  id: operationId,
  accountId: 'account-a',
  ownerSubject: 'owner',
  kind: 'task.create',
  resourceKey: 'list:list-a',
  input: { title: 'a task' },
  steps: [{ key: 'task-1', kind: 'task.create', input: { title: 'a task' } }],
});

describe('durable provider intent', () => {
  it('records refreshed dispatch input under the active claim without replacing the original intent', async () => {
    const { store } = await fixture();
    const original = input();
    const admitted = await store.admit(original, now);
    await store.claimNext(id(), 'expired', now);
    const refreshed = { title: 'a task', provider: { etag: 'fresh-order' } };
    await expect(
      store.markDispatched(id(), 'task-1', 'expired', now + 31_000, [], refreshed),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.getStep(id(), 'task-1'))?.input).toEqual({ title: 'a task' });
    await store.claimNext(id(), 'current', now + 31_000);
    await store.markDispatched(id(), 'task-1', 'current', now + 31_001, [], refreshed);
    expect(await store.getStep(id(), 'task-1')).toMatchObject({
      state: 'dispatched',
      input: refreshed,
    });
    expect((await store.admit(original, now + 31_002)).input).toEqual(admitted.input);
  });
  it('counts confirmed, uncertain and unsent work without exposing captured bodies or treating markers as tasks', async () => {
    const { store } = await fixture();
    await store.admit(
      {
        ...input(),
        steps: [
          { key: 'one', kind: 'task.create', input: { notes: 'private' } },
          { key: 'two', kind: 'task.create', input: {} },
          { key: 'metadata', kind: 'copy.metadata', input: {} },
        ],
      },
      now,
    );
    await store.claimNext(id(), 'one', now);
    await store.commitLocalStep(id(), 'one', 'one', { taskId: 'confirmed' }, [], now);
    await store.claimNext(id(), 'two', now);
    await store.markDispatched(id(), 'two', 'two', now);
    await store.rejectStep(
      id(),
      'two',
      'two',
      { code: 'outcome_uncertain', definitelyRejected: false },
      now,
    );
    expect(await store.progress(id(), 'account-a', now)).toMatchObject({
      totalSteps: 3,
      steps: { confirmed: 1, failed: 0, uncertain: 1, cancelled: 0, remaining: 1 },
      taskCreates: { confirmed: 1, failed: 0, uncertain: 1, cancelled: 0 },
    });
    await store.cancel(id(), 'account-a', now);
    expect(await store.progress(id(), 'account-a', now)).toMatchObject({
      steps: { confirmed: 1, uncertain: 1, cancelled: 1, remaining: 0 },
      taskCreates: { confirmed: 1, uncertain: 1, cancelled: 0 },
    });
    await expect(store.progress(id(), 'account-b', now)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('adopts one verified unknown receipt, fences the old worker, and repairs without redispatch', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'original', now);
    await store.markDispatched(id(), 'task-1', 'original', now);
    const resolution = {
      operationId: id(),
      accountId: 'account-a',
      stepKey: 'task-1',
      expectedClaimId: 'original',
      response: { id: 'google-confirmed', title: 'a task' },
      evidence: {
        kind: 'owner_candidate' as const,
        providerId: 'google-confirmed',
        etag: 'version-1',
      },
    };
    await expect(store.resolveUnknownResponse(resolution, now + 1)).rejects.toMatchObject({
      code: 'conflict',
    });
    await store.resolveUnknownResponse(resolution, now + 31_000);
    await store.resolveUnknownResponse(resolution, now + 31_001);
    await expect(
      store.resolveUnknownResponse({ ...resolution, response: { id: 'other' } }, now + 31_002),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.recordResponse(id(), 'task-1', 'original', { id: 'late-other' }, now + 31_002),
    ).rejects.toMatchObject({ code: 'conflict' });
    const repair = await store.claimNext(id(), 'repair', now + 31_003);
    expect(repair).toMatchObject({ mode: 'repair', response: { id: 'google-confirmed' } });
    await store.commitStep(
      id(),
      'task-1',
      'repair',
      { taskId: 'lanes-confirmed' },
      [],
      now + 31_003,
    );
    expect(await store.summary(id(), 'account-a')).toMatchObject({
      state: 'succeeded',
      finished: true,
    });
    expect(await store.getResolution(id(), 'task-1', 'account-b')).toBeNull();
    expect(await store.getResolution(id(), 'task-1', 'account-a')).toMatchObject({
      evidence: { providerId: 'google-confirmed' },
    });
  });
  it('cannot install a resolution under another account or a replaced dispatch claim', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'original', now);
    await store.markDispatched(id(), 'task-1', 'original', now);
    const resolution = {
      operationId: id(),
      accountId: 'account-b',
      stepKey: 'task-1',
      expectedClaimId: 'original',
      response: { id: 'google-confirmed' },
      evidence: { kind: 'provider_readback' as const, providerId: 'google-confirmed' },
    };
    await expect(store.resolveUnknownResponse(resolution, now + 31_000)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      store.resolveUnknownResponse(
        { ...resolution, accountId: 'account-a', expectedClaimId: 'different' },
        now + 31_000,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.getResolution(id(), 'task-1', 'account-a')).toBeNull();
    expect((await store.getStep(id(), 'task-1'))?.response).toBeNull();
  });
  it('resumes only recorded-response repair after reconnect and cleans resolution evidence with the receipt', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'original', now);
    await store.markDispatched(id(), 'task-1', 'original', now);
    const resolution = {
      operationId: id(),
      accountId: 'account-a',
      stepKey: 'task-1',
      expectedClaimId: 'original',
      response: { id: 'google-confirmed' },
      evidence: { kind: 'provider_readback' as const, providerId: 'google-confirmed' },
    };
    await store.resolveUnknownResponse(resolution, now + 31_000);
    await store.claimNext(id(), 'repair', now + 31_000);
    await store.pauseRepair(id(), 'task-1', 'repair', { code: 'reconnect_required' }, now + 31_001);
    await db
      .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id='account-a'")
      .run();
    await expect(
      store.resumeRecordedResponse(id(), 'task-1', 'account-a', now + 31_002),
    ).rejects.toMatchObject({ code: 'reconnect_required' });
    await db
      .prepare("UPDATE accounts_connections SET state='connected' WHERE id='account-a'")
      .run();
    await store.resumeRecordedResponse(id(), 'task-1', 'account-a', now + 31_003);
    expect(await store.claimNext(id(), 'repair2', now + 31_003)).toMatchObject({ mode: 'repair' });
    await store.commitStep(id(), 'task-1', 'repair2', {}, [], now + 31_003);
    await store.cleanup(100, now + 31_003 + 90 * 86_400_000);
    expect(await store.getResolution(id(), 'task-1', 'account-a')).toBeNull();
    expect(await store.get(id(), 'account-a')).toBeNull();
  });
  it('returns the existing identity for the same canonical command and rejects changed input', async () => {
    const { store } = await fixture();
    const first = await store.admit(input(), now);
    const repeated = await store.admit(input(), now + 10);
    expect(repeated.id).toBe(first.id);
    await expect(
      store.admit({ ...input(), input: { title: 'different' } }, now),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.admit({ ...input(), accountId: 'account-b' }, now)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('admits only one claim across independent worker instances', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    const other = new OperationStore(db);
    const claims = await Promise.all([
      store.claimNext(id(), 'worker-a', now),
      other.claimNext(id(), 'worker-b', now),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('reclaims a crash before dispatch but never blindly resends an expired dispatched create', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    const initial = await store.claimNext(id(), 'worker-a', now);
    expect(initial?.mode).toBe('dispatch');
    const replacement = await store.claimNext(id(), 'worker-b', now + 31_000);
    expect(replacement?.claimId).toBe('worker-b');
    await store.markDispatched(id(), 'task-1', 'worker-b', now + 31_000);
    expect(await store.claimNext(id(), 'worker-c', now + 62_000)).toBeNull();
    expect((await store.get(id(), 'account-a'))?.state).toBe('uncertain');
  });
  it('retains a provider receipt for local repair without a second dispatch', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker-a', now);
    await store.markDispatched(id(), 'task-1', 'worker-a', now);
    await store.recordResponse(id(), 'task-1', 'worker-a', { id: 'google-created-id' }, now + 1);
    const repair = await store.claimNext(id(), 'worker-b', now + 31_000);
    expect(repair?.mode).toBe('repair');
    expect(repair?.response).toEqual({ id: 'google-created-id' });
    await expect(
      store.commitStep(
        id(),
        'task-1',
        'worker-b',
        { id: 'stable-id' },
        [db.prepare('INSERT INTO absent_table VALUES (1)')],
        now + 31_001,
      ),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await store.getStep(id(), 'task-1'))?.response).toEqual({ id: 'google-created-id' });
    await store.commitStep(id(), 'task-1', 'worker-b', { id: 'stable-id' }, [], now + 31_002);
    expect((await store.get(id(), 'account-a'))?.state).toBe('succeeded');
    expect(await store.claimNext(id(), 'worker-c', now + 62_000)).toBeNull();
  });
  it('reserves the last list slot once across concurrent operations and keeps uncertain capacity', async () => {
    const { store, db } = await fixture();
    await db
      .prepare('UPDATE tasks_account_state SET inventory_count=1999 WHERE account_id=?')
      .bind('account-a')
      .run();
    const a = {
      ...input(id('a')),
      kind: 'list.create',
      resourceKey: 'create:a',
      listSlots: 1,
      steps: [{ key: 'list-a', kind: 'list.create', input: { title: 'a' } }],
    };
    const b = {
      ...input(id('b')),
      kind: 'list.create',
      resourceKey: 'create:b',
      listSlots: 1,
      steps: [{ key: 'list-b', kind: 'list.create', input: { title: 'b' } }],
    };
    const results = await Promise.allSettled([store.admit(a, now), store.admit(b, now)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'list_limit_reached' });
    expect(
      await db
        .prepare('SELECT SUM(remaining) AS n FROM tasks_list_reservations WHERE account_id=?')
        .bind('account-a')
        .first('n'),
    ).toBe(1);
  });
  it('rejects an impossible or stale-inventory batch before admitting any provider step', async () => {
    const { store, db } = await fixture();
    await db
      .prepare('UPDATE tasks_account_state SET inventory_count=1998 WHERE account_id=?')
      .bind('account-a')
      .run();
    await expect(
      store.admit(
        {
          ...input(),
          listSlots: 3,
          steps: [1, 2, 3].map((n) => ({
            key: 'list-' + n,
            kind: 'list.create',
            input: { title: 'list ' + n },
          })),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'list_limit_reached' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
    await db
      .prepare('UPDATE tasks_account_state SET inventory_complete_at=NULL WHERE account_id=?')
      .bind('account-a')
      .run();
    await expect(
      store.admit(
        {
          ...input(),
          listSlots: 1,
          steps: [{ key: 'list-a', kind: 'list.create', input: { title: 'a' } }],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('cancellation prevents an unsent claim from being dispatched', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker-a', now);
    await store.cancel(id(), 'account-a', now + 1);
    await expect(store.markDispatched(id(), 'task-1', 'worker-a', now + 2)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await store.get(id(), 'account-a'))?.state).toBe('cancelled');
  });
  it('an old pruned identity cannot become a new create', async () => {
    const { store } = await fixture();
    await expect(store.admit(input(), now + 90 * 86400_000)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('sealed plans and local receipts', () => {
  it('captures all chunks before execution and does not finish after the first chunk', async () => {
    const { store } = await fixture();
    await store.admit({ ...input(), totalSteps: 2 }, now);
    expect(await store.claimNext(id(), 'worker', now)).toBeNull();
    await store.appendSteps(id(), 'account-a', [
      { key: 'task-2', kind: 'task.create', input: { title: 'second' }, position: 1 },
    ]);
    await store.seal(id(), 'account-a');
    await store.claimNext(id(), 'worker', now);
    await store.commitLocalStep(id(), 'task-1', 'worker', { done: 1 }, [], now);
    expect((await store.get(id(), 'account-a'))?.state).toBe('running');
    await store.claimNext(id(), 'worker', now + 1);
    await store.commitLocalStep(id(), 'task-2', 'worker', { done: 2 }, [], now + 1);
    expect((await store.get(id(), 'account-a'))?.state).toBe('succeeded');
    expect((await store.get(id(), 'account-a'))?.confirmedSteps).toBe(2);
  });
  it('rejects changed captured chunks and incomplete sealing', async () => {
    const { store } = await fixture();
    await store.admit({ ...input(), totalSteps: 3 }, now);
    await expect(store.seal(id(), 'account-a')).rejects.toMatchObject({ code: 'conflict' });
    await store.appendSteps(id(), 'account-a', [
      { key: 'task-2', kind: 'task.create', input: { title: 'second' }, position: 1 },
    ]);
    await expect(
      store.appendSteps(id(), 'account-a', [
        { key: 'task-2', kind: 'task.create', input: { title: 'changed' }, position: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('commits metadata and its receipt together during grant expiry, but fences disconnect', async () => {
    const { store, db } = await fixture();
    await db
      .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id='account-a'")
      .run();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.commitLocalStep(
      id(),
      'task-1',
      'worker',
      { ok: true },
      [
        db
          .prepare(
            "INSERT INTO boards_boards(id,account_id,title,is_main,position,created_at) VALUES ('board-a','account-a','notes',0,1,?)",
          )
          .bind(now),
      ],
      now,
    );
    expect(
      await db.prepare("SELECT title FROM boards_boards WHERE id='board-a'").first('title'),
    ).toBe('notes');
    await store.admit(input(id('b')), now);
    await store.claimNext(id('b'), 'worker', now);
    await db
      .prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='account-a'")
      .run();
    await expect(
      store.commitLocalStep(
        id('b'),
        'task-1',
        'worker',
        { ok: true },
        [db.prepare("UPDATE boards_boards SET title='changed' WHERE id='board-a'")],
        now,
      ),
    ).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(
      await db.prepare("SELECT title FROM boards_boards WHERE id='board-a'").first('title'),
    ).toBe('notes');
  });
  it('a local transaction failure leaves neither a receipt nor partial domain writes', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await expect(
      store.commitLocalStep(
        id(),
        'task-1',
        'worker',
        { ok: true },
        [
          db
            .prepare(
              "INSERT INTO boards_boards(id,account_id,title,is_main,position,created_at) VALUES ('board-a','account-a','notes',0,1,?)",
            )
            .bind(now),
          db.prepare('INSERT INTO missing_table VALUES (1)'),
        ],
        now,
      ),
    ).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM boards_boards').first('n')).toBe(0);
    expect((await store.getStep(id(), 'task-1'))?.state).toBe('claimed');
  });
  it('does not turn a completed operation into a cancelled one', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.commitLocalStep(id(), 'task-1', 'worker', { ok: true }, [], now);
    await store.cancel(id(), 'account-a', now + 1);
    expect((await store.get(id(), 'account-a'))?.state).toBe('succeeded');
  });
  it('converts list capacity once with its confirmed projection', async () => {
    const { store, db } = await fixture();
    await db
      .prepare("UPDATE tasks_account_state SET inventory_count=1999 WHERE account_id='account-a'")
      .run();
    await store.admit(
      {
        ...input(),
        kind: 'list.create',
        listSlots: 1,
        steps: [{ key: 'list', kind: 'list.create', input: { title: 'a' } }],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'list', 'worker', now);
    await store.recordResponse(id(), 'list', 'worker', { id: 'google-list' }, now);
    await store.commitStep(
      id(),
      'list',
      'worker',
      { id: 'lanes-list' },
      [
        db.prepare(
          "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES ('lanes-list','account-a','google-list','a')",
        ),
      ],
      now,
    );
    expect(
      await db
        .prepare('SELECT remaining FROM tasks_list_reservations WHERE operation_id=?')
        .bind(id())
        .first('remaining'),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT inventory_count FROM tasks_account_state WHERE account_id='account-a'")
        .first('inventory_count'),
    ).toBe(2000);
    await store.commitStep(id(), 'list', 'worker', { id: 'lanes-list' }, [], now + 1);
    expect(
      await db
        .prepare("SELECT inventory_count FROM tasks_account_state WHERE account_id='account-a'")
        .first('inventory_count'),
    ).toBe(2000);
  });
});

describe('settled cancellation and inventory overlap', () => {
  it('finishes a cancelled plan after its already issued request settles', async () => {
    const { store } = await fixture();
    await store.admit(
      {
        ...input(),
        steps: [
          ...input().steps,
          { key: 'task-2', kind: 'task.create', input: { title: 'second' } },
        ],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.cancel(id(), 'account-a', now + 1);
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'google-task' }, now + 2);
    await store.commitStep(id(), 'task-1', 'worker', { id: 'stable-task' }, [], now + 3);
    expect((await store.get(id(), 'account-a'))?.state).toBe('cancelled');
    expect((await store.getStep(id(), 'task-2'))?.state).toBe('cancelled');
  });
  it('does not count a created list twice if a complete inventory already saw it', async () => {
    const { store, db } = await fixture();
    await db
      .prepare("UPDATE tasks_account_state SET inventory_count=1999 WHERE account_id='account-a'")
      .run();
    await store.admit(
      {
        ...input(),
        listSlots: 1,
        steps: [{ key: 'list', kind: 'list.create', input: { title: 'a' } }],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'list', 'worker', now);
    await store.recordResponse(id(), 'list', 'worker', { id: 'google-list' }, now);
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,last_seen_scan) VALUES ('lanes-list','account-a','google-list','a','scan-new')",
      )
      .run();
    await db
      .prepare(
        "UPDATE tasks_account_state SET inventory_count=2000,last_complete_scan_id='scan-new',inventory_complete_at=? WHERE account_id='account-a'",
      )
      .bind(now + 1)
      .run();
    await store.commitStep(id(), 'list', 'worker', { id: 'lanes-list' }, [], now + 2);
    expect(
      await db
        .prepare("SELECT inventory_count FROM tasks_account_state WHERE account_id='account-a'")
        .first('inventory_count'),
    ).toBe(2000);
  });
  it('keeps only the uncertain list reservation when cancelling remaining list work', async () => {
    const { store, db } = await fixture();
    await store.admit(
      {
        ...input(),
        listSlots: 2,
        steps: [
          { key: 'list-a', kind: 'list.create', input: { title: 'a' } },
          { key: 'list-b', kind: 'list.create', input: { title: 'b' } },
        ],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'list-a', 'worker', now);
    await store.cancel(id(), 'account-a', now + 1);
    expect(
      await db
        .prepare('SELECT remaining FROM tasks_list_reservations WHERE operation_id=?')
        .bind(id())
        .first('remaining'),
    ).toBe(1);
  });
});

describe('definite rejection and retention', () => {
  it('drops terminal request bodies after24hours while retaining minimal90day replay receipts', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.recordResponse(
      id(),
      'task-1',
      'worker',
      { id: 'created', notes: 'private response body' },
      now,
    );
    await store.commitStep(id(), 'task-1', 'worker', { taskId: 'created' }, [], now);
    expect(await store.pruneTerminalPayloads(100, now + 86400_000 - 1)).toBe(0);
    expect(await store.pruneTerminalPayloads(1, now + 86400_000)).toBe(1);
    expect(await store.pruneTerminalPayloads(1, now + 86400_000)).toBe(1);
    expect((await store.get(id(), 'account-a'))?.input).toBeNull();
    expect(await store.getStep(id(), 'task-1')).toMatchObject({
      input: null,
      response: null,
      result: { taskId: 'created' },
    });
    await expect(store.admit(input(), now + 86400_000 + 1)).resolves.toMatchObject({
      state: 'succeeded',
    });
    await expect(
      store.admit({ ...input(), input: { title: 'changed' } }, now + 86400_000 + 1),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('pauses unsent disconnect work, invalidates old claims, and preserves explicit resume input', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await expect(store.drainDisconnect('account-a', 10, now + 1)).rejects.toMatchObject({
      code: 'conflict',
    });
    await db
      .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='account-a'")
      .run();
    expect(await store.drainDisconnect('account-a', 10, now + 1)).toEqual({
      done: true,
      pending: false,
      unresolved: false,
      repairOperationId: null,
    });
    expect((await store.get(id(), 'account-a'))?.state).toBe('reconnect_required');
    expect((await store.getStep(id(), 'task-1'))?.input).toEqual({ title: 'a task' });
    await expect(store.markDispatched(id(), 'task-1', 'worker', now + 2)).rejects.toThrow();
  });
  it('waits for issued work, then retains unknown outcomes or offers a recorded response for repair', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await db
      .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='account-a'")
      .run();
    expect(await store.drainDisconnect('account-a', 10, now + 1)).toMatchObject({
      pending: true,
      unresolved: true,
    });
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'confirmed' }, now + 2);
    expect(await store.drainDisconnect('account-a', 10, now + 31_000)).toMatchObject({
      repairOperationId: id(),
      pending: true,
    });
    await store.claimNext(id(), 'repair', now + 31_000);
    await store.commitStep(id(), 'task-1', 'repair', { id: 'confirmed' }, [], now + 31_001);
    expect(await store.drainDisconnect('account-a', 10, now + 31_002)).toMatchObject({
      done: true,
      unresolved: false,
    });
  });
  it('acknowledges an expired issued request as uncertain without forgetting its reserved capacity', async () => {
    const { store, db } = await fixture();
    await store.admit(
      {
        ...input(),
        listSlots: 1,
        steps: [{ key: 'list', kind: 'list.create', input: { title: 'a' } }],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'list', 'worker', now);
    await db
      .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='account-a'")
      .run();
    expect(await store.drainDisconnect('account-a', 10, now + 31_000)).toEqual({
      done: true,
      pending: false,
      unresolved: true,
      repairOperationId: null,
    });
    expect((await store.get(id(), 'account-a'))?.state).toBe('uncertain');
    expect(
      await db
        .prepare('SELECT remaining FROM tasks_list_reservations WHERE operation_id=?')
        .bind(id())
        .first('remaining'),
    ).toBe(1);
  });
  it('can revoke access after a known response needs provider reads that disconnect no longer permits', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'moved' }, now + 1);
    await db
      .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='account-a'")
      .run();
    await store.deferDisconnectRepair(id(), 'account-a', 'outcome_uncertain', now + 31_000);
    expect(await store.drainDisconnect('account-a', 10, now + 31_001)).toEqual({
      done: true,
      pending: false,
      unresolved: true,
      repairOperationId: null,
    });
    expect((await store.getStep(id(), 'task-1'))?.response).toEqual({ id: 'moved' });
  });
  it('fails an invalid unsealed capture and releases all reserved capacity before dispatch', async () => {
    const { store, db } = await fixture();
    await store.admit(
      {
        ...input(),
        totalSteps: 2,
        listSlots: 1,
        steps: [{ key: 'list', kind: 'list.create', input: { title: 'a' } }],
      },
      now,
    );
    await store.failUnsealed(id(), 'account-a', { code: 'validation_failed' }, now + 1);
    expect(await store.summary(id(), 'account-a')).toMatchObject({
      state: 'failed',
      finished: true,
    });
    expect(
      await db
        .prepare('SELECT remaining FROM tasks_list_reservations WHERE operation_id=?')
        .bind(id())
        .first('remaining'),
    ).toBe(0);
    expect(await store.claimNext(id(), 'worker', now + 2)).toBeNull();
  });
  it('atomically preserves output and stops unsent work when a dispatched destination disappears', async () => {
    const { store } = await fixture();
    await store.admit(
      {
        ...input(),
        steps: [
          ...input().steps,
          { key: 'task-2', kind: 'task.create', input: { title: 'remaining' } },
        ],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'confirmed' }, now + 1);
    await store.commitStep(
      id(),
      'task-1',
      'worker',
      { id: 'preserved' },
      store.prepareStopRemainingWrites(id(), { sql: '1=1', bindings: [] }),
      now + 2,
    );
    const summary = await store.summary(id(), 'account-a');
    expect(summary).toMatchObject({
      state: 'partial',
      finished: true,
      confirmedSteps: 1,
      cancelRequested: true,
      error: { code: 'destination_removed' },
    });
    expect((await store.getStep(id(), 'task-2'))?.state).toBe('cancelled');
    expect(await store.claimNext(id(), 'again', now + 60_000)).toBeNull();
    // A finished partial receipt does not permanently lock the original resource.
    await expect(store.admit(input(id('b')), now + 3)).resolves.toMatchObject({
      state: 'accepted',
    });
  });
  it('repairs a known response after cancellation even when the original worker died', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'created' }, now + 1);
    await store.cancel(id(), 'account-a', now + 2);
    const next = await store.claimNext(id(), 'repair', now + 31_001);
    expect(next?.mode).toBe('repair');
    await store.commitStep(id(), 'task-1', 'repair', { id: 'retained' }, [], now + 31_002);
    expect((await store.get(id(), 'account-a'))?.state).toBe('cancelled');
  });
  it('defers bounded repair reads without ever resending the confirmed mutation', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'created' }, now + 1);
    await store.deferRepair(id(), 'task-1', 'worker', { retryAt: now + 10_000 }, now + 2);
    expect(await store.claimNext(id(), 'early', now + 9_999)).toBeNull();
    expect((await store.claimNext(id(), 'repair', now + 10_000))?.mode).toBe('repair');
    await store.pauseRepair(id(), 'task-1', 'repair', { code: 'conflict' }, now + 10_001);
    expect(await store.claimNext(id(), 'automatic', now + 100_000)).toBeNull();
    expect((await store.getStep(id(), 'task-1'))?.response).toEqual({ id: 'created' });
  });
  it('backs off only a definitively rejected write and ignores a late worker claim', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.rejectStep(
      id(),
      'task-1',
      'worker',
      { code: 'provider_rate_limited', definitelyRejected: true, retryAt: now + 60_000 },
      now + 1,
    );
    expect(await store.claimNext(id(), 'early', now + 59_999)).toBeNull();
    expect((await store.claimNext(id(), 'next', now + 60_000))?.mode).toBe('dispatch');
    await expect(
      store.rejectStep(
        id(),
        'task-1',
        'worker',
        { code: 'forbidden', definitelyRejected: true },
        now + 60_001,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('marks an ambiguous response uncertain and retains creation capacity', async () => {
    const { store, db } = await fixture();
    await store.admit(
      {
        ...input(),
        listSlots: 1,
        steps: [{ key: 'list', kind: 'list.create', input: { title: 'a' } }],
      },
      now,
    );
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'list', 'worker', now);
    await store.rejectStep(
      id(),
      'list',
      'worker',
      { code: 'outcome_uncertain', definitelyRejected: false },
      now + 1,
    );
    expect((await store.get(id(), 'account-a'))?.state).toBe('uncertain');
    expect(await store.claimNext(id(), 'next', now + 100_000)).toBeNull();
    expect(
      await db
        .prepare('SELECT remaining FROM tasks_list_reservations WHERE operation_id=?')
        .bind(id())
        .first('remaining'),
    ).toBe(1);
  });
  it('releases an undispatched claim for reconnect and resumes only on an explicit request', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.releaseUndispatched(
      id(),
      'task-1',
      'worker',
      { state: 'reconnect_required', code: 'reconnect_required' },
      now + 1,
    );
    expect(await store.claimNext(id(), 'next', now + 40_000)).toBeNull();
    await store.resume(id(), 'account-a', now + 40_001);
    expect((await store.claimNext(id(), 'next', now + 40_001))?.mode).toBe('dispatch');
  });
  it('never requeues a known provider receipt as a rejection', async () => {
    const { store } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.markDispatched(id(), 'task-1', 'worker', now);
    await store.recordResponse(id(), 'task-1', 'worker', { id: 'real' }, now + 1);
    await expect(
      store.rejectStep(
        id(),
        'task-1',
        'worker',
        { code: 'provider_unavailable', definitelyRejected: true, retryAt: now + 60_000 },
        now + 2,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.getStep(id(), 'task-1'))?.response).toEqual({ id: 'real' });
  });
  it('prunes only terminal receipts after90days, preserving unfinished and uncertain work', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.commitLocalStep(id(), 'task-1', 'worker', { id: 'a' }, [], now);
    await store.admit({ ...input(id('b')), resourceKey: 'other' }, now);
    expect(await store.cleanup(100, now + 90 * 86400_000 - 1)).toBe(0);
    expect(await store.cleanup(100, now + 90 * 86400_000)).toBe(1);
    expect(await store.get(id('b'), 'account-a')).not.toBeNull();
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM tasks_operation_steps WHERE operation_id=?')
        .bind(id())
        .first('n'),
    ).toBe(0);
    await expect(store.admit(input(), now + 90 * 86400_000)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
