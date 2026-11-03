import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { TaskSnapshotReader } from './snapshot-reader';
const now = Date.parse('2026-11-02T12:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const item of databases.splice(0)) item.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  await seedAccount(database.db, 'b', now);
  await database.db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,projection_revision,tasks_complete_at,completed_complete_at) VALUES ('list','a','google-list','same title',1,3,?,?)",
    )
    .bind(now, now)
    .run();
  for (const [id, parent, position, completed] of [
    ['p', null, '001', 0],
    ['c', 'p', '001', 0],
    ['done', null, '002', 1],
  ] as const)
    await database.db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,notes,parent_id,provider_position,completed,revision) VALUES (?,'a','list',?,?,?, ?,?,?,1)",
      )
      .bind(id, 'google-' + id, id, 'exact\nnotes', parent, position, completed)
      .run();
  return { ...database, reader: new TaskSnapshotReader(database.db, { now: () => now }) };
}
it('captures only bounded identities, pages exact notes/hierarchy and enforces source account', async () => {
  const { reader, db } = await fixture();
  const snapshot = await reader.capture({
    id: 'snapshot',
    accountId: 'a',
    listIds: ['list'],
    includeCompleted: true,
  });
  expect(snapshot.taskCount).toBe(3);
  const first = await reader.page('snapshot', 'a', { limit: 2 });
  expect(first.items.map((x) => [x.key, x.task.id, x.parentKey])).toEqual([
    ['t1', 'p', null],
    ['t2', 'c', 't1'],
  ]);
  expect(first.items[0]?.task.notes).toBe('exact\nnotes');
  expect(first.nextCursor).not.toBeNull();
  expect(
    (await reader.page('snapshot', 'a', { cursor: first.nextCursor! })).items.map((x) => x.task.id),
  ).toEqual(['done']);
  await expect(reader.page('snapshot', 'b')).rejects.toMatchObject({ code: 'not_found' });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_snapshot_items').first('n')).toBe(3);
});
it('rejects incomplete coverage and oversized selection before capture', async () => {
  const { reader, db } = await fixture();
  await expect(
    reader.capture({
      id: 'small',
      accountId: 'a',
      listIds: ['list'],
      includeCompleted: true,
      maxTasks: 2,
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_snapshots').first('n')).toBe(0);
  await db.prepare("UPDATE tasks_lists SET completed_complete_at=NULL WHERE id='list'").run();
  await expect(
    reader.capture({ id: 'incomplete', accountId: 'a', listIds: ['list'], includeCompleted: true }),
  ).rejects.toMatchObject({ code: 'conflict' });
});
it('source CAS guards reject changed metadata or new children after capture without changing source', async () => {
  const { reader, db } = await fixture();
  await reader.capture({
    id: 'snapshot',
    accountId: 'a',
    listIds: ['list'],
    includeCompleted: false,
  });
  await db.batch(await reader.prepareCaptureGuards('snapshot', 'a'));
  await db
    .prepare("UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id='list'")
    .run();
  await expect(reader.page('snapshot', 'a')).rejects.toMatchObject({ code: 'conflict' });
  await expect(db.batch(await reader.prepareCaptureGuards('snapshot', 'a'))).rejects.toThrow();
  expect(await db.prepare("SELECT notes FROM tasks_tasks WHERE id='p'").first('notes')).toBe(
    'exact\nnotes',
  );
});
it('matches only exact account/provider addresses and reads thin references without titles as identity', async () => {
  const { reader } = await fixture();
  expect(await reader.providerReferences('a', ['p', 'c', 'foreign'])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'p', providerId: 'google-p', listProviderId: 'google-list' }),
    ]),
  );
  expect(
    (
      await reader.matchResources('a', {
        lists: ['google-list'],
        tasks: [{ id: 'google-c', listId: 'google-list' }],
      })
    ).tasks.map((task) => task.id),
  ).toEqual(['c']);
  expect(
    (
      await reader.matchResources('b', {
        lists: ['google-list'],
        tasks: [{ id: 'google-c', listId: 'google-list' }],
      })
    ).tasks,
  ).toEqual([]);
  expect(
    (await reader.matchResources('a', { tasks: [{ id: 'google-c', listId: 'other-list' }] })).tasks,
  ).toEqual([]);
});
it('removes snapshot-owned identities child-first within one actual-row budget', async () => {
  const { reader, db } = await fixture();
  await reader.capture({
    id: 'snapshot',
    accountId: 'a',
    listIds: ['list'],
    includeCompleted: true,
  });
  await expect(reader.removeAccountSlice('a', 2)).rejects.toThrow();
  await db
    .prepare(
      "UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='a'",
    )
    .run();
  expect(await reader.removeAccountSlice('a', 2)).toEqual({ done: false, deleted: 2 });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_snapshots').first('n')).toBe(1);
  let removed = 2;
  for (let n = 0; n < 10; n++) {
    const result = await reader.removeAccountSlice('a', 2);
    expect(result.deleted).toBeLessThanOrEqual(2);
    removed += result.deleted;
    if (result.done) break;
  }
  expect(removed).toBe(5);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_snapshots').first('n')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(3);
});
