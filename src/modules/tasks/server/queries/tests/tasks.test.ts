import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { invocationDatabase } from '../../../../../../tests/d1-invocation';
import { AppError } from '../../../../../shared/contracts/errors';
import { normalizeTaskSearchText } from '../../../model/task';
import { TaskDependantsPageSchema, TaskPageSchema } from '../../../contracts/query';
import { TaskQueries } from '../tasks';

const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const now = Date.parse('2026-11-02T12:00:00Z');
const context = { today: '2026-11-02', now };
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  await seedAccount(database.db, 'b', now);
  for (const [id, account, title] of [
    ['list-a', 'a', 'work'],
    ['list-z', 'a', 'ÉCRITURE'],
    ['list-b', 'b', 'private list'],
  ] as const) {
    await database.db
      .prepare(
        `INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,last_synced_at,tasks_complete_at,completed_complete_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(id, account, `google-${id}`, title, normalizeTaskSearchText(title), now, now, now)
      .run();
  }
  const queries = new TaskQueries(database.db, {
    boardListSelection: async (accountId, boardId) => {
      if (accountId !== 'a' || boardId !== 'board')
        throw new AppError('not_found', 'unknown board', 404);
      return { sql: 'SELECT value FROM json_each(?)', bindings: [JSON.stringify(['list-z'])] };
    },
  });
  async function task(
    id: string,
    fields: {
      account?: string;
      list?: string;
      title?: string;
      notes?: string;
      parent?: string;
      completed?: boolean;
      day?: string;
      time?: string;
      zone?: string;
      priority?: string;
      starred?: boolean;
      position?: string;
      updated?: string;
      revision?: number;
      unsupported?: boolean;
    } = {},
  ) {
    const title = fields.title ?? id,
      notes = fields.notes ?? '';
    await database.db
      .prepare(
        `INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,provider_position,title,title_key,notes,search_text,completed,scheduled_day,scheduled_time,time_zone,priority,starred,provider_updated_at,revision,unsupported_hierarchy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id,
        fields.account ?? 'a',
        fields.list ?? 'list-a',
        fields.parent ?? null,
        `google-${id}`,
        fields.position ?? id,
        title,
        normalizeTaskSearchText(title),
        notes,
        normalizeTaskSearchText(`${title}\n${notes}`),
        fields.completed ? 1 : 0,
        fields.day ?? null,
        fields.time ?? null,
        fields.zone ?? null,
        fields.priority ?? 'none',
        fields.starred ? 1 : 0,
        fields.updated ?? null,
        fields.revision ?? 1,
        fields.unsupported ? 1 : 0,
      )
      .run();
  }
  async function label(id: string, name: string, account = 'a') {
    await database.db
      .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES (?,?,?,?,?)')
      .bind(id, account, name, normalizeTaskSearchText(name.trim()), '#123456')
      .run();
  }
  async function tag(taskId: string, labelId: string, account = 'a') {
    await database.db
      .prepare('INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES (?,?,?)')
      .bind(account, taskId, labelId)
      .run();
  }
  return { ...database, queries, task, label, tag };
}

async function matching(queries: TaskQueries, input = {}) {
  return (await queries.listTasks('a', input, context)).matchedTaskIds;
}

describe('reverse dependency reads', () => {
  it('pages saved dependants across lists with parent context and completion state', async () => {
    const { queries, task, db } = await fixture();
    await task('blocker');
    await task('parent', { list: 'list-z' });
    await task('a-child', { parent: 'parent', list: 'list-z' });
    await task('b-completed', { completed: true });
    await task('c-last');
    for (const id of ['a-child', 'b-completed', 'c-last'])
      await db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
        .bind('a', id, 'blocker')
        .run();
    const first = await queries.readDependants('a', 'blocker', { limit: 2 });
    expect(TaskDependantsPageSchema.safeParse(first).success).toBe(true);
    expect(first.items).toMatchObject([
      {
        id: 'a-child',
        listId: 'list-z',
        parentId: 'parent',
        parentTitle: 'parent',
        listTitle: 'ÉCRITURE',
      },
      { id: 'b-completed', completed: true },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const next = await queries.readDependants('a', 'blocker', {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((item) => item.id)).toEqual(['c-last']);
    expect(next.nextCursor).toBeNull();
  });
  it('keeps unresolved references but excludes retired edges and confirmed deleted tasks/lists', async () => {
    const { queries, task, db } = await fixture();
    await task('blocker');
    for (const id of ['a-missing', 'b-deleted', 'c-unlinked', 'd-list-deleted']) {
      await task(id, id === 'd-list-deleted' ? { list: 'list-z' } : {});
      await db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
        .bind('a', id, 'blocker')
        .run();
    }
    await db
      .prepare('UPDATE tasks_tasks SET provider_missing_at=? WHERE id=?')
      .bind(now, 'a-missing')
      .run();
    await db.prepare('UPDATE tasks_tasks SET deleted_at=? WHERE id=?').bind(now, 'b-deleted').run();
    await db
      .prepare('DELETE FROM tasks_dependencies WHERE account_id=? AND task_id=?')
      .bind('a', 'c-unlinked')
      .run();
    await db.prepare('UPDATE tasks_lists SET deleted_at=? WHERE id=?').bind(now, 'list-z').run();
    expect((await queries.readDependants('a', 'blocker')).items).toMatchObject([
      { id: 'a-missing', providerMissing: true },
    ]);
  });
  it('binds cursors to account, blocker identity and the serialized dependency graph', async () => {
    const { queries, task, db } = await fixture();
    await task('blocker');
    await task('other');
    await task('private', { account: 'b', list: 'list-b' });
    for (const id of ['a', 'b']) {
      await task(id);
      await db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
        .bind('a', id, 'blocker')
        .run();
    }
    const page = await queries.readDependants('a', 'blocker', { limit: 1 });
    await expect(
      queries.readDependants('a', 'other', { cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      queries.readDependants('b', 'private', { cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(queries.readDependants('a', 'private')).rejects.toMatchObject({
      code: 'not_found',
    });
    await db
      .prepare('UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id=?')
      .bind('a')
      .run();
    await expect(
      queries.readDependants('a', 'blocker', { cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('bounds summary pages by encoded bytes and excludes note bodies', async () => {
    const { queries, task, db } = await fixture();
    await task('blocker');
    for (let i = 0; i < 100; i++) {
      const id = `item-${String(i).padStart(3, '0')}`;
      await task(id, { title: '🪴'.repeat(1024), notes: 'private note '.repeat(500) });
      await db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
        .bind('a', id, 'blocker')
        .run();
    }
    const budget = invocationDatabase(db, 3);
    const first = await new TaskQueries(budget.db).readDependants('a', 'blocker', { limit: 100 });
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(100);
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(JSON.stringify(first)).not.toContain('private note');
    expect(budget.queries).toBeLessThanOrEqual(3);
  });
});

describe('task projection reads', () => {
  it('returns validated public tasks with provider list addresses and metadata', async () => {
    const { queries, task, label, tag, db } = await fixture();
    await task('one', {
      notes: 'a plain\nnote',
      day: '2026-11-02',
      time: '09:00',
      zone: 'Europe/Istanbul',
      starred: true,
    });
    await task('blocker');
    await label('reading', 'Reading');
    await tag('one', 'reading');
    await db
      .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES (?,?,?)')
      .bind('a', 'one', 'blocker')
      .run();
    const one = await queries.getTask('a', 'one');
    expect(one).toMatchObject({
      id: 'one',
      accountId: 'a',
      notes: 'a plain\nnote',
      scheduledTime: '09:00',
      starred: true,
      labelIds: ['reading'],
      blockedBy: ['blocker'],
      provider: { id: 'google-one', listId: 'google-list-a' },
      capabilities: { canEdit: true, canMove: true },
    });
    expect(TaskPageSchema.safeParse(await queries.listTasks('a', {}, context)).success).toBe(true);
  });
  it('keeps get/ids/list/label reads inside the explicit account and excludes retired resources', async () => {
    const { queries, task, label, db } = await fixture();
    await task('one');
    await task('private', { account: 'b', list: 'list-b' });
    await label('private-label', 'private label', 'b');
    await expect(queries.getTask('a', 'private')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    expect(
      (await queries.getTasksByIds('a', ['private', 'one', 'missing'])).map((item) => item.id),
    ).toEqual(['one']);
    expect((await queries.readLabels('a')).items).toEqual([]);
    await db.prepare('UPDATE tasks_tasks SET deleted_at=? WHERE id=?').bind(now, 'one').run();
    await expect(queries.getTask('a', 'one')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('uses only injected board membership and rejects unknown list references', async () => {
    const { queries, task } = await fixture();
    await task('one');
    await task('two', { list: 'list-z' });
    expect(await matching(queries, { boardId: 'board' })).toEqual(['two']);
    expect(await matching(queries, { listIds: [] })).toEqual([]);
    await expect(queries.listTasks('a', { listIds: ['list-b'] }, context)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('server-owned search and filters', () => {
  it('filters before pagination instead of searching only the first local page', async () => {
    const { queries, task } = await fixture();
    for (let i = 0; i < 8; i++)
      await task(`item-${i}`, { title: i === 7 ? 'the matching task' : 'ordinary' });
    expect(await matching(queries, { query: 'matching', limit: 2 })).toEqual(['item-7']);
  });
  it('matches unicode title, notes, list, label, and parent title with the model normalizer', async () => {
    const { queries, task, label, tag } = await fixture();
    await task('title', { title: 'CAFÉ' });
    await task('notes', { notes: 'NAÏVE notes' });
    await task('list', { list: 'list-z' });
    await label('label', 'ÖĞRENME');
    await task('labelled');
    await tag('labelled', 'label');
    await task('parent', { title: 'İSTANBUL' });
    await task('child', { title: 'a child', parent: 'parent' });
    expect(await matching(queries, { query: 'cafe\u0301' })).toEqual(['title']);
    expect(await matching(queries, { query: 'naïve' })).toEqual(['notes']);
    expect(await matching(queries, { query: 'e\u0301criture' })).toEqual(['list']);
    expect(await matching(queries, { query: 'öğrenme' })).toEqual(['labelled']);
    expect(await matching(queries, { query: 'i\u0307stanbul' })).toEqual(['parent', 'child']);
  });
  it('treats punctuation and SQL-looking text as literal search text', async () => {
    const { queries, task } = await fixture();
    await task('literal', { title: "100% _ ' OR 1=1 --" });
    await task('ordinary');
    expect(await matching(queries, { query: "' OR 1=1 --" })).toEqual(['literal']);
    expect(await matching(queries, { query: '_' })).toEqual(['literal']);
  });
  it('combines filter types with AND and values within one type with OR', async () => {
    const { queries, task, label, tag } = await fixture();
    await label('a-label', 'one');
    await label('z-label', 'two');
    await task('high', { priority: 'high', starred: true, day: '2026-11-02' });
    await tag('high', 'a-label');
    await task('medium', { priority: 'medium', starred: true, day: '2026-11-02' });
    await tag('medium', 'z-label');
    await task('low', { priority: 'low', starred: true, day: '2026-11-02' });
    await tag('low', 'a-label');
    await task('unstarred', { priority: 'high', day: '2026-11-02' });
    await tag('unstarred', 'a-label');
    expect(
      await matching(queries, {
        filter: {
          labelIds: ['a-label', 'z-label'],
          priorities: ['high', 'medium'],
          starred: true,
          scheduled: { kind: 'today' },
        },
      }),
    ).toEqual(['high', 'medium']);
  });
  it('supports explicit label match-all, completion, no-date, overdue and inclusive ranges', async () => {
    const { queries, task, label, tag } = await fixture();
    await label('a-label', 'one');
    await label('z-label', 'two');
    await task('both', { day: '2026-11-01' });
    await tag('both', 'a-label');
    await tag('both', 'z-label');
    await task('single');
    await tag('single', 'a-label');
    await task('completed', { completed: true, day: '2026-11-01' });
    await task('today', { day: '2026-11-02' });
    await task('later', { day: '2026-11-03' });
    expect(
      await matching(queries, { filter: { labelIds: ['a-label', 'z-label'], labelMatch: 'all' } }),
    ).toEqual(['both']);
    expect(
      await matching(queries, { filter: { scheduled: { kind: 'overdue' }, completion: 'all' } }),
    ).toEqual(['both']);
    expect(await matching(queries, { filter: { scheduled: { kind: 'none' } } })).toEqual([
      'single',
    ]);
    expect(
      await matching(queries, {
        filter: { scheduled: { kind: 'range', from: '2026-11-02', to: '2026-11-03' } },
      }),
    ).toEqual(['later', 'today']);
    expect(await matching(queries, { filter: { completion: 'completed' } })).toEqual(['completed']);
  });
  it('distinguishes an open blocker, a completed blocker, and an unresolved blocker', async () => {
    const { queries, task, db, sqlite } = await fixture();
    await task('open');
    await task('done', { completed: true });
    await task('blocked');
    await task('clear');
    await task('unknown');
    await task('deleted');
    for (const [id, blocker] of [
      ['blocked', 'open'],
      ['clear', 'done'],
      ['deleted', 'done'],
    ])
      await db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES (?,?,?)')
        .bind('a', id, blocker)
        .run();
    sqlite.exec('PRAGMA foreign_keys=OFF');
    await db
      .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES (?,?,?)')
      .bind('a', 'unknown', 'unloaded')
      .run();
    sqlite.exec('PRAGMA foreign_keys=ON');
    expect(await matching(queries, { filter: { dependencyStates: ['blocked'] } })).toEqual([
      'blocked',
    ]);
    expect(await matching(queries, { filter: { dependencyStates: ['unknown'] } })).toEqual([
      'unknown',
    ]);
    expect((await queries.getTask('a', 'unknown')).blockedBy).toEqual(['unloaded']);
    await db.prepare('UPDATE tasks_tasks SET deleted_at=? WHERE id=?').bind(now, 'done').run();
    expect((await queries.getTask('a', 'deleted')).blockedBy).toEqual([]);
    expect(await matching(queries, { filter: { dependencyStates: ['unblocked'] } })).toContain(
      'deleted',
    );
  });
  it('does not trust stale completion for a retained provider-missing blocker', async () => {
    const { queries, task, db } = await fixture();
    await task('done', { completed: true });
    await task('waiting');
    await db
      .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES (?,?,?)')
      .bind('a', 'waiting', 'done')
      .run();
    await db
      .prepare('UPDATE tasks_tasks SET provider_missing_at=? WHERE id=?')
      .bind(now, 'done')
      .run();
    expect(await matching(queries, { filter: { dependencyStates: ['unknown'] } })).toEqual([
      'waiting',
    ]);
    expect((await queries.getTask('a', 'done')).provider.missing).toBe(true);
    await db.prepare('UPDATE tasks_tasks SET completed=0 WHERE id=?').bind('done').run();
    expect(await matching(queries, { filter: { dependencyStates: ['blocked'] } })).toEqual([]);
  });
});

describe('bounded task pagination and context', () => {
  it('counts parent context toward the page limit and resumes matching children', async () => {
    const { queries, task } = await fixture();
    await task('parent', { completed: true });
    for (const id of ['child-a', 'child-b', 'child-c']) await task(id, { parent: 'parent' });
    const first = await queries.listTasks('a', { parentId: 'parent', limit: 2 }, context);
    expect(first.items).toHaveLength(2);
    expect(first.matchedTaskIds).toEqual(['child-a']);
    expect(first.contextTaskIds).toEqual(['parent']);
    const second = await queries.listTasks(
      'a',
      { parentId: 'parent', limit: 2, cursor: first.nextCursor! },
      context,
    );
    expect(second.items).toHaveLength(2);
    expect(second.matchedTaskIds).toEqual(['child-b']);
    expect(second.subtaskSummaries.parent).toEqual({ open: 3, total: 3, complete: true });
  });
  it('returns full child summaries even when later children are outside the current page', async () => {
    const { queries, task, db } = await fixture();
    await task('parent', { position: '1' });
    await task('child-open', { parent: 'parent' });
    await task('child-done', { parent: 'parent', completed: true });
    const page = await queries.listTasks('a', { parentId: null, limit: 2 }, context);
    expect(page.items.map((item) => item.id)).toEqual(['parent']);
    expect(page.subtaskSummaries.parent).toEqual({ open: 1, total: 2, complete: true });
    await db
      .prepare('UPDATE tasks_lists SET completed_complete_at=NULL WHERE id=?')
      .bind('list-a')
      .run();
    expect(
      (await queries.listTasks('a', { parentId: null }, context)).subtaskSummaries.parent?.complete,
    ).toBe(false);
  });
  it('keeps stable manual parent groups and keyset pagination across equal sort values', async () => {
    const { queries, task } = await fixture();
    await task('p-b', { title: 'same', position: '2' });
    await task('p-a', { title: 'same', position: '1' });
    await task('child', { title: 'same', parent: 'p-a', position: '9' });
    const all = await matching(queries, { filter: { completion: 'all' } });
    expect(all).toEqual(['p-a', 'child', 'p-b']);
    const first = await queries.listTasks('a', { sort: 'title', limit: 2 }, context);
    const second = await queries.listTasks(
      'a',
      { sort: 'title', limit: 2, cursor: first.nextCursor! },
      context,
    );
    expect([...first.matchedTaskIds, ...second.matchedTaskIds]).toEqual(['p-a', 'child', 'p-b']);
  });
  it('binds cursors to account, list selection, search, filter and sort', async () => {
    const { queries, task } = await fixture();
    for (const id of ['a', 'b', 'c']) await task(id);
    const first = await queries.listTasks('a', { limit: 2 }, context);
    for (const changed of [
      { query: 'a' },
      { listIds: ['list-a'] },
      { filter: { starred: true } },
      { sort: 'title' as const },
    ])
      await expect(
        queries.listTasks('a', { ...changed, cursor: first.nextCursor! }, context),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      queries.listTasks('b', { cursor: first.nextCursor! }, context),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('does not confuse a parent named all with the absence of a parent filter', async () => {
    const { queries, task } = await fixture();
    await task('all', { completed: true });
    for (const id of ['child-a', 'child-b']) await task(id, { parent: 'all' });
    const first = await queries.listTasks('a', { limit: 2 }, context);
    await expect(
      queries.listTasks('a', { parentId: 'all', limit: 2, cursor: first.nextCursor! }, context),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('rejects a changed or removed anchor instead of continuing from a different sort position', async () => {
    const { queries, task, db } = await fixture();
    for (const id of ['a', 'b', 'c']) await task(id);
    const first = await queries.listTasks('a', { limit: 2 }, context);
    await db.prepare('UPDATE tasks_tasks SET revision=revision+1 WHERE id=?').bind('b').run();
    await expect(
      queries.listTasks('a', { limit: 2, cursor: first.nextCursor! }, context),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects an anchor whose parent disappeared even when their revision numbers are equal', async () => {
    const { queries, task, db } = await fixture();
    await task('parent', { completed: true });
    await task('child-a', { parent: 'parent' });
    await task('child-b', { parent: 'parent' });
    const first = await queries.listTasks('a', { limit: 2 }, context);
    await db.prepare('UPDATE tasks_tasks SET deleted_at=? WHERE id=?').bind(now, 'parent').run();
    await expect(
      queries.listTasks('a', { limit: 2, cursor: first.nextCursor! }, context),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('reduces large-note pages without truncating a field or losing the next match', async () => {
    const { queries, task } = await fixture();
    const notes = '🙂'.repeat(8_192);
    for (let i = 0; i < 12; i++) await task(`item-${String(i).padStart(2, '0')}`, { notes });
    const page = await queries.listTasks('a', { limit: 100 }, context);
    expect(page.items.length).toBeLessThan(12);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.notes).toBe(notes);
    expect(page.nextCursor).not.toBeNull();
    const next = await queries.listTasks('a', { limit: 100, cursor: page.nextCursor! }, context);
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
  });
  it('keeps a large parent/child context unit together and rejects an oversized explicit id batch', async () => {
    const { queries, task } = await fixture();
    const notes = '🙂'.repeat(8_192);
    await task('parent', { completed: true, notes });
    await task('child', { parent: 'parent', notes });
    const page = await queries.listTasks('a', { parentId: 'parent', limit: 2 }, context);
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.notes === notes)).toBe(true);
    await expect(queries.getTasksByIds('a', ['parent', 'child'])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await queries.getTask('a', 'child')).notes).toBe(notes);
  });
  it('uses a bounded number of SQL bindings even with a hundred explicitly selected lists', async () => {
    const { queries, task, db, sqlite } = await fixture();
    const insert = sqlite.prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key) VALUES (?,'a',?,?,?)",
    );
    const ids: string[] = [];
    for (let index = 0; index < 100; index++) {
      const id = `selection-${index}`;
      ids.push(id);
      insert.run(id, `google-${id}`, id, id);
    }
    await task('selected', { list: 'selection-0' });
    const prepare = db.prepare.bind(db);
    let maximum = 0;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        maximum = Math.max(maximum, values.length);
        return bind(...values);
      };
      return statement;
    };
    expect(await matching(queries, { listIds: ids })).toEqual(['selected']);
    expect(maximum).toBeLessThanOrEqual(100);
  });
  it('discloses provider partial/stale coverage separately from a loaded page subset', async () => {
    const { queries, task, db } = await fixture();
    for (const id of ['a', 'b', 'c']) await task(id);
    const page = await queries.listTasks('a', { limit: 2 }, context);
    expect(page.providerCoverage.complete).toBe(true);
    expect(page.coverage.complete).toBe(false);
    await db
      .prepare('UPDATE tasks_lists SET tasks_complete_at=NULL WHERE id=?')
      .bind('list-z')
      .run();
    const partial = await queries.listTasks('a', {}, context);
    expect(partial.providerCoverage.complete).toBe(false);
    const stale = await queries.listTasks(
      'a',
      { listIds: ['list-a'] },
      { ...context, now: now + 60_000 },
    );
    expect(stale.providerCoverage.stale).toBe(true);
  });
  it('validates page/input bounds and malformed cursors without leaking storage diagnostics', async () => {
    const { queries } = await fixture();
    for (const input of [{ limit: 1 }, { limit: 101 }, { cursor: 'not a cursor' }])
      await expect(queries.listTasks('a', input, context)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    await expect(
      queries.getTasksByIds(
        'a',
        Array.from({ length: 101 }, (_, i) => String(i)),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('query sorts and labels', () => {
  it('sorts scheduled day/time, priority and provider update instants with stable ties', async () => {
    const { queries, task } = await fixture();
    await task('a', {
      day: '2026-11-03',
      time: '08:00',
      zone: 'UTC',
      priority: 'low',
      updated: '2026-11-02T10:00:00+03:00',
    });
    await task('b', {
      day: '2026-11-02',
      time: '15:00',
      zone: 'UTC',
      priority: 'high',
      updated: '2026-11-02T08:00:00Z',
    });
    await task('c', { day: '2026-11-02', priority: 'medium' });
    expect(await matching(queries, { sort: 'scheduled' })).toEqual(['c', 'b', 'a']);
    expect(await matching(queries, { sort: 'priority' })).toEqual(['b', 'c', 'a']);
    expect(await matching(queries, { sort: 'updated' })).toEqual(['b', 'a', 'c']);
  });
  it('paginates account-owned labels and rejects a cursor from another query', async () => {
    const { queries, label } = await fixture();
    for (const name of ['Zebra', 'École', 'Apple']) await label(name, name);
    const first = await queries.readLabels('a', { limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(['Apple', 'Zebra']);
    const second = await queries.readLabels('a', { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.name)).toEqual(['École']);
    expect(
      (await queries.readLabels('a', { query: 'e\u0301cole' })).items.map((item) => item.name),
    ).toEqual(['École']);
    await expect(queries.readLabels('b', { cursor: first.nextCursor! })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
