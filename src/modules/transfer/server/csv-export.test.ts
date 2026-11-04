import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { AppError } from '../../../shared/contracts/errors';
import { normalizeTaskSearchText } from '../../tasks/model';
import { TaskQueries } from '../../tasks/server/queries/tasks';
import { readActiveLists } from '../../tasks/server/queries/lists';
import { parseImportFile } from '../parser';
import { TaskCsvExportService } from './csv-export';

const now = Date.parse('2026-11-02T12:00:00Z');
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
      .bind(
        'list-' + account,
        account,
        'google-list-' + account,
        account === 'a' ? '=work' : 'private',
        'work',
        now,
        now,
        now,
      )
      .run();
  }
  const queries = new TaskQueries(database.db, {
    boardListSelection: async (account, board) => {
      if (account !== 'a' || board !== 'board-a')
        throw new AppError('not_found', 'board not found', 404);
      return { sql: 'SELECT value FROM json_each(?)', bindings: ['["list-a"]'] };
    },
  });
  const service = new TaskCsvExportService({
    queries,
    readLists: (account, ids) => readActiveLists(database.db, account, ids),
    now: () => now,
  });
  async function task(
    id: string,
    options: {
      title?: string;
      parent?: string;
      completed?: boolean;
      notes?: string;
      position?: string;
      account?: string;
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
        normalizeTaskSearchText(title),
        options.position ?? id,
        options.completed ? 1 : 0,
      )
      .run();
  }
  return { ...database, queries, service, task };
}
const request = {
  exportId: 'export-0123456789abcdef',
  scope: { listIds: ['list-a'] },
  includeCompleted: true,
  today: '2026-11-02',
  limit: 1,
};

describe('progressive csv export', () => {
  it('exports each parent and child once across pages with structured metadata and internal dependency references', async () => {
    const { service, task, db } = await fixture();
    await task('root', {
      title: '=formula',
      completed: true,
      notes: 'notes, with\n"quotes"',
      position: '1',
    });
    await task('child', { parent: 'root', position: '1' });
    await task('later', { position: '2' });
    await db
      .prepare(
        "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES ('label','a','reading','reading','#abcdef')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES ('a','root','label')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES ('a','child','later')",
      )
      .run();
    await db
      .prepare(
        "UPDATE tasks_tasks SET priority='high',starred=1,scheduled_day='2026-11-02',scheduled_time='09:30',time_zone='Europe/Istanbul' WHERE id='root'",
      )
      .run();
    let cursor: string | undefined,
      csv = '',
      pages = 0;
    do {
      const page = await service.page('a', request, cursor);
      csv += page.chunk;
      pages++;
      cursor = page.nextCursor ?? undefined;
      expect(page.generatedAt).toBe(new Date(now).toISOString());
      expect(page.freshness).toEqual({
        source: 'retained_projection',
        complete: true,
        stale: false,
        lastSyncedAt: new Date(now).toISOString(),
      });
      expect(page.formulaEscapeExplanation).toContain('apostrophe');
      expect(page.consistencyExplanation).toContain('mixed-time');
      expect(page.counts.tasks).toBe(1);
    } while (cursor);
    expect(pages).toBe(3);
    expect(csv.match(/source_key,parent_key/g)).toHaveLength(1);
    expect(csv).not.toMatch(/google-|list-a|label,/);
    const preview = await parseImportFile({
      name: 'tasks.csv',
      bytes: new TextEncoder().encode(csv),
    });
    expect(preview.tasks.map((task) => task.title)).toEqual(['=formula', 'child', 'later']);
    expect(preview.tasks[0]).toMatchObject({
      notes: 'notes, with\n"quotes"',
      completed: true,
      priority: 'high',
      starred: true,
      labels: ['reading'],
      scheduledDay: '2026-11-02',
      scheduledTime: '09:30',
      timeZone: 'Europe/Istanbul',
    });
    expect(preview.tasks[1]).toMatchObject({ parentKey: 't1', dependencies: ['t3'] });
  });

  it('includes completed parent context once when completed matches are excluded', async () => {
    const { service, task } = await fixture();
    await task('root', { completed: true });
    for (const id of ['a-child', 'b-child', 'c-child']) await task(id, { parent: 'root' });
    let cursor: string | undefined,
      csv = '',
      context = 0;
    do {
      const page = await service.page('a', { ...request, includeCompleted: false }, cursor);
      csv += page.chunk;
      context += page.counts.parentContext;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const preview = await parseImportFile({
      name: 'tasks.csv',
      bytes: new TextEncoder().encode(csv),
    });
    expect(preview.tasks).toHaveLength(4);
    expect(context).toBe(1);
  });

  it('omits external dependencies with a visible count and never grants a reference merely by hashing it', async () => {
    const { service, task, db } = await fixture();
    await task('selected', { title: 'needle' });
    await task('outside');
    await db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES ('a','selected','outside')",
      )
      .run();
    const page = await service.page('a', { ...request, scope: { query: 'needle' } });
    expect(page.counts.omittedDependencies).toBe(1);
    const preview = await parseImportFile({
      name: 'tasks.csv',
      bytes: new TextEncoder().encode(page.chunk),
    });
    expect(preview.tasks[0]?.dependencies).toEqual([]);
    expect(page.chunk).not.toContain('outside');
  });

  it('preserves board and account search scopes and treats source changes as mixed-time projection data', async () => {
    const { service, task, db } = await fixture();
    await task('selected', { title: 'needle' });
    await task('outside');
    await task('private', { account: 'b', title: 'needle' });
    const page = await service.page('a', {
      ...request,
      scope: { boardId: 'board-a', query: 'needle' },
    });
    expect(page.chunk).toContain('needle');
    expect(page.chunk).not.toContain('outside');
    expect(page.chunk).not.toContain('private');
    await db
      .prepare(
        "UPDATE tasks_lists SET last_synced_at=?,completed_complete_at=NULL WHERE id='list-a'",
      )
      .bind(now - 120000)
      .run();
    expect((await service.page('a', request)).freshness).toMatchObject({
      stale: true,
      complete: false,
    });
  });

  it('binds every cursor to export identity, account, today, and the complete selection', async () => {
    const { service, task } = await fixture();
    await task('first');
    await task('second');
    const first = await service.page('a', request);
    expect(first.nextCursor).toBeTruthy();
    for (const extra of [
      { exportId: 'different-0123456789' },
      { includeCompleted: false },
      { today: '2026-11-03' },
      { scope: { listIds: ['list-a'], query: 'changed' } },
    ])
      await expect(
        service.page('a', { ...request, ...extra }, first.nextCursor!),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(service.page('b', request, first.nextCursor!)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(service.page('a', request, 'not-a-cursor')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await service.page('a', request, first.nextCursor!)).chunk).toBe(
      (await service.page('a', request, first.nextCursor!)).chunk,
    );
  });

  it('uses a different export-local reference namespace for each explicit export', async () => {
    const { service, task } = await fixture();
    await task('source-task-id');
    const first = await service.page('a', request),
      second = await service.page('a', { ...request, exportId: 'second-0123456789abcdef' });
    expect(first.chunk.split('\r\n')[1]?.split(',')[0]).not.toBe(
      second.chunk.split('\r\n')[1]?.split(',')[0],
    );
    expect(first.chunk.split('\r\n')[1]?.split(',')[0]).toMatch(/^t[0-9a-f]{64}$/);
  });

  it('requires an explicit include-completed choice and returns a valid header for an empty scope', async () => {
    const { service } = await fixture();
    const { includeCompleted: _, ...missingChoice } = request;
    await expect(service.page('a', missingChoice as never)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const empty = await service.page('a', request);
    expect(empty.nextCursor).toBe(null);
    expect(empty.chunk).toMatch(/^source_key,parent_key/);
    expect(empty.counts.tasks).toBe(0);
  });

  it('pages large notes without loading a whole export into one response', async () => {
    const { service, task } = await fixture();
    for (let index = 0; index < 12; index++)
      await task('large-' + index, { notes: '😀'.repeat(8192) });
    const page = await service.page('a', { ...request, limit: 10 });
    expect(new TextEncoder().encode(page.chunk).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(page.nextCursor).toBeTruthy();
    expect(page.counts.tasks).toBeLessThan(12);
    expect(page.chunk).toContain('😀'.repeat(8192));
  });
});
