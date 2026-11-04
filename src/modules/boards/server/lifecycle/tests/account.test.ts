import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { BoardService } from '../../boards/service';
import { BoardLifecycle } from '../account';
import { ListSnapshotStore } from '../../../../tasks/server/templates/lists';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => open.splice(0).forEach((database) => database.close()));
async function fixture() {
  const database = testDatabase();
  open.push(database);
  await seedAccount(database.db, 'a');
  await seedAccount(database.db, 'b');
  const boards = new BoardService(database.db, { assertLocalWritable: async () => {} });
  await boards.ensureMainBoard('a');
  await boards.ensureMainBoard('b');
  return {
    ...database,
    boards,
    lifecycle: new BoardLifecycle(database.db, new ListSnapshotStore(database.db)),
  };
}
describe('board ownership in account removal', () => {
  it('rejects unconfirmed removal and leaves google task projections to their owner', async () => {
    const { db, lifecycle } = await fixture();
    await expect(lifecycle.remove('a')).rejects.toThrow();
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES('list','a','google','preserved until task cleanup')",
      )
      .run();
    await db
      .prepare(
        "UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='a'",
      )
      .run();
    expect((await lifecycle.remove('a')).done).toBe(true);
    expect(
      await db.prepare("SELECT title FROM tasks_lists WHERE account_id='a'").first('title'),
    ).toBe('preserved until task cleanup');
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE account_id='b'").first('n'),
    ).toBe(1);
  });
  it('bounds actual deleted rows even when an account has many boards', async () => {
    const { db, sqlite, boards, lifecycle } = await fixture();
    for (let index = 0; index < 125; index++)
      await boards.createBoard('a', { title: 'board ' + index });
    await db
      .prepare(
        "UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='a'",
      )
      .run();
    for (let index = 0; index < 20; index++) {
      const before = sqlite.prepare('SELECT total_changes() AS n').get()!.n as number;
      const result = await lifecycle.remove('a', 10);
      const after = sqlite.prepare('SELECT total_changes() AS n').get()!.n as number;
      expect(after - before).toBeLessThanOrEqual(10);
      expect(result.deleted).toBe(after - before);
      if (result.done) break;
    }
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM boards_boards WHERE account_id='a'").first('n'),
    ).toBe(0);
  });
});
