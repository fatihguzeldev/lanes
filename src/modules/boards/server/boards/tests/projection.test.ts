import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { BoardProjection } from '../projection';
import { BoardService } from '../service';
const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => open.splice(0).forEach((database) => database.close()));
async function fixture() {
  const database = testDatabase();
  open.push(database);
  await seedAccount(database.db);
  const boards = new BoardService(database.db, { assertLocalWritable: async () => {} });
  const main = await boards.ensureMainBoard('account-a');
  return { ...database, boards, main, projection: new BoardProjection(database.db, boards) };
}
describe('list placement from confirmed provider data', () => {
  it('places new lists once and preserves custom organization through later sync', async () => {
    const { db, boards, projection, main } = await fixture();
    const list = {
      id: 'list',
      accountId: 'account-a',
      providerId: 'google',
      providerEtag: null,
      title: 'notes',
      isDefault: false,
      revision: 0,
    };
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES('list','account-a','google','notes')",
      )
      .run();
    await db.batch(projection.placementWrites(list, false));
    expect((await boards.queries.getMembership('account-a', 'list')).boardId).toBe(main.id);
    const custom = await boards.createBoard('account-a', { title: 'custom' });
    await boards.moveList('account-a', 'list', custom.id, 0);
    await db.batch(projection.placementWrites(list, false));
    expect((await boards.queries.getMembership('account-a', 'list')).boardId).toBe(custom.id);
  });
  it('moves a newly resolved default to main and fences stale membership edits', async () => {
    const { db, boards, projection, main } = await fixture();
    const custom = await boards.createBoard('account-a', { title: 'custom' });
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,is_default) VALUES('list','account-a','google','notes',1)",
      )
      .run();
    await db
      .prepare(
        'INSERT INTO boards_memberships(account_id,list_id,board_id,position) VALUES(?,?,?,0)',
      )
      .bind('account-a', 'list', custom.id)
      .run();
    await db.batch(
      projection.placementWrites(
        {
          id: 'list',
          accountId: 'account-a',
          providerId: 'google',
          providerEtag: null,
          title: 'notes',
          isDefault: true,
          revision: 0,
        },
        true,
      ),
    );
    const membership = await boards.queries.getMembership('account-a', 'list');
    expect(membership.boardId).toBe(main.id);
    expect(membership.revision).toBe(1);
    await db.batch(
      projection.placementWrites(
        {
          id: 'list',
          accountId: 'account-a',
          providerId: 'google',
          providerEtag: null,
          title: 'notes',
          isDefault: true,
          revision: 0,
        },
        false,
      ),
    );
    expect((await boards.queries.getMembership('account-a', 'list')).revision).toBe(1);
  });
  it('validates board ownership before exposing a selection', async () => {
    const { projection, main } = await fixture();
    await expect(projection.listSelection('account-b', main.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
