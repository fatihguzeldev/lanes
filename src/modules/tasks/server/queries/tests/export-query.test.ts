import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { AppError } from '../../../../../shared/contracts/errors';
import { normalizeTaskSearchText } from '../../../model/task';
import { TaskQueries } from '../tasks';

const now = Date.parse('2026-11-02T12:00:00Z');
const context = { today: '2026-11-02', now };
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  for (const account of ['a', 'b']) {
    await seedAccount(database.db, account, now);
    await database.db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,last_synced_at,tasks_complete_at,completed_complete_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .bind('list-' + account, account, 'google-list-' + account, 'work', 'work', now, now, now)
      .run();
  }
  const queries = new TaskQueries(database.db, {
    boardListSelection: async (accountId, boardId) => {
      if (accountId !== 'a' || boardId !== 'board-a')
        throw new AppError('not_found', 'board not found', 404);
      return { sql: 'SELECT value FROM json_each(?)', bindings: ['["list-a"]'] };
    },
  });
  async function task(
    id: string,
    options: {
      account?: string;
      parent?: string;
      title?: string;
      notes?: string;
      position?: string;
      completed?: boolean;
    } = {},
  ) {
    const account = options.account ?? 'a',
      title = options.title ?? id;
    await database.db
      .prepare(
        'INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,title_key,notes,search_text,provider_position,completed,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)',
      )
      .bind(
        id,
        account,
        'list-' + account,
        options.parent ?? null,
        'google-' + id,
        title,
        normalizeTaskSearchText(title),
        options.notes ?? '',
        normalizeTaskSearchText(title + '\n' + (options.notes ?? '')),
        options.position ?? id,
        options.completed ? 1 : 0,
      )
      .run();
  }
  async function label(id: string, name: string, account = 'a') {
    await database.db
      .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES (?,?,?,?,?)')
      .bind(id, account, name, normalizeTaskSearchText(name.trim()), '#abcdef')
      .run();
  }
  return { ...database, queries, task, label };
}

describe('task-owned export selection', () => {
  it('emits parent context once across pages, before every selected child, without exporting unrelated tasks', async () => {
    const { queries, task } = await fixture();
    await task('root', { completed: true, position: '1' });
    for (const id of ['a-child', 'b-child', 'c-child']) await task(id, { parent: 'root' });
    await task('unrelated', { completed: true });
    const seen: string[] = [],
      contextIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await queries.exportPage(
        'a',
        { listIds: ['list-a'], limit: 1, ...(cursor ? { cursor } : {}) },
        context,
      );
      seen.push(...page.items.map((task) => task.id));
      contextIds.push(...page.contextTaskIds);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['root', 'a-child', 'b-child', 'c-child']);
    expect(contextIds).toEqual(['root']);
  });

  it('uses board/search/common filters before paging and includes only matching children plus parent context', async () => {
    const { queries, task } = await fixture();
    await task('root', { completed: true });
    await task('match', { parent: 'root', title: 'needle' });
    await task('other', { parent: 'root' });
    await task('private', { account: 'b', title: 'needle' });
    const page = await queries.exportPage('a', { boardId: 'board-a', query: 'needle' }, context);
    expect(page.items.map((task) => task.id)).toEqual(['root', 'match']);
    expect(page.matchedTaskIds).toEqual(['match']);
    expect(page.contextTaskIds).toEqual(['root']);
    expect(page.providerCoverage).toEqual({
      complete: true,
      lastSyncedAt: new Date(now).toISOString(),
      stale: false,
    });
    await expect(queries.exportPage('a', { listIds: ['list-b'] }, context)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(queries.exportPage('a', { boardId: 'unknown' }, context)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('makes inclusion of completed tasks explicit and retains stable manual hierarchy order', async () => {
    const { queries, task } = await fixture();
    await task('z-root', { position: '1' });
    await task('a-root', { position: '2' });
    await task('z-child', { parent: 'z-root', position: '1', completed: true });
    expect(
      (await queries.exportPage('a', { filter: { completion: 'all' } }, context)).items.map(
        (task) => task.id,
      ),
    ).toEqual(['z-root', 'z-child', 'a-root']);
    await expect(
      queries.exportPage('a', { sort: 'title' } as never, context),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('binds cursors to account, selection, and anchor revision', async () => {
    const { queries, task, db } = await fixture();
    await task('first');
    await task('second');
    const first = await queries.exportPage('a', { limit: 1 }, context);
    expect(first.nextCursor).toBeTruthy();
    for (const account of ['a', 'b'])
      await expect(
        queries.exportPage(
          account,
          { limit: 1, cursor: first.nextCursor!, query: 'different' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await db.prepare("UPDATE tasks_tasks SET revision=revision+1 WHERE id='first'").run();
    await expect(
      queries.exportPage('a', { limit: 1, cursor: first.nextCursor! }, context),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('bounds output to ten tasks and64KiB without silently truncating large notes', async () => {
    const { queries, task } = await fixture();
    for (let index = 0; index < 12; index++)
      await task('large-' + index.toString().padStart(2, '0'), { notes: '😀'.repeat(8192) });
    const page = await queries.exportPage('a', {}, context);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(10);
    expect(new TextEncoder().encode(JSON.stringify(page.items)).byteLength).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(page.items[0]?.notes).toBe('😀'.repeat(8192));
    expect(page.nextCursor).toBeTruthy();
    await expect(queries.exportPage('a', { limit: 11 }, context)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('checks reference membership against the whole selected set, including context parents, in a bounded account scope', async () => {
    const { queries, task } = await fixture();
    await task('root', { completed: true });
    await task('match', { parent: 'root', title: 'needle' });
    await task('outside');
    await task('private', { account: 'b' });
    expect(
      await queries.exportMembership(
        'a',
        { query: 'needle' },
        ['root', 'match', 'outside', 'private', 'missing'],
        context,
      ),
    ).toEqual(['root', 'match']);
    await expect(
      queries.exportMembership(
        'a',
        {},
        Array.from({ length: 101 }, (_, index) => String(index)),
        context,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('looks up only selected label identities or normalized names without reading unrelated labels', async () => {
    const { queries, label, db } = await fixture();
    await label('alpha', 'Écriture');
    await label('beta', 'Reading');
    await label('private', 'private', 'b');
    expect(
      (await queries.readLabelsByIds('a', ['beta', 'private', 'missing'])).map(
        (label) => label.name,
      ),
    ).toEqual(['Reading']);
    expect(
      (await queries.readLabelsByNames('a', ['  e\u0301criture ', 'reading']))
        .map((label) => label.id)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    await expect(queries.readLabelsByNames('a', ['Reading', 'READING'])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      queries.readLabelsByIds(
        'a',
        Array.from({ length: 101 }, (_, index) => String(index)),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_labels').first('n')).toBe(3);
  });
});
