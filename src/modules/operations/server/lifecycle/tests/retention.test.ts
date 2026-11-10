import { afterEach, describe, expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';

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
  return { ...database, store: createOperationStore(database.db) };
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

describe('operation retention', () => {
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
    expect(await store.retention.pruneTerminalPayloads(100, now + 86400_000 - 1)).toBe(0);
    expect(await store.retention.pruneTerminalPayloads(1, now + 86400_000)).toBe(1);
    expect(await store.retention.pruneTerminalPayloads(1, now + 86400_000)).toBe(1);
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
  it('prunes only terminal receipts after90days, preserving unfinished and uncertain work', async () => {
    const { store, db } = await fixture();
    await store.admit(input(), now);
    await store.claimNext(id(), 'worker', now);
    await store.commitLocalStep(id(), 'task-1', 'worker', { id: 'a' }, [], now);
    await store.admit({ ...input(id('b')), resourceKey: 'other' }, now);
    expect(await store.retention.cleanup(100, now + 90 * 86400_000 - 1)).toBe(0);
    expect(await store.retention.cleanup(100, now + 90 * 86400_000)).toBe(1);
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
