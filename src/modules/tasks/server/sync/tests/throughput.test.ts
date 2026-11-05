import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invocationDatabase } from '../../../../../../tests/support/d1-invocation';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import { GoogleTasksError, type GoogleTaskDTO } from '../../provider/google-tasks';
import { TaskSyncService, type SyncReader } from '../service';

const at = Date.parse('2026-11-02T12:00:00Z');
const list = { id: 'google-list', title: 'todo', etag: 'list-v1' };
const tasks = Array.from({ length: 25 }, (_, index): GoogleTaskDTO => ({
  id: `google-task-${index}`,
  title: `task ${index}`,
  etag: `task-${index}-v1`,
  status: 'needsAction',
  position: String(index).padStart(3, '0'),
}));

describe('bounded provider page throughput', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let db: D1Database;
  let reader: SyncReader;
  let providerCalls: number;
  let pageReads: number;
  let clock: number;
  let observed: GoogleTaskDTO[];

  beforeEach(async () => {
    fixture = testDatabase();
    db = fixture.db;
    await seedAccount(db, 'account', at);
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key,is_default) VALUES (?,?,?,?,?,1)',
      )
      .bind('list', 'account', list.id, list.title, list.title)
      .run();
    providerCalls = 0;
    pageReads = 0;
    clock = at;
    observed = tasks.map((task) => ({ ...task }));
    reader = {
      getTaskList: async () => {
        providerCalls++;
        return list;
      },
      listTaskLists: async () => {
        providerCalls++;
        return { items: [list], nextPageToken: null };
      },
      listTasks: async (_listId, options = {}) => {
        providerCalls++;
        pageReads++;
        const offset = Number(options.pageToken ?? 0);
        const end = Math.min(observed.length, offset + (options.maxResults ?? 100));
        return {
          items: observed.slice(offset, end),
          nextPageToken: end === observed.length ? null : String(end),
        };
      },
      getTask: async () => {
        providerCalls++;
        throw new Error('ordinary unchanged tasks do not require address checks');
      },
    };
  });

  afterEach(() => fixture.close());

  function service(database = db) {
    return new TaskSyncService(database, {
      clientFor: async () => reader,
      history: new HistoryService(database, { now: () => clock }),
      now: () => clock,
    });
  }

  async function seedProjection(listId = 'list', records = tasks) {
    const projection = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => at }),
      now: () => at,
    });
    for (let offset = 0; offset < records.length; offset += 4) {
      const prepared = await projection.prepareConfirmedWrites(
        'account',
        listId,
        records.slice(offset, offset + 4),
      );
      await db.batch(prepared.writes);
    }
    await db
      .prepare(
        'UPDATE tasks_lists SET tasks_complete_at=?,completed_complete_at=?,last_full_sync_at=?,last_synced_at=? WHERE id=?',
      )
      .bind(at, at, at, at, listId)
      .run();
  }

  async function advance() {
    const budget = invocationDatabase(db);
    const before = providerCalls;
    const sync = service(budget.db);
    const result = await sync.advance('account');
    await sync.getStatus('account');
    expect(providerCalls - before).toBeLessThanOrEqual(9); // leaves one token refresh
    expect(budget.queries).toBeLessThanOrEqual(35); // leaves room for route/session checks
    return result;
  }

  async function start() {
    await service().requestRefresh('account', { reason: 'entry' });
    expect((await advance()).phase).toBe('default');
    expect((await advance()).phase).toBe('inventory');
  }

  async function finish() {
    for (let count = 0; count < 20; count++) if (!(await advance()).continued) return;
    throw new Error('the captured page did not finish');
  }

  it('reconciles 25 unchanged ordinary tasks in one provider page and one task slice', async () => {
    await seedProjection();
    const before = await db.prepare('SELECT id,revision,title FROM tasks_tasks ORDER BY id').all();
    await service().requestRefresh('account', { reason: 'entry' });
    const phases: string[] = [];
    for (let count = 0; count < 20; count++) {
      const result = await advance();
      phases.push(result.phase);
      if (!result.continued) break;
    }
    expect(phases).toEqual(['default', 'inventory', 'tasks']);
    expect(pageReads).toBe(1);
    expect(await service().getStatus('account')).toMatchObject({
      initialized: true,
      pending: false,
    });
    expect(
      (await db.prepare('SELECT id,revision,title FROM tasks_tasks ORDER BY id').all()).results,
    ).toEqual(before.results);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM history_events').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('batches foreground phases under the shared invocation counters without invalidating unchanged data', async () => {
    await seedProjection();
    await db
      .prepare('UPDATE tasks_lists SET provider_etag=? WHERE id=?')
      .bind(list.etag, 'list')
      .run();
    await service().requestRefresh('account', { reason: 'entry' });
    await db.prepare('UPDATE tasks_account_state SET inventory_complete_at=?').bind(clock).run();
    let requests = 0;
    for (; requests < 5; requests++) {
      const invocation = invocationDatabase(db);
      for (let auth = 0; auth < 5; auth++) await invocation.db.prepare('SELECT 1').first();
      const before = providerCalls;
      const sync = new TaskSyncService(invocation.db, {
        history: new HistoryService(invocation.db, { now: () => clock }),
        clientFor: async () => reader,
        now: () => clock,
        databaseQueries: () => invocation.queries,
        providerRequests: () => providerCalls - before,
      });
      const result = await sync.advanceForeground('account');
      expect(result.changes).toEqual({ topology: false, tasks: false });
      expect(invocation.queries).toBeLessThanOrEqual(43);
      expect(providerCalls - before).toBeLessThanOrEqual(10);
      if (!result.status.pending) break;
    }
    expect(requests + 1).toBeLessThan(3);
    expect(pageReads).toBe(1);
  });

  it('certifies an unchanged prefix before a changed tail without reconciling it four records at a time', async () => {
    await seedProjection();
    observed[24] = { ...observed[24]!, title: 'changed tail', etag: 'tail-v2' };
    await start();
    await advance();
    expect(await db.prepare('SELECT page_offset FROM tasks_sync_list_work').first()).toEqual({
      page_offset: 24,
    });
    await finish();
    expect(pageReads).toBe(1);
    expect(
      await db.prepare("SELECT title FROM tasks_tasks WHERE provider_id='google-task-24'").first(),
    ).toEqual({ title: 'changed tail' });
  });

  it('retains the four-record projection bound across a foreground batch', async () => {
    await start();
    const invocation = invocationDatabase(db);
    const before = providerCalls;
    const sync = new TaskSyncService(invocation.db, {
      clientFor: async () => reader,
      history: new HistoryService(invocation.db, { now: () => clock }),
      now: () => clock,
      databaseQueries: () => invocation.queries,
      providerRequests: () => providerCalls - before,
    });
    expect((await sync.advanceForeground('account')).changes.tasks).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 4 });
    expect(await db.prepare('SELECT page_offset FROM tasks_sync_list_work').first()).toEqual({
      page_offset: 4,
    });
    expect(pageReads).toBe(1);
    expect(invocation.queries).toBeLessThanOrEqual(42);
  });

  it('reports newly missing addresses even when coverage was already incomplete', async () => {
    await seedProjection();
    await db
      .prepare('UPDATE tasks_lists SET tasks_complete_at=NULL,completed_complete_at=NULL')
      .run();
    observed = [];
    await start();
    const sync = service();
    expect((await sync.advanceForeground('account')).changes).toEqual({
      topology: false,
      tasks: true,
    });
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM tasks_tasks WHERE provider_missing_at IS NOT NULL')
          .first<{ n: number }>()
      )?.n,
    ).toBe(25);
  });

  it('does not invalidate task reads for an unchanged tracked task check', async () => {
    await seedProjection();
    const recorded = await db
      .prepare('SELECT id FROM tasks_tasks WHERE provider_id=?')
      .bind(tasks[0]!.id)
      .first<{ id: string }>();
    reader.getTask = async () => {
      providerCalls++;
      return tasks[0]!;
    };
    await service().requestTaskCheck('account', recorded!.id);
    const result = await service().advanceForeground('account');
    expect(result.changes).toEqual({ topology: false, tasks: false });
    expect(result.status.pending).toBe(false);
  });

  it('reports an unchanged baseline becoming complete as a task query change', async () => {
    await seedProjection();
    await db
      .prepare('UPDATE tasks_lists SET tasks_complete_at=NULL,completed_complete_at=NULL')
      .run();
    await start();
    expect((await service().advanceForeground('account')).changes.tasks).toBe(true);
  });

  it('does not claim work whose shared invocation has no safe next-slice headroom', async () => {
    await service().requestRefresh('account', { reason: 'entry' });
    const invocation = invocationDatabase(db);
    for (let query = 0; query < 39; query++) await invocation.db.prepare('SELECT 1').first();
    const sync = new TaskSyncService(invocation.db, {
      clientFor: async () => reader,
      history: new HistoryService(invocation.db, { now: () => clock }),
      databaseQueries: () => invocation.queries,
      providerRequests: () => providerCalls,
      now: () => clock,
    });
    const result = await sync.advanceForeground('account');
    expect(providerCalls).toBe(0);
    expect(result.status.pending).toBe(true);
    expect(result.changes).toEqual({ topology: false, tasks: false });
    expect(invocation.queries).toBeLessThanOrEqual(43);
    expect(await db.prepare('SELECT claim_id FROM tasks_sync_jobs').first()).toEqual({
      claim_id: null,
    });
  });

  it.each(['missing baseline', 'retained cursor'] as const)(
    'distinguishes a %s from an inventory data change when unchanged rows settle',
    async (state) => {
      await seedProjection();
      await start();
      await db
        .prepare('UPDATE tasks_sync_jobs SET default_pending=0,inventory_pending=1,task_turn=0')
        .run();
      await db
        .prepare('UPDATE tasks_account_state SET inventory_complete_at=?,inventory_cursor=?')
        .bind(
          state === 'missing baseline' ? null : clock,
          state === 'retained cursor' ? 'cursor' : null,
        )
        .run();
      const result = await service().advanceForeground('account');
      expect(result.changes).toEqual({ topology: state === 'missing baseline', tasks: false });
    },
  );

  it.each([false, true])(
    'preserves external settlement evidence before the final status read with foreign claim=%s',
    async (foreignClaim) => {
      await seedProjection();
      await start();
      await db
        .prepare(
          "INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key) VALUES('z-list','account','z-provider','other','other')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES('account','z-list',?)",
        )
        .bind(clock)
        .run();
      if (foreignClaim)
        await db
          .prepare("UPDATE tasks_sync_jobs SET claim_id='other-worker',claim_until=?")
          .bind(clock + 45_000)
          .run();
      let intercepted = false;
      const racing = new Proxy(db, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('SELECT CASE WHEN inventory_complete_at')) return statement;
              return new Proxy(statement, {
                get(prepared, method) {
                  if (method === 'bind')
                    return (...values: unknown[]) => {
                      const bound = prepared.bind(...values);
                      return new Proxy(bound, {
                        get(current, operation) {
                          if (operation === 'first')
                            return async () => {
                              intercepted = true;
                              await db.batch([
                                db.prepare(
                                  "DELETE FROM tasks_sync_list_work WHERE account_id='account'",
                                ),
                                db.prepare(
                                  "DELETE FROM tasks_sync_jobs WHERE account_id='account'",
                                ),
                              ]);
                              return current.first();
                            };
                          return Reflect.get(current, operation);
                        },
                      });
                    };
                  return Reflect.get(prepared, method);
                },
              });
            };
          return Reflect.get(target, key);
        },
      });
      const invocation = invocationDatabase(racing);
      const sync = foreignClaim
        ? new TaskSyncService(invocation.db, {
            clientFor: async () => reader,
            history: new HistoryService(invocation.db, { now: () => clock }),
            now: () => clock,
            databaseQueries: () => invocation.queries,
            providerRequests: () => providerCalls,
          })
        : service(racing);
      const result = await sync.advanceForeground('account');
      expect(intercepted).toBe(true);
      expect(result).toMatchObject({
        phase: foreignClaim ? 'coalesced' : 'tasks',
        continued: true,
        status: { pending: false },
      });
    },
  );

  it('refreshes a 6/4/15-task board in five slices and three provider task pages', async () => {
    const slices = [
      { local: 'list', provider: list, records: tasks.slice(0, 6) },
      {
        local: 'progress',
        provider: { id: 'google-progress', title: 'in progress' },
        records: tasks.slice(6, 10),
      },
      { local: 'done', provider: { id: 'google-done', title: 'done' }, records: tasks.slice(10) },
    ];
    for (const slice of slices) {
      if (slice.local !== 'list')
        await db
          .prepare(
            'INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key) VALUES (?,?,?,?,?)',
          )
          .bind(
            slice.local,
            'account',
            slice.provider.id,
            slice.provider.title,
            slice.provider.title,
          )
          .run();
      await seedProjection(slice.local, slice.records);
    }
    reader.listTaskLists = async () => {
      providerCalls++;
      return { items: slices.map((slice) => slice.provider), nextPageToken: null };
    };
    reader.listTasks = async (providerList, options = {}) => {
      providerCalls++;
      pageReads++;
      const records = slices.find((slice) => slice.provider.id === providerList)!.records;
      const offset = Number(options.pageToken ?? 0);
      const end = Math.min(records.length, offset + (options.maxResults ?? 100));
      return {
        items: records.slice(offset, end),
        nextPageToken: end === records.length ? null : String(end),
      };
    };
    await service().requestRefresh('account', { reason: 'entry' });
    const phases: string[] = [];
    for (let count = 0; count < 20; count++) {
      const result = await advance();
      phases.push(result.phase);
      if (!result.continued) break;
    }
    expect(phases).toEqual(['default', 'inventory', 'tasks', 'tasks', 'tasks']);
    expect(pageReads).toBe(3);
    expect(await service().getStatus('account')).toMatchObject({
      initialized: true,
      pending: false,
    });
    expect(
      (
        await db
          .prepare(
            'SELECT list_id,COUNT(*) AS n FROM tasks_tasks GROUP BY list_id ORDER BY list_id',
          )
          .all()
      ).results,
    ).toEqual([
      { list_id: 'done', n: 15 },
      { list_id: 'list', n: 6 },
      { list_id: 'progress', n: 4 },
    ]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM history_events').first()).toEqual({ n: 0 });
  });

  it('resumes a retained provider page after restart without exposing complete coverage early', async () => {
    await start();
    await advance();
    expect(pageReads).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 4 });
    expect(await db.prepare('SELECT page_offset FROM tasks_sync_list_work').first()).toEqual({
      page_offset: 4,
    });
    expect(await service().getStatus('account')).toMatchObject({
      initialized: false,
      pending: true,
    });
    expect(
      await db.prepare('SELECT tasks_complete_at,sync_cursor FROM tasks_lists').first(),
    ).toMatchObject({ tasks_complete_at: null, sync_cursor: expect.any(String) });
    await finish(); // every advance constructs another service, as another Worker invocation does
    expect(pageReads).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 25 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_sync_list_work').first()).toEqual({
      n: 0,
    });
    expect(await service().getStatus('account')).toMatchObject({
      initialized: true,
      pending: false,
    });
  });

  it('keeps the captured offset and projection atomic when a page slice cannot commit', async () => {
    await start();
    await advance();
    const retained = await db.prepare('SELECT * FROM tasks_sync_list_work').first();
    let reject = true;
    const failing = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return (...args: Parameters<D1Database['batch']>) => {
            if (reject) {
              reject = false;
              throw new Error('interrupted local commit');
            }
            return target.batch(...args);
          };
        return Reflect.get(target, property);
      },
    });
    await expect(service(failing).advance('account')).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(await db.prepare('SELECT * FROM tasks_sync_list_work').first()).toEqual(retained);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 4 });
    clock += 2_000;
    await finish();
    expect(pageReads).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 25 });
  });

  it('refetches the provider page when the local projection changes between captured slices', async () => {
    await seedProjection();
    observed[24] = { ...observed[24]!, title: 'first observation', etag: 'changed-v1' };
    await start();
    await advance();
    expect(pageReads).toBe(1);
    observed[24] = { ...observed[24]!, title: 'fresh observation', etag: 'changed-v2' };
    await db.prepare('UPDATE tasks_lists SET projection_revision=projection_revision+1').run();
    await finish();
    expect(pageReads).toBe(2);
    expect(
      await db
        .prepare('SELECT title FROM tasks_tasks WHERE provider_id=?')
        .bind(tasks[24]!.id)
        .first(),
    ).toEqual({ title: 'fresh observation' });
  });

  it('discards retained observations when a confirmed move requests a new full order scan', async () => {
    await start();
    await advance();
    await db.batch(service().providerOrderRefreshWrites('account', ['list']));
    expect(
      await db
        .prepare(
          'SELECT mode,page_token,scan_id,page_json,page_offset,page_projection_revision FROM tasks_sync_list_work',
        )
        .first(),
    ).toEqual({
      mode: 'full',
      page_token: null,
      scan_id: null,
      page_json: null,
      page_offset: 0,
      page_projection_revision: null,
    });
    await finish();
    expect(pageReads).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 25 });
  });

  it.each(['invalid shape', 'invalid offset'] as const)(
    'refetches a retained page with %s without skipping provider records',
    async (kind) => {
      await start();
      await advance();
      await db
        .prepare(
          kind === 'invalid shape'
            ? "UPDATE tasks_sync_list_work SET page_json='{}'"
            : 'UPDATE tasks_sync_list_work SET page_offset=25',
        )
        .run();
      await finish();
      expect(pageReads).toBe(2);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first()).toEqual({ n: 25 });
    },
  );

  it('keeps same-id tasks at two live provider addresses distinct within the request budget', async () => {
    await seedProjection();
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key) VALUES (?,?,?,?,?)',
      )
      .bind('other', 'account', 'google-other', 'other', 'other')
      .run();
    reader.getTask = async (_providerList, id) => {
      providerCalls++;
      return tasks.find((task) => task.id === id)!;
    };
    await db.batch(service().providerOrderRefreshWrites('account', ['other']));
    await finish();
    expect(pageReads).toBe(1);
    expect(
      await db
        .prepare('SELECT list_id,COUNT(*) AS n FROM tasks_tasks GROUP BY list_id ORDER BY list_id')
        .all(),
    ).toMatchObject({
      results: [
        { list_id: 'list', n: 25 },
        { list_id: 'other', n: 25 },
      ],
    });
  });

  it('reconciles a child and its later parent across captured-page slices', async () => {
    observed = [
      { id: 'child', parent: 'parent', title: 'child', etag: 'child-v1' },
      ...tasks.slice(0, 3),
      { id: 'parent', title: 'parent', etag: 'parent-v1' },
      ...tasks.slice(3, 23),
    ];
    await start();
    await advance();
    expect(
      await db
        .prepare("SELECT unsupported_hierarchy FROM tasks_tasks WHERE provider_id='child'")
        .first(),
    ).toEqual({ unsupported_hierarchy: 1 });
    await db
      .prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE provider_id='child'")
      .run();
    await finish();
    expect(
      await db
        .prepare(
          `SELECT child.unsupported_hierarchy,child.priority,child.starred,
      child.parent_id=parent.id AS resolved FROM tasks_tasks child JOIN tasks_tasks parent
      ON parent.provider_id='parent' WHERE child.provider_id='child'`,
        )
        .first(),
    ).toEqual({ unsupported_hierarchy: 0, priority: 'high', starred: 1, resolved: 1 });
    expect(pageReads).toBe(1);
  });

  it('preserves stable identities and metadata across moved records in a retained page', async () => {
    await seedProjection();
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,title_key) VALUES (?,?,?,?,?)',
      )
      .bind('other', 'account', 'google-other', 'other', 'other')
      .run();
    await db.prepare("UPDATE tasks_tasks SET priority='high',starred=1").run();
    const before = await db.prepare('SELECT id,provider_id FROM tasks_tasks ORDER BY id').all();
    const originalRead = reader.listTasks;
    reader.listTasks = async (providerList, options) => {
      if (providerList === 'google-other') return originalRead(providerList, options);
      providerCalls++;
      return { items: [], nextPageToken: null };
    };
    reader.getTask = async () => {
      providerCalls++;
      throw new GoogleTasksError('not_found', { status: 404 });
    };
    await db.batch(service().providerOrderRefreshWrites('account', ['other']));
    for (let count = 0; count < 7; count++) {
      // Keep the destination page ahead of its queued source reconciliation.
      await db.prepare("UPDATE tasks_sync_list_work SET priority=1 WHERE list_id='list'").run();
      await advance();
    }
    await finish();
    expect(
      (await db.prepare('SELECT id,provider_id FROM tasks_tasks ORDER BY id').all()).results,
    ).toEqual(before.results);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_tasks WHERE list_id='other' AND priority='high' AND starred=1",
        )
        .first(),
    ).toEqual({ n: 25 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM history_events WHERE kind='task_moved'").first(),
    ).toEqual({ n: 25 });
    expect(await service().getStatus('account')).toMatchObject({
      initialized: true,
      pending: false,
    });
  });
});
