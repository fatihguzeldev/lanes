import { afterEach, describe, expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { TasksLifecycle } from '../../../../tasks/server/lifecycle/account';
import type { StopRecordedIntent } from '../context';

const now = 1_793_641_000_000;
const operationId = `${now}:${'s'.repeat(32)}`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture(list = false) {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'account-a', now);
  await seedAccount(database.db, 'account-b', now);
  const store = createOperationStore(database.db);
  await store.admit(
    {
      id: operationId,
      accountId: 'account-a',
      ownerSubject: 'owner',
      kind: list ? 'list.create' : 'task.create',
      resourceKey: 'source',
      input: { title: 'captured' },
      steps: [
        { key: 'issued', kind: list ? 'list.create' : 'task.create', input: { title: 'captured' } },
        { key: 'later', kind: list ? 'list.create' : 'task.create', input: { title: 'later' } },
      ],
      ...(list ? { listSlots: 2 } : {}),
    },
    now,
  );
  await store.claimNext(operationId, 'original', now);
  await store.markDispatched(operationId, 'issued', 'original', now);
  const stop: StopRecordedIntent = {
    operationId,
    accountId: 'account-a',
    stepKey: 'issued',
    expectedClaimId: 'original',
    expectedResponse: null,
    decision: 'keep_provider_current',
    evidence: {
      kind: 'provider_readback',
      providerId: 'opaque/real+id',
      etag: 'current-v2',
      digest: 'preview-hash',
    },
  };
  return { ...database, store, stop };
}

describe('explicitly stopped recorded intent', () => {
  it('atomically preserves unknown outcome and projection, stops only unsent work, and rejects every late worker path', async () => {
    const { db, store, stop } = await fixture();
    const write = db.prepare(
      "UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id='account-a'",
    );
    await store.stopRecordedIntent(stop, [write], now + 31_000);
    expect(await store.queries.summary(operationId, 'account-a')).toMatchObject({
      state: 'partial',
      finished: true,
      cancelRequested: true,
      confirmedSteps: 0,
      error: { code: 'owner_stopped' },
    });
    expect(await store.getStep(operationId, 'issued')).toMatchObject({
      state: 'uncertain',
      response: null,
    });
    expect(await store.getStep(operationId, 'later')).toMatchObject({ state: 'cancelled' });
    expect(await store.getStoppedIntent(operationId, 'issued', 'account-a')).toMatchObject({
      stepKey: 'issued',
      decision: 'keep_provider_current',
      expectedResponseHash: null,
      evidence: stop.evidence,
    });
    expect(await store.findStoppedIntent(operationId, 'account-a')).toMatchObject({
      stepKey: 'issued',
    });
    expect(await store.getStoppedIntent(operationId, 'issued', 'account-b')).toBeNull();
    expect(await store.hasUnresolvedProviderWork('account-a')).toBe(false);
    expect(await store.firstUnresolvedStep(operationId, 'account-a', now + 32_000)).toBeNull();
    expect(await store.claimNext(operationId, 'late', now + 32_000)).toBeNull();
    expect(await store.queries.summary(operationId, 'account-a')).toMatchObject({
      state: 'partial',
      finished: true,
    });
    await expect(
      store.recordResponse(operationId, 'issued', 'original', { id: 'late' }, now + 32_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.commitStep(operationId, 'issued', 'original', {}, [write], now + 32_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.rejectStep(
        operationId,
        'issued',
        'original',
        { code: 'provider_unavailable', definitelyRejected: true, retryAt: now + 40_000 },
        now + 32_000,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.resume(operationId, 'account-a', now + 32_000)).rejects.toMatchObject({
      code: 'conflict',
    });
    await store.cancel(operationId, 'account-a', now + 32_000);
    await store.stopRecordedIntent(stop, [write], now + 32_000);
    expect(
      await db
        .prepare("SELECT graph_revision FROM tasks_account_state WHERE account_id='account-a'")
        .first('graph_revision'),
    ).toBe(1);
    expect((await store.queries.steps(operationId, 'account-a')).items[0]).toMatchObject({
      state: 'uncertain',
      stopDecision: 'keep_provider_current',
    });
  });
  it('fences active leases, account mismatch, replaced claim and changed response/evidence; SQL guard failure rolls everything back', async () => {
    const { store, stop, db } = await fixture();
    await expect(store.stopRecordedIntent(stop, [], now + 1)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      store.stopRecordedIntent({ ...stop, accountId: 'account-b' }, [], now + 31_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.stopRecordedIntent({ ...stop, expectedClaimId: 'other' }, [], now + 31_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.stopRecordedIntent({ ...stop, expectedResponse: { id: 'invented' } }, [], now + 31_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.stopRecordedIntent(
        stop,
        [db.prepare('INSERT INTO tasks_write_guards(valid) VALUES (0)')],
        now + 31_000,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.findStoppedIntent(operationId, 'account-a')).toBeNull();
    expect(await store.queries.summary(operationId, 'account-a')).toMatchObject({
      finished: false,
    });
    await store.stopRecordedIntent(stop, [], now + 31_000);
    await expect(
      store.stopRecordedIntent(
        { ...stop, evidence: { ...stop.evidence, digest: 'changed' } },
        [],
        now + 32_000,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.stopRecordedIntent({ ...stop, expectedClaimId: null }, [], now + 32_000),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('retains an immutable known provider receipt and rejects even its late identical replay', async () => {
    const { store, stop } = await fixture();
    const receipt = { id: 'created', title: 'original provider receipt' };
    await store.recordResponse(operationId, 'issued', 'original', receipt, now + 1);
    await store.stopRecordedIntent({ ...stop, expectedResponse: receipt }, [], now + 32_000);
    expect((await store.getStep(operationId, 'issued'))?.response).toEqual(receipt);
    expect(
      (await store.getStoppedIntent(operationId, 'issued', 'account-a'))?.expectedResponseHash,
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      store.recordResponse(operationId, 'issued', 'original', receipt, now + 33_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.resumeRecordedResponse(operationId, 'issued', 'account-a', now + 33_000),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      store.deferRepair(operationId, 'issued', 'original', { retryAt: now + 40_000 }, now + 33_000),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('can stop an expired repair with a null claim and retains its earlier readback receipt', async () => {
    const { store, stop } = await fixture();
    const response = { id: 'read-back' };
    await store.resolveUnknownResponse(
      {
        operationId,
        accountId: 'account-a',
        stepKey: 'issued',
        expectedClaimId: 'original',
        response,
        evidence: { kind: 'provider_readback', providerId: 'read-back' },
      },
      now + 31_000,
    );
    await store.stopRecordedIntent(
      { ...stop, expectedClaimId: null, expectedResponse: response },
      [],
      now + 32_000,
    );
    expect(await store.getResolution(operationId, 'issued', 'account-a')).toMatchObject({
      evidence: { providerId: 'read-back' },
    });
    expect(await store.getStoppedIntent(operationId, 'issued', 'account-a')).toMatchObject({
      expectedClaimId: null,
    });
  });
  it('invalidates complete list inventory before releasing uncertain and unsent list reservations', async () => {
    const { db, store, stop } = await fixture(true);
    await db.exec(
      `CREATE TRIGGER enforce_stale_inventory BEFORE UPDATE OF remaining ON tasks_list_reservations WHEN NEW.remaining<OLD.remaining BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM tasks_account_state WHERE account_id=NEW.account_id AND inventory_complete_at IS NOT NULL) THEN RAISE(ABORT,'stale inventory required') END; END`,
    );
    await store.stopRecordedIntent(stop, [], now + 31_000);
    expect(await store.lists.capacity('account-a', now + 32_000)).toMatchObject({
      known: null,
      reserved: 0,
      available: null,
      stale: true,
    });
    expect(
      await db
        .prepare("SELECT inventory_revision FROM tasks_account_state WHERE account_id='account-a'")
        .first('inventory_revision'),
    ).toBe(1);
  });
  it('rejects a disconnected or concurrently disconnecting account before installing local projection', async () => {
    const { db, store, stop } = await fixture();
    await db
      .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='account-a'")
      .run();
    await expect(store.stopRecordedIntent(stop, [], now + 31_000)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await store.findStoppedIntent(operationId, 'account-a')).toBeNull();
  });
  it('retains minimal stop evidence for 90 days and bounds all cleanup row changes including reservations', async () => {
    const { db, sqlite, store, stop } = await fixture();
    await store.stopRecordedIntent(stop, [], now + 31_000);
    const pruneAt = now + 31_000 + 86_400_000;
    await store.retention.pruneTerminalPayloads(100, pruneAt);
    await store.stopRecordedIntent(stop, [], pruneAt);
    expect(await store.findStoppedIntent(operationId, 'account-a')).not.toBeNull();
    expect(await store.retention.cleanup(100, now + 31_000 + 90 * 86_400_000 - 1)).toBe(0);
    for (let i = 0; i < 10 && (await store.get(operationId, 'account-a')); i++) {
      const before = sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      await store.retention.cleanup(1, now + 31_000 + 90 * 86_400_000);
      const after = sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      expect(after - before).toBeLessThanOrEqual(1);
    }
    expect(await store.findStoppedIntent(operationId, 'account-a')).toBeNull();
    expect(await store.get(operationId, 'account-a')).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_operation_stops').first('n')).toBe(0);
  });
  it('removes explicit stopped evidence before its journal parents with a one-row account-removal budget', async () => {
    const { db, sqlite, store, stop } = await fixture();
    await store.stopRecordedIntent(stop, [], now + 31_000);
    await db
      .prepare(
        "UPDATE accounts_connections SET state='disconnected',removal_requested_at=? WHERE id='account-a'",
      )
      .bind(now + 32_000)
      .run();
    const owner = new TasksLifecycle(db, {
      operations: store,
      commands: {
        advance: async () => {
          throw new Error('no repair allowed');
        },
      },
    });
    let done = false;
    for (let i = 0; i < 30 && !done; i++) {
      const before = sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      const result = await owner.remove('account-a', 1);
      done = result.done;
      const after = sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      expect(after - before).toBeLessThanOrEqual(1);
    }
    expect(done).toBe(true);
    expect(await store.get(operationId, 'account-a')).toBeNull();
    expect(
      await db.prepare("SELECT id FROM accounts_connections WHERE id='account-b'").first(),
    ).not.toBeNull();
  });
});
