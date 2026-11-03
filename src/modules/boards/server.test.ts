import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { testDatabase, seedAccount } from '../../../tests/sqlite-d1';
import { AppError } from '../../contracts/errors';
import { BoardAppearanceSchema, CreateBoardSchema } from './contracts';
import { BoardService } from './server';
import { readActiveList } from '../tasks/server/list-queries';

let database: ReturnType<typeof testDatabase>;
let db: D1Database;
let boards: BoardService;
const accountId = 'account-a';

async function localWritable(account: string) {
  const row = await db
    .prepare('SELECT state FROM accounts_connections WHERE id=?')
    .bind(account)
    .first<{ state: string }>();
  if (!row) throw new AppError('not_found', 'account not found', 404);
  if (row.state === 'disconnected' || row.state === 'disconnecting')
    throw new AppError('forbidden', 'this workspace is read-only until reconnected', 403);
}
async function seedList(
  id: string,
  boardId: string,
  options: { accountId?: string; position?: number; isDefault?: boolean; color?: string } = {},
) {
  const account = options.accountId ?? accountId;
  await db
    .prepare(
      'INSERT INTO tasks_lists(id,account_id,provider_id,title,is_default) VALUES (?,?,?,?,?)',
    )
    .bind(id, account, `google-${id}`, `title ${id}`, options.isDefault ? 1 : 0)
    .run();
  await db
    .prepare(
      'INSERT INTO boards_memberships(account_id,list_id,board_id,position,color) VALUES (?,?,?,?,?)',
    )
    .bind(account, id, boardId, options.position ?? 0, options.color ?? '#f8f6ef')
    .run();
  await db
    .prepare(
      'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,notes) VALUES (?,?,?,?,?,?)',
    )
    .bind(`task-${id}`, account, id, `google-task-${id}`, `task in ${id}`, 'keep this note')
    .run();
}
function taskData() {
  return {
    lists: database.sqlite.prepare('SELECT * FROM tasks_lists ORDER BY id').all(),
    tasks: database.sqlite.prepare('SELECT * FROM tasks_tasks ORDER BY id').all(),
    state: database.sqlite.prepare('SELECT * FROM tasks_account_state ORDER BY account_id').all(),
  };
}
async function listIds(boardId: string) {
  return (await boards.listBoardLists(accountId, boardId)).items.map((item) => item.id);
}

beforeEach(async () => {
  database = testDatabase();
  db = database.db;
  await seedAccount(db, accountId);
  await seedAccount(db, 'account-b');
  boards = new BoardService(db, { assertLocalWritable: localWritable });
});
afterEach(() => database.close());

describe('board contracts', () => {
  it('trims titles, permits duplicate names, and keeps safe appearance defaults', async () => {
    expect(CreateBoardSchema.parse({ title: '  my things  ' })).toEqual({
      title: 'my things',
      emoji: null,
      color: '#f1f0e9',
      backgroundUrl: null,
    });
    const one = await boards.createBoard(accountId, { title: 'same' });
    const two = await boards.createBoard(accountId, { title: 'same' });
    expect(one.id).not.toBe(two.id);
  });
  it('accepts one emoji grapheme and static https images, never executable styles', () => {
    expect(
      BoardAppearanceSchema.safeParse({
        emoji: '🌱',
        color: '#AABBCC',
        backgroundUrl: 'https://example.com/paper.jpg',
      }).success,
    ).toBe(true);
    expect(
      BoardAppearanceSchema.safeParse({ backgroundUrl: '/backgrounds/lines.svg' }).success,
    ).toBe(true);
    expect(
      BoardAppearanceSchema.safeParse({ backgroundUrl: '/backgrounds/../secrets' }).success,
    ).toBe(false);
    expect(BoardAppearanceSchema.safeParse({ emoji: '👨‍👩‍👧‍👦' }).success).toBe(true);
    expect(BoardAppearanceSchema.safeParse({ emoji: 'two words' }).success).toBe(false);
    for (const value of [
      'javascript:alert(1)',
      'data:image/svg+xml,boom',
      'http://example.com/a.jpg',
      'https://user:password@example.com/a.jpg',
    ]) {
      expect(BoardAppearanceSchema.safeParse({ backgroundUrl: value }).success).toBe(false);
    }
    expect(BoardAppearanceSchema.safeParse({ color: 'url(https://example.com)' }).success).toBe(
      false,
    );
  });
});

describe('main board and empty boards', () => {
  it('initializes one stable main board under concurrent calls without creating google lists', async () => {
    const before = taskData();
    const [one, two] = await Promise.all([
      boards.ensureMainBoard(accountId),
      boards.ensureMainBoard(accountId),
    ]);
    expect(one.id).toBe(two.id);
    expect(one).toMatchObject({ title: 'everyday', isMain: true, accountId });
    expect((await boards.listBoards(accountId)).items).toHaveLength(1);
    expect(taskData()).toEqual(before);
  });
  it('binds pagination cursors to their account and collection', async () => {
    await boards.createBoard(accountId, { title: 'one' });
    const page = await boards.listBoards(accountId, { limit: 1 });
    await expect(
      boards.listBoards('account-b', { cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const main = await boards.ensureMainBoard(accountId);
    await expect(
      boards.listBoardLists(accountId, main.id, { cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('keeps a renamed main board and creates a separate main board per account', async () => {
    const main = await boards.ensureMainBoard(accountId);
    await boards.renameBoard(accountId, main.id, 'a home', main.revision);
    expect((await boards.ensureMainBoard(accountId)).title).toBe('a home');
    expect((await boards.ensureMainBoard('account-b')).id).not.toBe(main.id);
  });
  it('creates an empty board with no task or list mutations', async () => {
    const main = await boards.ensureMainBoard(accountId);
    await seedList('original', main.id);
    const before = taskData();
    const created = await boards.createBoard(accountId, { title: '  another corner  ' });
    expect(created).toMatchObject({ title: 'another corner', isMain: false, revision: 0 });
    expect((await boards.listBoardLists(accountId, created.id)).items).toEqual([]);
    expect(taskData()).toEqual(before);
  });
  it('paginates board metadata with a stable cursor and rejects invalid limits/cursors', async () => {
    for (let index = 0; index < 55; index++)
      await boards.createBoard(accountId, { title: `board ${index}` });
    const first = await boards.listBoards(accountId);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await boards.listBoards(accountId, { cursor: first.nextCursor! });
    expect(second.items).toHaveLength(6);
    expect(new Set([...first.items, ...second.items].map((board) => board.id)).size).toBe(56);
    expect(second.nextCursor).toBeNull();
    await expect(boards.listBoards(accountId, { limit: 101 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(boards.listBoards(accountId, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('board edits and order', () => {
  it('renames and changes appearance with revision compare-and-set', async () => {
    const original = await boards.createBoard(accountId, { title: 'original' });
    const changed = await boards.updateBoard(
      accountId,
      original.id,
      {
        title: 'renamed',
        emoji: '🌱',
        color: '#AABBCC',
        backgroundUrl: 'https://example.com/a.jpg',
      },
      original.revision,
    );
    expect(changed).toMatchObject({
      id: original.id,
      title: 'renamed',
      color: '#aabbcc',
      emoji: '🌱',
      backgroundUrl: 'https://example.com/a.jpg',
      revision: original.revision + 1,
    });
    await expect(
      boards.renameBoard(accountId, original.id, 'stale', original.revision),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await boards.getBoard(accountId, original.id)).title).toBe('renamed');
  });
  it('distinguishes omitted appearance fields from explicit clearing', async () => {
    const original = await boards.createBoard(accountId, {
      title: 'one',
      emoji: '🌱',
      backgroundUrl: 'https://example.com/a.jpg',
    });
    const changed = await boards.updateAppearance(
      accountId,
      original.id,
      { color: '#112233' },
      original.revision,
    );
    expect(changed.emoji).toBe('🌱');
    expect(changed.backgroundUrl).toBe('https://example.com/a.jpg');
    const cleared = await boards.updateAppearance(
      accountId,
      original.id,
      { emoji: null, backgroundUrl: null },
      changed.revision,
    );
    expect(cleared).toMatchObject({ emoji: null, backgroundUrl: null, color: '#112233' });
  });
  it('reorders boards atomically while leaving task projections unchanged', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const alpha = await boards.createBoard(accountId, { title: 'alpha' });
    const beta = await boards.createBoard(accountId, { title: 'beta' });
    const gamma = await boards.createBoard(accountId, { title: 'gamma' });
    await seedList('original', alpha.id);
    const before = taskData();
    const moved = await boards.reorderBoard(accountId, gamma.id, gamma.revision, 1);
    expect(moved.position).toBe(1);
    expect((await boards.listBoards(accountId)).items.map((board) => board.id)).toEqual([
      main.id,
      gamma.id,
      alpha.id,
      beta.id,
    ]);
    expect(taskData()).toEqual(before);
    await expect(boards.reorderBoard(accountId, gamma.id, gamma.revision, 0)).rejects.toMatchObject(
      { code: 'conflict' },
    );
  });
});

describe('list placement', () => {
  it('moves a list between boards at the chosen position without changing google/task data', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const target = await boards.createBoard(accountId, { title: 'target' });
    await seedList('a', main.id, { position: 0, color: '#abcdef' });
    await seedList('x', target.id, { position: 0 });
    await seedList('y', target.id, { position: 1 });
    const before = taskData();
    const membership = await boards.getMembership(accountId, 'a');
    const moved = await boards.moveList(accountId, 'a', target.id, membership.revision, 1);
    expect(moved).toMatchObject({
      boardId: target.id,
      position: 1,
      color: '#abcdef',
      revision: membership.revision + 1,
    });
    expect(await listIds(target.id)).toEqual(['x', 'a', 'y']);
    expect(await listIds(main.id)).toEqual([]);
    expect(taskData()).toEqual(before);
  });
  it('paginates list membership without losing provider or placement revisions', async () => {
    const main = await boards.ensureMainBoard(accountId);
    for (let index = 0; index < 60; index++)
      await seedList('list-' + String(index).padStart(2, '0'), main.id, { position: index });
    const first = await boards.listBoardLists(accountId, main.id);
    const second = await boards.listBoardLists(accountId, main.id, { cursor: first.nextCursor! });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map((list) => list.id)).size).toBe(60);
    expect(first.items[0]).toMatchObject({
      providerId: 'google-list-00',
      revision: 0,
      membershipRevision: 0,
      boardId: main.id,
    });
    expect(second.nextCursor).toBeNull();
  });
  it('keeps source membership when the destination disappears after its pre-read', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const target = await boards.createBoard(accountId, { title: 'target' });
    await seedList('a', main.id);
    let raced = false;
    const racingDb = new Proxy(db, {
      get(base, property, receiver) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await boards.deleteBoard(accountId, target.id, target.revision);
            }
            return base.batch(statements);
          };
        return Reflect.get(base, property, receiver);
      },
    });
    const mover = new BoardService(racingDb, { assertLocalWritable: localWritable });
    await expect(mover.moveList(accountId, 'a', target.id, 0)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await boards.getMembership(accountId, 'a')).boardId).toBe(main.id);
  });
  it('permits only one of two concurrent moves of the same membership', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const one = await boards.createBoard(accountId, { title: 'one' });
    const two = await boards.createBoard(accountId, { title: 'two' });
    await seedList('a', main.id);
    const results = await Promise.allSettled([
      boards.moveList(accountId, 'a', one.id, 0),
      boards.moveList(accountId, 'a', two.id, 0),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ code: 'conflict' });
    const rows = await db
      .prepare('SELECT * FROM boards_memberships WHERE account_id=? AND list_id=?')
      .bind(accountId, 'a')
      .all();
    expect(rows.results).toHaveLength(1);
  });
  it('keeps the default google list on main while permitting reordering within main', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const another = await boards.createBoard(accountId, { title: 'another' });
    await seedList('default', main.id, { position: 0, isDefault: true });
    await seedList('other', main.id, { position: 1 });
    await expect(boards.moveList(accountId, 'default', another.id, 0)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const changed = await boards.moveList(accountId, 'default', main.id, 0, 1);
    expect(changed.boardId).toBe(main.id);
    expect(await listIds(main.id)).toEqual(['other', 'default']);
  });
  it('rejects cross-account list and destination references without losing source placement', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const foreign = await boards.ensureMainBoard('account-b');
    await seedList('a', main.id);
    await expect(boards.moveList(accountId, 'a', foreign.id, 0)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(boards.moveList('account-b', 'a', foreign.id, 0)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await boards.getMembership(accountId, 'a')).boardId).toBe(main.id);
  });
  it('does not call an uninitialized or stale provider projection fresh', async () => {
    const main = await boards.ensureMainBoard(accountId);
    await seedList('a', main.id);
    await db
      .prepare('UPDATE tasks_account_state SET inventory_complete_at=NULL WHERE account_id=?')
      .bind(accountId)
      .run();
    expect((await boards.listBoardLists(accountId, main.id)).coverage).toEqual({
      complete: false,
      lastSyncedAt: null,
      stale: true,
    });
    await db
      .prepare('UPDATE tasks_account_state SET inventory_complete_at=? WHERE account_id=?')
      .bind(Date.now() - 120_000, accountId)
      .run();
    expect((await boards.listBoardLists(accountId, main.id)).coverage).toMatchObject({
      complete: true,
      stale: true,
    });
    await db
      .prepare('UPDATE tasks_lists SET deleted_at=? WHERE account_id=? AND id=?')
      .bind(Date.now(), accountId, 'a')
      .run();
    const missing = await boards.listBoardLists(accountId, main.id);
    expect(missing.items).toEqual([]);
    expect(missing.coverage).toMatchObject({ complete: false, stale: true });
    await expect(boards.updateListAppearance(accountId, 'a', '#abcdef', 0)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('styles list appearance through a separate membership revision without editing the list', async () => {
    const main = await boards.ensureMainBoard(accountId);
    await seedList('a', main.id);
    const before = await readActiveList(db, accountId, 'a');
    const changed = await boards.updateListAppearance(accountId, 'a', '#ABCDEF', 0);
    expect(changed).toMatchObject({ color: '#abcdef', revision: 1 });
    expect(await readActiveList(db, accountId, 'a')).toEqual(before);
    await expect(boards.updateListAppearance(accountId, 'a', '#123456', 0)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('board deletion', () => {
  it('atomically appends lists to main in relative order and keeps all source data', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await seedList('existing', main.id, { position: 7 });
    await seedList('one', custom.id, { position: 3 });
    await seedList('two', custom.id, { position: 8 });
    const before = taskData();
    const result = await boards.deleteBoard(accountId, custom.id, custom.revision);
    expect(result).toMatchObject({
      deletedBoardId: custom.id,
      mainBoardId: main.id,
      movedListCount: 2,
    });
    expect(await listIds(main.id)).toEqual(['existing', 'one', 'two']);
    await expect(boards.getBoard(accountId, custom.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(taskData()).toEqual(before);
  });
  it('refuses main-board deletion and wrong-account deletion', async () => {
    const main = await boards.ensureMainBoard(accountId);
    await expect(boards.deleteBoard(accountId, main.id, main.revision)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(boards.deleteBoard('account-b', main.id, main.revision)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await boards.ensureMainBoard(accountId)).id).toBe(main.id);
  });
  it('runs the cross-owner delete writes in the same transaction', async () => {
    database.sqlite.exec('CREATE TABLE hook_effects(board_id TEXT PRIMARY KEY)');
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    const withHook = new BoardService(db, {
      assertLocalWritable: localWritable,
      onDeleteWrites: (_, id) => [
        db.prepare('INSERT INTO hook_effects(board_id) VALUES (?)').bind(id),
      ],
    });
    await withHook.deleteBoard(accountId, custom.id, custom.revision);
    expect(database.sqlite.prepare('SELECT board_id FROM hook_effects').all()).toEqual([
      { board_id: custom.id },
    ]);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM boards_write_guards').get()?.n).toBe(
      0,
    );
  });
  it('rolls back membership moves and board removal when a delete hook fails', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await seedList('a', custom.id);
    database.sqlite.exec('CREATE TABLE failing_hook(valid INTEGER CHECK(valid=1))');
    const withHook = new BoardService(db, {
      assertLocalWritable: localWritable,
      onDeleteWrites: () => [db.prepare('INSERT INTO failing_hook(valid) VALUES (0)')],
    });
    await expect(withHook.deleteBoard(accountId, custom.id, custom.revision)).rejects.toMatchObject(
      { code: 'storage_unavailable' },
    );
    expect((await boards.getMembership(accountId, 'a')).boardId).toBe(custom.id);
    expect((await boards.getBoard(accountId, custom.id)).revision).toBe(custom.revision);
    expect(await listIds(main.id)).toEqual([]);
  });
  it('aborts hooks when a competing edit commits between the pre-read and the batch', async () => {
    database.sqlite.exec('CREATE TABLE hook_effects(board_id TEXT PRIMARY KEY)');
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await seedList('a', custom.id);
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await boards.renameBoard(accountId, custom.id, 'changed elsewhere', custom.revision);
            }
            return target.batch(statements);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const withHook = new BoardService(racingDb, {
      assertLocalWritable: localWritable,
      onDeleteWrites: (_, id) => [
        db.prepare('INSERT INTO hook_effects(board_id) VALUES (?)').bind(id),
      ],
    });
    await expect(withHook.deleteBoard(accountId, custom.id, custom.revision)).rejects.toMatchObject(
      { code: 'conflict' },
    );
    expect((await boards.getBoard(accountId, custom.id)).title).toBe('changed elsewhere');
    expect((await boards.getMembership(accountId, 'a')).boardId).toBe(custom.id);
    expect(database.sqlite.prepare('SELECT * FROM hook_effects').all()).toEqual([]);
    expect(database.sqlite.prepare('SELECT * FROM boards_write_guards').all()).toEqual([]);
  });
  it('does not execute delete hooks or relocate lists when a revision is stale', async () => {
    database.sqlite.exec('CREATE TABLE hook_effects(board_id TEXT PRIMARY KEY)');
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await seedList('a', custom.id);
    await boards.renameBoard(accountId, custom.id, 'renamed', custom.revision);
    const withHook = new BoardService(db, {
      assertLocalWritable: localWritable,
      onDeleteWrites: (_, id) => [
        db.prepare('INSERT INTO hook_effects(board_id) VALUES (?)').bind(id),
      ],
    });
    await expect(withHook.deleteBoard(accountId, custom.id, custom.revision)).rejects.toMatchObject(
      { code: 'conflict' },
    );
    expect((await boards.getMembership(accountId, 'a')).boardId).toBe(custom.id);
    expect(database.sqlite.prepare('SELECT * FROM hook_effects').all()).toEqual([]);
  });
});

describe('local account write boundary', () => {
  it('requires the local write guard for placement, appearance, order, and first initialization', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await seedList('a', main.id);
    await db.prepare("UPDATE accounts_connections SET state='disconnected'").run();
    await expect(boards.moveList(accountId, 'a', custom.id, 0)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(boards.updateListAppearance(accountId, 'a', '#abcdef', 0)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(boards.reorderBoard(accountId, custom.id, 0, 0)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(boards.ensureMainBoard('account-b')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await boards.getMembership(accountId, 'a')).boardId).toBe(main.id);
  });
  it('allows local edits while google needs reconnect and keeps reads available when disconnected', async () => {
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await db
      .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id=?")
      .bind(accountId)
      .run();
    const renamed = await boards.renameBoard(
      accountId,
      custom.id,
      'still organized',
      custom.revision,
    );
    expect(renamed.title).toBe('still organized');
    await db
      .prepare("UPDATE accounts_connections SET state='disconnected' WHERE id=?")
      .bind(accountId)
      .run();
    expect((await boards.listBoards(accountId)).items.length).toBeGreaterThan(0);
    await expect(
      boards.renameBoard(accountId, custom.id, 'forbidden', renamed.revision),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(boards.createBoard(accountId, { title: 'forbidden' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(boards.deleteBoard(accountId, custom.id, renamed.revision)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('operation commit integration', () => {
  it('uses the captured server identity and commits the board with its receipt atomically', async () => {
    await boards.ensureMainBoard(accountId);
    database.sqlite.exec('CREATE TABLE operation_receipts(id TEXT PRIMARY KEY)');
    const admitted = new BoardService(db, {
      assertLocalWritable: localWritable,
      commitWrites: async (statements) => {
        const results = await db.batch([
          ...statements,
          db.prepare('INSERT INTO operation_receipts(id) VALUES (?)').bind('operation-one'),
        ]);
        return results.slice(0, statements.length);
      },
    });
    const created = await admitted.createBoard(
      accountId,
      { title: 'admitted board' },
      'captured-board-id',
    );
    expect(created.id).toBe('captured-board-id');
    expect(database.sqlite.prepare('SELECT id FROM operation_receipts').all()).toEqual([
      { id: 'operation-one' },
    ]);
  });
  it('rolls back a local change when receipt persistence fails', async () => {
    const original = await boards.createBoard(accountId, { title: 'original' });
    database.sqlite.exec('CREATE TABLE operation_receipts(valid INTEGER CHECK(valid=1))');
    const admitted = new BoardService(db, {
      assertLocalWritable: localWritable,
      commitWrites: async (statements) => {
        const results = await db.batch([
          ...statements,
          db.prepare('INSERT INTO operation_receipts(valid) VALUES (0)'),
        ]);
        return results.slice(0, statements.length);
      },
    });
    await expect(
      admitted.renameBoard(accountId, original.id, 'must roll back', original.revision),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect((await boards.getBoard(accountId, original.id)).title).toBe('original');
    expect((await boards.getBoard(accountId, original.id)).revision).toBe(original.revision);
  });
  it('passes every user mutation through the journal executor and preserves its typed refusal', async () => {
    const main = await boards.ensureMainBoard(accountId);
    const custom = await boards.createBoard(accountId, { title: 'custom' });
    await seedList('a', main.id);
    const admitted = new BoardService(db, {
      assertLocalWritable: localWritable,
      commitWrites: async () => {
        throw new AppError('conflict', 'the operation no longer owns its execution claim', 409);
      },
    });
    const beforeBoards = database.sqlite.prepare('SELECT * FROM boards_boards ORDER BY id').all();
    const beforeMemberships = database.sqlite
      .prepare('SELECT * FROM boards_memberships ORDER BY list_id')
      .all();
    for (const run of [
      () => admitted.createBoard(accountId, { title: 'forbidden' }, 'never-created'),
      () => admitted.renameBoard(accountId, custom.id, 'forbidden', custom.revision),
      () => admitted.updateAppearance(accountId, custom.id, { color: '#123456' }, custom.revision),
      () => admitted.reorderBoard(accountId, custom.id, custom.revision, 0),
      () => admitted.moveList(accountId, 'a', custom.id, 0),
      () => admitted.updateListAppearance(accountId, 'a', '#123456', 0),
      () => admitted.deleteBoard(accountId, custom.id, custom.revision),
    ])
      await expect(run()).rejects.toMatchObject({ code: 'conflict' });
    expect(database.sqlite.prepare('SELECT * FROM boards_boards ORDER BY id').all()).toEqual(
      beforeBoards,
    );
    expect(
      database.sqlite.prepare('SELECT * FROM boards_memberships ORDER BY list_id').all(),
    ).toEqual(beforeMemberships);
  });
});
