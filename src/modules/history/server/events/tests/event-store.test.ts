import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { testDatabase, seedAccount } from '../../../../../../tests/support/sqlite-d1';
import { AppError } from '../../../../../shared/contracts/errors';
import { HistoryEventSchema, type HistoryEventInput } from '../../../contracts/events';
import { HistoryService, type BoardListSelection } from '../event-store';

let database: ReturnType<typeof testDatabase>;
let db: D1Database;
let now: number;
let history: HistoryService;
const accountId = 'account-a';
const day = 86_400_000;
const instant = (value: number) => new Date(value).toISOString();
function completed(
  id: string,
  overrides: Partial<
    Pick<
      HistoryEventInput,
      'accountId' | 'taskId' | 'listId' | 'recordedAt' | 'dedupKey' | 'taskTitle' | 'listTitle'
    >
  > = {},
): HistoryEventInput {
  return {
    id,
    schemaVersion: 1,
    accountId,
    taskId: 'task-a',
    listId: 'list-a',
    kind: 'task_completed',
    origin: 'owner',
    dedupKey: `operation-${id}:complete:task_completed`,
    recordedAt: instant(now),
    providerAt: instant(now - 1_000),
    taskTitle: 'finished task',
    listTitle: 'original list',
    summary: {
      operationId: `operation-${id}`,
      stepKey: 'complete',
      completedAt: instant(now - 1_000),
    },
    ...overrides,
  };
}
const boardSelection: BoardListSelection = async (account, boardId) => {
  const board = await db
    .prepare('SELECT id FROM boards_boards WHERE account_id=? AND id=?')
    .bind(account, boardId)
    .first();
  if (!board) throw new AppError('not_found', 'board not found', 404);
  return {
    sql: 'SELECT list_id FROM boards_memberships WHERE account_id=? AND board_id=?',
    bindings: [account, boardId],
  };
};
async function seedOrganization() {
  for (const [id, account, isMain] of [
    ['main-a', accountId, 1],
    ['other-a', accountId, 0],
    ['main-b', 'account-b', 1],
  ] as const) {
    await db
      .prepare(
        'INSERT INTO boards_boards(id,account_id,title,is_main,position,created_at) VALUES (?,?,?,?,?,?)',
      )
      .bind(id, account, id, isMain, 0, now)
      .run();
  }
  for (const [id, account, boardId] of [
    ['list-a', accountId, 'main-a'],
    ['list-b', accountId, 'other-a'],
    ['list-foreign', 'account-b', 'main-b'],
  ] as const) {
    await db
      .prepare('INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES (?,?,?,?)')
      .bind(id, account, 'google-' + id, id)
      .run();
    await db
      .prepare(
        'INSERT INTO boards_memberships(account_id,list_id,board_id,position) VALUES (?,?,?,0)',
      )
      .bind(account, id, boardId)
      .run();
  }
}

beforeEach(async () => {
  database = testDatabase();
  db = database.db;
  now = Date.parse('2026-11-02T12:00:00.000Z');
  await seedAccount(db, accountId, now);
  await seedAccount(db, 'account-b', now);
  history = new HistoryService(db, { now: () => now, boardListSelection: boardSelection });
});
afterEach(() => database.close());

describe('history event boundary', () => {
  it('accepts confirmed operation evidence and rejects pending or fabricated origins', () => {
    expect(HistoryEventSchema.safeParse(completed('one')).success).toBe(true);
    expect(HistoryEventSchema.safeParse({ ...completed('one'), origin: 'pending' }).success).toBe(
      false,
    );
    expect(
      HistoryEventSchema.safeParse({ ...completed('one'), summary: { completedAt: instant(now) } })
        .success,
    ).toBe(false);
  });
  it('keeps notes, title revisions, arbitrary summary fields and credentials out of history input', () => {
    expect(
      HistoryEventSchema.safeParse({ ...completed('one'), notes: 'private note' }).success,
    ).toBe(false);
    expect(
      HistoryEventSchema.safeParse({ ...completed('one'), kind: 'task_title_changed' }).success,
    ).toBe(false);
    expect(
      HistoryEventSchema.safeParse({ ...completed('one'), kind: 'task_reordered' }).success,
    ).toBe(false);
    expect(
      HistoryEventSchema.safeParse({
        ...completed('one'),
        summary: {
          operationId: 'op',
          stepKey: 'complete',
          completedAt: null,
          notes: 'private note',
        },
      }).success,
    ).toBe(false);
    expect(
      HistoryEventSchema.safeParse({
        ...completed('one'),
        summary: {
          operationId: 'op',
          stepKey: 'complete',
          completedAt: null,
          accessToken: 'secret',
        },
      }).success,
    ).toBe(false);
  });
  it('records creation context without treating imported completion as a live completion', async () => {
    const created = {
      ...completed('imported'),
      kind: 'task_created' as const,
      summary: { operationId: 'import-one', stepKey: 'row-one', source: 'import' as const },
    };
    await history.record(created);
    expect((await history.query(accountId)).items.map((event) => event.kind)).toEqual([
      'task_created',
    ]);
  });
  it('requires external version evidence and does not invent the external creation source', async () => {
    const observed = {
      ...completed('outside'),
      kind: 'task_created' as const,
      origin: 'observed' as const,
      providerAt: '2020-01-01T12:00:00Z',
      summary: { providerVersion: 'etag-one' },
    };
    const event = await history.record(observed);
    expect(event).toMatchObject({
      origin: 'observed',
      recordedAt: instant(now),
      providerAt: '2020-01-01T12:00:00Z',
    });
    expect(
      HistoryEventSchema.safeParse({
        ...observed,
        summary: { providerVersion: 'etag-one', source: 'direct' },
      }).success,
    ).toBe(false);
    expect(
      HistoryEventSchema.safeParse({
        ...observed,
        summary: { operationId: 'pretend', stepKey: 'x', providerVersion: 'etag-one' },
      }).success,
    ).toBe(false);
  });
  it('rejects movement events that only describe a sibling-order change', () => {
    const moved = {
      ...completed('move'),
      kind: 'task_moved',
      summary: {
        operationId: 'op',
        stepKey: 'move',
        from: { listId: 'list-a', parentId: null },
        to: { listId: 'list-a', parentId: null },
      },
    };
    expect(HistoryEventSchema.safeParse(moved).success).toBe(false);
  });
  it('rejects future recorded times instead of resetting them to now', () => {
    expect(() =>
      history.eventWrite(completed('future', { recordedAt: instant(now + day) })),
    ).toThrowError(AppError);
  });
});

describe('history persistence and retention', () => {
  it('deduplicates by account and source key while preserving the first event identity and time', async () => {
    const first = await history.record(
      completed('original', { recordedAt: instant(now - 10_000), dedupKey: 'same-step' }),
    );
    const duplicate = await history.record(
      completed('retry', {
        dedupKey: 'same-step',
        taskTitle: 'newer title must not rewrite the snapshot',
      }),
    );
    expect(duplicate).toEqual(first);
    await history.record(
      completed('another-account', { accountId: 'account-b', dedupKey: 'same-step' }),
    );
    expect((await history.query(accountId)).items).toHaveLength(1);
    expect((await history.query('account-b')).items).toHaveLength(1);
  });
  it('does not fabricate events when old task projections already exist', async () => {
    await seedOrganization();
    await db
      .prepare(
        'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,completed,completed_at) VALUES (?,?,?,?,?,1,?)',
      )
      .bind(
        'old-task',
        accountId,
        'list-a',
        'google-old',
        'old completed task',
        '2020-01-01T00:00:00Z',
      )
      .run();
    expect((await history.query(accountId)).items).toEqual([]);
  });
  it('excludes the exact ninety-day boundary before cleanup and never resets restored time', async () => {
    expect(
      await history.record(completed('expired', { recordedAt: instant(now - 90 * day) })),
    ).toBeNull();
    await history.record(completed('visible', { recordedAt: instant(now - 90 * day + 1) }));
    expect((await history.query(accountId)).items.map((event) => event.id)).toEqual(['visible']);
    now += 1;
    expect((await history.query(accountId)).items).toEqual([]);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM history_events').get()?.n).toBe(1);
  });
  it('cleans at most one hundred expired events and never prunes tasks', async () => {
    const writes = Array.from({ length: 105 }, (_, index) =>
      history.eventWrite(completed('old-' + index)),
    );
    await db.batch(writes);
    await seedOrganization();
    await db
      .prepare(
        'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES (?,?,?,?,?)',
      )
      .bind('keep', accountId, 'list-a', 'google-keep', 'keep me')
      .run();
    now += 90 * day + 1;
    await history.record(completed('recent'));
    expect((await history.query(accountId)).items.map((event) => event.id)).toEqual(['recent']);
    expect(await history.cleanup()).toBe(100);
    expect(await history.cleanup()).toBe(5);
    expect(await history.cleanup()).toBe(0);
    expect(
      database.sqlite.prepare('SELECT title FROM tasks_tasks WHERE id=?').get('keep')?.title,
    ).toBe('keep me');
  });
  it('participates in the caller transaction without leaving a success event after rollback', async () => {
    database.sqlite.exec(
      'CREATE TABLE mutation_fixture(id TEXT PRIMARY KEY); CREATE TABLE fail_fixture(valid INTEGER CHECK(valid=1))',
    );
    await expect(
      db.batch([
        db.prepare('INSERT INTO mutation_fixture(id) VALUES (?)').bind('change'),
        history.eventWrite(completed('would-have-been-success')),
        db.prepare('INSERT INTO fail_fixture(valid) VALUES (0)'),
      ]),
    ).rejects.toThrow();
    expect(database.sqlite.prepare('SELECT * FROM mutation_fixture').all()).toEqual([]);
    expect((await history.query(accountId)).items).toEqual([]);
  });
});

describe('history queries', () => {
  it('paginates newest first with stable event-id tie breaking and scoped cursors', async () => {
    await db.batch(
      Array.from({ length: 101 }, (_, index) =>
        history.eventWrite(completed('event-' + String(index).padStart(3, '0'))),
      ),
    );
    const first = await history.query(accountId);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.id).toBe('event-100');
    const second = await history.query(accountId, { cursor: first.nextCursor! });
    const third = await history.query(accountId, { cursor: second.nextCursor! });
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((event) => event.id)).size,
    ).toBe(101);
    expect(third.nextCursor).toBeNull();
    await expect(history.query('account-b', { cursor: first.nextCursor! })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(history.query(accountId, { limit: 101 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(history.query(accountId, { cursor: 'broken' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
  it('keeps account scope even when the trusted selection returns lists across accounts', async () => {
    const broad = new HistoryService(db, {
      now: () => now,
      boardListSelection: async () => ({ sql: 'SELECT list_id FROM history_events', bindings: [] }),
    });
    await history.record(completed('own'));
    await history.record(completed('foreign', { accountId: 'account-b' }));
    expect(
      (await broad.query(accountId, { boardId: 'scope' })).items.map((event) => event.id),
    ).toEqual(['own']);
  });
  it('follows current board membership while retaining historical list and task names', async () => {
    await seedOrganization();
    await history.record(completed('in-a'));
    await history.record(completed('in-b', { taskId: 'task-b', listId: 'list-b' }));
    expect(
      (await history.query(accountId, { boardId: 'main-a' })).items.map((event) => event.id),
    ).toEqual(['in-a']);
    await db
      .prepare('UPDATE boards_memberships SET board_id=? WHERE account_id=? AND list_id=?')
      .bind('other-a', accountId, 'list-a')
      .run();
    await db
      .prepare('UPDATE tasks_lists SET title=? WHERE account_id=? AND id=?')
      .bind('renamed list', accountId, 'list-a')
      .run();
    const moved = await history.query(accountId, { boardId: 'other-a', listId: 'list-a' });
    expect(moved.items.map((event) => event.id)).toEqual(['in-a']);
    expect(moved.items[0]?.listTitle).toBe('original list');
    expect((await history.query(accountId, { boardId: 'main-a' })).items).toEqual([]);
  });
  it('keeps stable task history across an in-app cross-list move', async () => {
    await history.record(completed('before', { taskId: 'stable-task', listId: 'old-list' }));
    await history.record({
      ...completed('after', { taskId: 'stable-task', listId: 'new-list' }),
      kind: 'task_moved',
      summary: {
        operationId: 'move-one',
        stepKey: 'move',
        from: { listId: 'old-list', parentId: null },
        to: { listId: 'new-list', parentId: null },
      },
    });
    expect((await history.query(accountId, { taskId: 'stable-task' })).items).toHaveLength(2);
    expect((await history.query(accountId, { listId: 'old-list' })).items).toHaveLength(1);
  });
  it('keeps deleted-list events accessible at account level after placement and list removal', async () => {
    await seedOrganization();
    await history.record({
      ...completed('deleted-list'),
      kind: 'list_deleted',
      taskId: null,
      summary: { operationId: 'delete-list', stepKey: 'delete', knownTaskCount: 0 },
    });
    await db.batch([
      db
        .prepare('DELETE FROM boards_memberships WHERE account_id=? AND list_id=?')
        .bind(accountId, 'list-a'),
      db.prepare('DELETE FROM tasks_lists WHERE account_id=? AND id=?').bind(accountId, 'list-a'),
    ]);
    expect((await history.query(accountId)).items.map((event) => event.kind)).toEqual([
      'list_deleted',
    ]);
    expect((await history.query(accountId, { boardId: 'main-a' })).items).toEqual([]);
  });
  it('reports query failures separately from an empty history', async () => {
    const broken = new HistoryService(db, {
      now: () => now,
      boardListSelection: async () => {
        throw new Error('private database diagnostics');
      },
    });
    await expect(broken.query(accountId, { boardId: 'main-a' })).rejects.toMatchObject({
      code: 'storage_unavailable',
      message: 'the board history selection could not be read',
    });
  });
  it('rejects SQL-like input fields rather than treating them as query structure', async () => {
    await expect(
      history.query(accountId, { sql: 'SELECT * FROM accounts_connections' } as never),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await history.query(accountId, { listId: "x' OR 1=1 --" })).items).toEqual([]);
  });
});
