import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { HistoryService } from '../../history/server';
import { TasksLifecycle } from './lifecycle';
import { OperationStore } from './operations';
import { TaskMetadataService } from './metadata';
import { LabelDeletionWork } from './label-work';
const now = Date.parse('2026-11-03T00:00:00Z'),
  open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => open.splice(0).forEach((database) => database.close()));
async function fixture() {
  const database = testDatabase();
  open.push(database);
  const { db } = database;
  await seedAccount(db, 'a', now);
  await seedAccount(db, 'b', now);
  await db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES('list','a','google-list','home')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES('label','a','work','work','#aabbcc'),('other','b','other','other','#abcdef')",
    )
    .run();
  for (let index = 0; index < 23; index++)
    await db.batch([
      db
        .prepare(
          "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES(?,'a','list',?,'a task')",
        )
        .bind('task' + index, 'google' + index),
      db
        .prepare("INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES('a',?,'label')")
        .bind('task' + index),
    ]);
  const history = new HistoryService(db, { now: () => now }),
    metadata = new TaskMetadataService(db, { history, commitWrites: (writes) => db.batch(writes) }),
    context = {
      operationId: 'owner-delete',
      stepKey: 'start',
      origin: 'owner' as const,
      recordedAt: new Date(now).toISOString(),
    };
  await metadata.startLabelDeletion('a', 'label', 0, context, 'job');
  return { ...database, metadata, context, worker: new LabelDeletionWork(db, history, () => now) };
}
describe('admitted label deletion work', () => {
  it('completes bounded local slices after the browser leaves, with one atomic winner under overlap', async () => {
    const f = await fixture(),
      provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no provider access'));
    const results = await Promise.all([f.worker.advanceNext(), f.worker.advanceNext()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await f.metadata.getLabelDeletion('a', 'job')).toMatchObject({
      state: 'pending',
      removedAssociations: 10,
    });
    expect(await f.worker.advanceNext()).toBe(true);
    expect(await f.metadata.getLabelDeletion('a', 'job')).toMatchObject({
      removedAssociations: 20,
    });
    expect(await f.worker.advanceNext()).toBe(true);
    expect(await f.metadata.getLabelDeletion('a', 'job')).toMatchObject({
      state: 'completed',
      removedAssociations: 23,
    });
    expect(await f.worker.advanceNext()).toBe(false);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM history_events WHERE kind='labels_changed'")
        .first('n'),
    ).toBe(23);
    expect(
      await f.db.prepare("SELECT COUNT(*) AS n FROM tasks_labels WHERE account_id='b'").first('n'),
    ).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });
  it('keeps disconnect-paused work stopped after relink until explicit continuation', async () => {
    const f = await fixture();
    await f.db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
    const lifecycle = new TasksLifecycle(f.db, {
      operations: new OperationStore(f.db),
      commands: {
        advance: async () => {
          throw new Error('no provider command');
        },
      },
      now: () => now,
    });
    for (let turn = 0; turn < 5; turn++) if ((await lifecycle.pause('a')).done) break;
    await f.db.prepare("UPDATE accounts_connections SET state='connected' WHERE id='a'").run();
    expect(await f.worker.advanceNext()).toBe(false);
    await f.metadata.continueLabelDeletion(
      'a',
      'job',
      { ...f.context, stepKey: 'explicit-continue' },
      10,
    );
    expect(await f.worker.advanceNext()).toBe(true);
    expect(await f.metadata.getLabelDeletion('a', 'job')).toMatchObject({
      removedAssociations: 20,
    });
  });
});
