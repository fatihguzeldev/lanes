import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { TaskProjectionStore } from '../../projection/store';
import {
  GoogleTasksError,
  type GoogleProviderPage,
  type GoogleTaskDTO,
  type GoogleTaskListDTO,
  type GoogleTaskPageOptions,
} from '../../provider/google-tasks';
import { TaskQueries } from '../../queries/tasks';
import { TaskSyncService, type SyncReader } from '../service';

const now = Date.parse('2026-11-02T12:00:00Z');
const defaultList = { id: 'google-default', title: 'inbox', etag: 'list-v1' };
describe('durable bounded provider reconciliation', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let db: D1Database;
  let sync: TaskSyncService;
  let clock: number;
  let reader: SyncReader;
  let calls: string[];
  let lists: GoogleProviderPage<GoogleTaskListDTO>[];
  let taskPage: (
    listId: string,
    input: GoogleTaskPageOptions,
  ) => Promise<GoogleProviderPage<GoogleTaskDTO>>;
  let getList: (id: string) => Promise<GoogleTaskListDTO>;
  let getTask: (listId: string, id: string) => Promise<GoogleTaskDTO>;
  beforeEach(async () => {
    fixture = testDatabase();
    db = fixture.db;
    clock = now;
    calls = [];
    lists = [{ items: [defaultList], nextPageToken: null }];
    await seedAccount(db, 'a', now);
    taskPage = async () => ({ items: [], nextPageToken: null });
    getList = async () => defaultList;
    getTask = async (_listId, id) => ({ id, title: id, status: 'needsAction', etag: 'v1' });
    reader = {
      getTaskList: async (id) => {
        calls.push('list:' + id);
        return getList(id);
      },
      listTaskLists: async (input) => {
        calls.push('inventory:' + (input?.pageToken ?? ''));
        return lists.shift() ?? { items: [defaultList], nextPageToken: null };
      },
      listTasks: async (id, input = {}) => {
        calls.push('tasks:' + id);
        expect(input.maxResults).toBe(25);
        return taskPage(id, input);
      },
      getTask: async (listId, id) => {
        calls.push('task:' + listId + ':' + id);
        return getTask(listId, id);
      },
    };
    sync = new TaskSyncService(db, {
      clientFor: async () => reader,
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
  });
  afterEach(() => fixture.close());
  async function drain() {
    for (let i = 0; i < 50; i++) {
      const result = await sync.advance('a');
      if (!result.continued) return;
    }
    throw new Error('sync did not finish');
  }
  async function refresh() {
    await sync.requestRefresh('a', { reason: 'entry' });
    await drain();
  }
  async function one(sql: string, ...values: (string | number)[]) {
    return db
      .prepare(sql)
      .bind(...values)
      .first<Record<string, unknown>>();
  }
  async function taskId(providerId: string) {
    return (
      await one('SELECT id FROM tasks_tasks WHERE account_id=? AND provider_id=?', 'a', providerId)
    )?.id as string;
  }
  async function listId() {
    return (
      await one(
        'SELECT id FROM tasks_lists WHERE account_id=? AND provider_id=?',
        'a',
        defaultList.id,
      )
    )?.id as string;
  }

  it('refreshes only the move source and destination from full pages, replacing old delta cursors', async () => {
    lists = [
      {
        items: [
          defaultList,
          { id: 'destination', title: 'destination' },
          { id: 'unrelated', title: 'unrelated' },
        ],
        nextPageToken: null,
      },
    ];
    await refresh();
    const rows = (
      await db
        .prepare('SELECT id,provider_id FROM tasks_lists WHERE account_id=?')
        .bind('a')
        .all<{ id: string; provider_id: string }>()
    ).results;
    const source = rows.find((row) => row.provider_id === defaultList.id)!.id;
    const destination = rows.find((row) => row.provider_id === 'destination')!.id;
    const unrelated = rows.find((row) => row.provider_id === 'unrelated')!.id;
    await db
      .prepare(
        "INSERT INTO tasks_sync_list_work(account_id,list_id,priority,next_at,mode,page_token,scan_id,started_at,updated_min) VALUES ('a',?,1,?,'delta','old-page','old-scan',?,'old-watermark')",
      )
      .bind(source, clock, clock)
      .run();
    clock += 10_000;
    calls = [];
    await db.batch(sync.providerOrderRefreshWrites('a', [source, source, destination]));
    expect(
      await one(
        'SELECT default_pending,inventory_pending FROM tasks_sync_jobs WHERE account_id=?',
        'a',
      ),
    ).toEqual({ default_pending: 0, inventory_pending: 0 });
    expect(
      await one(
        'SELECT mode,page_token,scan_id,started_at,updated_min FROM tasks_sync_list_work WHERE account_id=? AND list_id=?',
        'a',
        source,
      ),
    ).toEqual({
      mode: 'full',
      page_token: null,
      scan_id: null,
      started_at: null,
      updated_min: null,
    });
    expect(await one('SELECT tasks_complete_at FROM tasks_lists WHERE id=?', source)).toEqual({
      tasks_complete_at: null,
    });
    taskPage = async (_listId, input) => {
      expect(input.updatedMin).toBeUndefined();
      expect(input.pageToken).toBeUndefined();
      return { items: [], nextPageToken: null };
    };
    await drain();
    expect([...calls].sort()).toEqual(['tasks:destination', 'tasks:' + defaultList.id].sort());
    for (const id of [source, destination])
      expect(
        await one('SELECT tasks_complete_at,completed_complete_at FROM tasks_lists WHERE id=?', id),
      ).toEqual({ tasks_complete_at: clock, completed_complete_at: clock });
    expect(await one('SELECT tasks_complete_at FROM tasks_lists WHERE id=?', unrelated)).toEqual({
      tasks_complete_at: now,
    });
  });
  it('rejects an order refresh crossing an account boundary without invalidating the valid source', async () => {
    await refresh();
    const source = await listId();
    await seedAccount(db, 'b', now);
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES ('foreign','b','foreign-google','foreign')",
      )
      .run();
    await expect(
      db.batch(sync.providerOrderRefreshWrites('a', [source, 'foreign'])),
    ).rejects.toThrow();
    expect(await one('SELECT tasks_complete_at FROM tasks_lists WHERE id=?', source)).toEqual({
      tasks_complete_at: now,
    });
    expect((await one('SELECT COUNT(*) AS n FROM tasks_sync_jobs'))?.n).toBe(0);
    expect((await one('SELECT COUNT(*) AS n FROM tasks_sync_list_work'))?.n).toBe(0);
  });
  it('resolves default identity explicitly and reads at most one provider resource per ordinary slice', async () => {
    lists = [{ items: [{ id: 'first', title: 'inbox' }, defaultList], nextPageToken: null }];
    await sync.requestRefresh('a', { reason: 'entry' });
    for (let i = 0; i < 10; i++) {
      const before = calls.length;
      const result = await sync.advance('a');
      expect(calls.length - before).toBeLessThanOrEqual(1);
      if (!result.continued) break;
    }
    expect(calls[0]).toBe('list:@default');
    expect(
      (await one('SELECT provider_id FROM tasks_lists WHERE account_id=? AND is_default=1', 'a'))
        ?.provider_id,
    ).toBe(defaultList.id);
  });
  it('retains complete inventory count and unseen rows across partial inventory pages', async () => {
    await refresh();
    await db.prepare('UPDATE tasks_account_state SET inventory_count=12').run();
    lists = [
      { items: [], nextPageToken: 'page-two' },
      { items: [defaultList], nextPageToken: null },
    ];
    clock += 61_000;
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.advance('a');
    await sync.advance('a');
    expect(
      await one(
        'SELECT inventory_count,inventory_cursor FROM tasks_account_state WHERE account_id=?',
        'a',
      ),
    ).toMatchObject({ inventory_count: 12, inventory_cursor: 'page-two' });
    expect(
      (await one('SELECT deleted_at FROM tasks_lists WHERE account_id=?', 'a'))?.deleted_at,
    ).toBeNull();
    await drain();
  });
  it('preserves lanes metadata and day-only semantics without sending provider writes or baseline history', async () => {
    taskPage = async () => ({
      items: [
        { id: 't', title: 'ÉTÉ', notes: 'plain text', due: '2026-11-03T00:00:00Z', etag: 'v1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId('t');
    expect((await one('SELECT COUNT(*) AS n FROM history_events'))?.n).toBe(0);
    await db
      .prepare(
        "UPDATE tasks_tasks SET priority='high',starred=1,scheduled_time='09:30',time_zone='Europe/Istanbul' WHERE id=?",
      )
      .bind(id)
      .run();
    taskPage = async (_id, input) => {
      expect(input.updatedMin).toBe('2026-11-02T11:58:00.000Z');
      return {
        items: [{ id: 't', title: 'new', due: '2026-11-04T00:00:00Z', etag: 'v2' }],
        nextPageToken: null,
      };
    };
    clock += 61_000;
    await refresh();
    const task = await new TaskQueries(db).getTask('a', id);
    expect(task).toMatchObject({
      title: 'new',
      notes: '',
      priority: 'high',
      starred: true,
      scheduledDay: '2026-11-04',
      scheduledTime: '09:30',
      timeZone: 'Europe/Istanbul',
    });
    expect(await one('SELECT title_key,search_text FROM tasks_tasks WHERE id=?', id)).toMatchObject(
      { title_key: 'new', search_text: 'new\n' },
    );
    expect(calls.every((call) => /^(list|inventory|tasks|task):/.test(call))).toBe(true);
  });
  it('commits a task page checkpoint only after all records and history writes succeed', async () => {
    taskPage = async () => ({
      items: [{ id: 't', title: 'task', etag: 'v1' }],
      nextPageToken: 'next',
    });
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.advance('a');
    await sync.advance('a');
    fixture.sqlite.exec(
      "CREATE TRIGGER reject_task BEFORE INSERT ON tasks_tasks BEGIN SELECT RAISE(ABORT,'test capture failure'); END",
    );
    await expect(sync.advance('a')).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(
      (await one('SELECT sync_cursor FROM tasks_lists WHERE account_id=?', 'a'))?.sync_cursor,
    ).toBeNull();
    expect((await one('SELECT COUNT(*) AS n FROM tasks_tasks'))?.n).toBe(0);
  });
  it('coalesces concurrent claims and repeated manual refresh without two reads', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getList = async () => {
      await gate;
      return defaultList;
    };
    await sync.requestRefresh('a', { reason: 'manual' });
    const first = sync.advance('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await sync.requestRefresh('a', { reason: 'manual' })).toEqual({ coalesced: true });
    expect((await sync.advance('a')).phase).toBe('coalesced');
    release();
    await first;
    expect(calls).toEqual(['list:@default']);
  });
  it('rejects stale provider pages when a local command advanced list projection revision', async () => {
    await refresh();
    taskPage = async () => {
      await db
        .prepare(
          'UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE account_id=?',
        )
        .bind('a')
        .run();
      return { items: [{ id: 'stale', title: 'stale', etag: 'v1' }], nextPageToken: null };
    };
    clock += 61_000;
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.advance('a');
    await sync.advance('a');
    await expect(sync.advance('a')).rejects.toMatchObject({ code: 'conflict' });
    expect(await taskId('stale')).toBeUndefined();
  });
  it('records known completion once and captures pre-page open children durably', async () => {
    taskPage = async () => ({
      items: [
        { id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', etag: 'p1' },
        { id: 'c', title: 'child', parent: 'p', etag: 'c1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    const parentId = await taskId('p');
    const rule = {
      frequency: 'daily',
      interval: 1,
      anchorDay: '2026-11-03',
      weekStart: 1,
      timeZone: 'Europe/Istanbul',
      end: { kind: 'never' },
    };
    await db
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=?,series_id=?,occurrence_id=? WHERE id=?')
      .bind(JSON.stringify(rule), 'series', 'occurrence', parentId)
      .run();
    taskPage = async () => ({
      items: [
        { id: 'c', title: 'child', parent: 'p', status: 'completed', etag: 'c2' },
        { id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', status: 'completed', etag: 'p2' },
      ],
      nextPageToken: null,
    });
    clock += 61_000;
    await refresh();
    expect((await one('SELECT COUNT(*) AS n FROM tasks_recurrence_transitions'))?.n).toBe(1);
    expect((await one('SELECT COUNT(*) AS n FROM tasks_recurrence_transition_children'))?.n).toBe(
      1,
    );
    expect(
      (await one('SELECT snapshot_json FROM tasks_recurrence_transition_children'))?.snapshot_json,
    ).toContain('"completed":0');
    clock += 61_000;
    await refresh();
    expect(
      (await one("SELECT COUNT(*) AS n FROM history_events WHERE kind='task_completed'"))?.n,
    ).toBe(2);
    expect((await one('SELECT COUNT(*) AS n FROM tasks_recurrence_transitions'))?.n).toBe(1);
  });
  it('pauses the retained rule and clears time when google removes the scheduled day', async () => {
    taskPage = async () => ({
      items: [{ id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', etag: 'p1' }],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId('p');
    await db
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=?,scheduled_time=?,time_zone=? WHERE id=?')
      .bind('{"kept":"rule"}', '08:00', 'Europe/Istanbul', id)
      .run();
    taskPage = async () => ({
      items: [{ id: 'p', title: 'parent', etag: 'p2' }],
      nextPageToken: null,
    });
    clock += 61_000;
    await refresh();
    expect(
      await one(
        'SELECT scheduled_day,scheduled_time,repeat_rule_json FROM tasks_tasks WHERE id=?',
        id,
      ),
    ).toMatchObject({ scheduled_day: null, scheduled_time: null, repeat_rule_json: null });
    expect(
      (await one('SELECT rule_json FROM tasks_schedule_pauses WHERE task_id=?', id))?.rule_json,
    ).toBe('{"kept":"rule"}');
  });
  it('retains metadata as stale read-only after an old task address returns 404', async () => {
    taskPage = async () => ({
      items: [{ id: 't', title: 'keep', etag: 'v1' }],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId('t');
    getTask = async () => {
      throw new GoogleTasksError('not_found', { status: 404 });
    };
    await sync.requestTaskCheck('a', id);
    await drain();
    expect(
      await one('SELECT deleted_at,provider_missing_at FROM tasks_tasks WHERE id=?', id),
    ).toMatchObject({ deleted_at: null, provider_missing_at: clock });
    expect((await new TaskQueries(db).getTask('a', id)).capabilities).toMatchObject({
      canEdit: false,
      canMove: false,
    });
  });
  it('retires a confirmed list only after its correct provider address returns 404', async () => {
    lists = [{ items: [defaultList, { id: 'extra', title: 'extra' }], nextPageToken: null }];
    await refresh();
    lists = [{ items: [defaultList], nextPageToken: null }];
    getList = async (id) => {
      if (id === 'extra') throw new GoogleTasksError('not_found', { status: 404 });
      return defaultList;
    };
    clock += 61_000;
    await refresh();
    expect(calls).toContain('list:extra');
    expect(
      (await one('SELECT deleted_at FROM tasks_lists WHERE provider_id=?', 'extra'))?.deleted_at,
    ).toBe(clock);
    expect(
      (await one('SELECT inventory_count FROM tasks_account_state WHERE account_id=?', 'a'))
        ?.inventory_count,
    ).toBe(2);
  });
  it('keeps missing full-scan tasks visible with incomplete coverage instead of deleting them', async () => {
    taskPage = async () => ({
      items: [{ id: 't', title: 'retained', etag: 'v1' }],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId('t');
    clock += 31 * 60_000;
    taskPage = async (_listId, input) => {
      expect(input.updatedMin).toBeUndefined();
      return { items: [], nextPageToken: null };
    };
    getTask = async () => {
      throw new GoogleTasksError('not_found', { status: 404 });
    };
    await refresh();
    const page = await new TaskQueries(db).listTasks('a', {}, { today: '2026-11-02', now: clock });
    expect(page.items.map((task) => task.id)).toContain(id);
    expect(page.providerCoverage.complete).toBe(false);
    expect(page.items[0]?.capabilities.canEdit).toBe(false);
  });
  it('keeps task coverage partial until the last page and never manufactures baseline creations', async () => {
    taskPage = async (_listId, input) =>
      input.pageToken
        ? { items: [{ id: 'second', title: 'second', etag: 'v2' }], nextPageToken: null }
        : { items: [{ id: 'first', title: 'first', etag: 'v1' }], nextPageToken: 'next' };
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.advance('a');
    await sync.advance('a');
    await sync.advance('a');
    expect(
      await one('SELECT sync_cursor,tasks_complete_at,completed_complete_at FROM tasks_lists'),
    ).toMatchObject({ sync_cursor: 'next', tasks_complete_at: null, completed_complete_at: null });
    await drain();
    expect((await one('SELECT COUNT(*) AS n FROM tasks_tasks'))?.n).toBe(2);
    expect((await one('SELECT COUNT(*) AS n FROM history_events'))?.n).toBe(0);
  });
  it('resumes a paused authorization job after reconnect without dropping its page', async () => {
    getList = async () => {
      throw new GoogleTasksError('reconnect_required', { status: 401 });
    };
    await sync.requestRefresh('a', { reason: 'entry' });
    await expect(sync.advance('a')).rejects.toMatchObject({ code: 'reconnect_required' });
    getList = async () => defaultList;
    await sync.requestRefresh('a', { reason: 'reconnect' });
    await drain();
    expect((await one('SELECT COUNT(*) AS n FROM tasks_sync_jobs'))?.n).toBe(0);
  });
  it('cannot commit a stale expired claim after another worker advanced the same read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    getList = async () => {
      if (++requests === 1) await gate;
      return defaultList;
    };
    await sync.requestRefresh('a', { reason: 'entry' });
    const old = sync.advance('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock += 46_000;
    await sync.advance('a');
    const currentJob = await one('SELECT * FROM tasks_sync_jobs');
    release();
    await expect(old).resolves.toMatchObject({ phase: 'coalesced', continued: true });
    expect(await one('SELECT * FROM tasks_sync_jobs')).toEqual(currentJob);
    expect((await one('SELECT COUNT(*) AS n FROM tasks_lists'))?.n).toBe(1);
  });
  it('treats tasks.list 404 as deferred list verification instead of blocking all later checks', async () => {
    lists = [{ items: [defaultList, { id: 'extra', title: 'extra' }], nextPageToken: null }];
    await refresh();
    clock += 61_000;
    lists = [{ items: [defaultList], nextPageToken: null }];
    taskPage = async (listId) => {
      if (listId === 'extra') throw new GoogleTasksError('not_found', { status: 404 });
      return { items: [], nextPageToken: null };
    };
    getList = async (id) => {
      if (id === 'extra') throw new GoogleTasksError('not_found', { status: 404 });
      return defaultList;
    };
    await refresh();
    expect(
      (await one('SELECT deleted_at FROM tasks_lists WHERE provider_id=?', 'extra'))?.deleted_at,
    ).toBe(clock);
  });
  it('keeps assigned notes restrictions when its parent is discovered on a later page', async () => {
    taskPage = async (_listId, input) =>
      input.pageToken
        ? { items: [{ id: 'p', title: 'parent', etag: 'p1' }], nextPageToken: null }
        : {
            items: [
              {
                id: 'c',
                title: 'child',
                parent: 'p',
                assignmentInfo: {
                  surfaceType: 'DOCUMENT',
                  linkToTask: 'https://docs.google.com/document/d/example',
                },
                etag: 'c1',
              },
            ],
            nextPageToken: 'parent',
          };
    await refresh();
    const child = await new TaskQueries(db).getTask('a', await taskId('c'));
    expect(child.parentId).toBe(await taskId('p'));
    expect(child.capabilities).toMatchObject({
      canEditNotes: false,
      canNest: false,
      assignmentSource: 'docs',
    });
  });
  it('rolls back completion and checkpoint if the durable checklist capture fails', async () => {
    taskPage = async () => ({
      items: [
        { id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', etag: 'p1' },
        { id: 'c', parent: 'p', title: 'child', etag: 'c1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    await db
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=? WHERE id=?')
      .bind('{"kept":"rule"}', await taskId('p'))
      .run();
    fixture.sqlite.exec(
      "CREATE TRIGGER reject_snapshot BEFORE INSERT ON tasks_recurrence_transition_children BEGIN SELECT RAISE(ABORT,'capture failed'); END",
    );
    taskPage = async () => ({
      items: [
        { id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', status: 'completed', etag: 'p2' },
      ],
      nextPageToken: null,
    });
    clock += 61_000;
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.advance('a');
    await sync.advance('a');
    await expect(sync.advance('a')).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(
      (await one('SELECT completed FROM tasks_tasks WHERE provider_id=?', 'p'))?.completed,
    ).toBe(0);
    expect((await one('SELECT COUNT(*) AS n FROM tasks_recurrence_transitions'))?.n).toBe(0);
  });
  it('preserves an explicitly captured lanes identity when google changes the move address', async () => {
    lists = [
      { items: [defaultList, { id: 'destination', title: 'destination' }], nextPageToken: null },
    ];
    taskPage = async (id) => ({
      items:
        id === defaultList.id
          ? [{ id: 'source-id', title: 'source', notes: 'retained', etag: 'v1' }]
          : [],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId('source-id');
    const destination = (await one('SELECT id FROM tasks_lists WHERE provider_id=?', 'destination'))
      ?.id as string;
    await db.prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE id=?").bind(id).run();
    const store = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    const projection = await store.prepareConfirmedWrites(
      'a',
      destination,
      [{ id: 'new-provider-id', title: 'source', notes: 'retained', etag: 'v2' }],
      { knownTaskIds: new Map([['new-provider-id', id]]) },
    );
    await db.batch(projection.writes);
    expect(await new TaskQueries(db).getTask('a', id)).toMatchObject({
      id,
      listId: destination,
      priority: 'high',
      starred: true,
      provider: { id: 'new-provider-id', listId: 'destination' },
    });
  });
  it('keeps the lanes identity and metadata when a missing Google task appears in another list with the same provider id', async () => {
    const destinationList = { id: 'destination', title: 'destination', etag: 'destination-v1' };
    const providerTask = {
      id: 'stable-id',
      title: 'move this task',
      notes: 'keep these notes',
      due: '2026-11-03T00:00:00Z',
      etag: 'before-move',
    };
    const companions = [
      { id: 'blocker', title: 'a blocker', etag: 'blocker-v1' },
      { id: 'dependent', title: 'a dependent', etag: 'dependent-v1' },
    ];
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    taskPage = async (providerListId) => ({
      items: providerListId === defaultList.id ? [providerTask, ...companions] : [],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId(providerTask.id);
    const blockerId = await taskId('blocker');
    const dependentId = await taskId('dependent');
    const sourceId = await listId();
    const destinationId = (
      await one(
        'SELECT id FROM tasks_lists WHERE account_id=? AND provider_id=?',
        'a',
        destinationList.id,
      )
    )?.id as string;
    const rule = {
      frequency: 'weekly',
      interval: 1,
      anchorDay: '2026-11-03',
      zone: 'Europe/Istanbul',
      weekStart: 1,
      weekdays: [2],
      end: { type: 'never' },
    };
    await db.batch([
      db.prepare(
        "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES ('label','a','keep','keep','#123456')",
      ),
      db
        .prepare('INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES (?,?,?)')
        .bind('a', id, 'label'),
      db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES (?,?,?)')
        .bind('a', id, blockerId),
      db
        .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES (?,?,?)')
        .bind('a', dependentId, id),
      db
        .prepare(
          "UPDATE tasks_tasks SET priority='high',starred=1,scheduled_time='09:30',time_zone='Europe/Istanbul',repeat_rule_json=? WHERE id=?",
        )
        .bind(JSON.stringify(rule), id),
      new HistoryService(db, { now: () => clock }).eventWrite({
        id: 'before-move-history',
        accountId: 'a',
        taskId: id,
        listId: sourceId,
        kind: 'star_changed',
        origin: 'observed',
        dedupKey: 'before-move-star',
        recordedAt: new Date(clock).toISOString(),
        taskTitle: providerTask.title,
        listTitle: defaultList.title,
        summary: { before: false, after: true, providerVersion: 'before-move-star' },
      }),
    ]);
    const moved = { ...providerTask, etag: 'after-move' };
    getTask = async (providerListId, providerId) => {
      if (providerId === providerTask.id && providerListId === defaultList.id)
        throw new GoogleTasksError('not_found', { status: 404 });
      if (providerId === providerTask.id && providerListId === destinationList.id) return moved;
      return companions.find((task) => task.id === providerId)!;
    };
    await sync.requestTaskCheck('a', id);
    await drain();
    expect(
      (await one('SELECT provider_missing_at FROM tasks_tasks WHERE id=?', id))
        ?.provider_missing_at,
    ).not.toBeNull();
    clock += 61_000;
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    taskPage = async (providerListId) => ({
      items: providerListId === destinationList.id ? [moved] : companions,
      nextPageToken: null,
    });
    await refresh();
    const addresses = await db
      .prepare(
        'SELECT id,list_id FROM tasks_tasks WHERE account_id=? AND provider_id=? AND deleted_at IS NULL',
      )
      .bind('a', providerTask.id)
      .all();
    expect(addresses.results).toEqual([{ id, list_id: destinationId }]);
    const queries = new TaskQueries(db);
    expect(await queries.getTask('a', id)).toMatchObject({
      id,
      listId: destinationId,
      title: providerTask.title,
      notes: providerTask.notes,
      labelIds: ['label'],
      priority: 'high',
      starred: true,
      blockedBy: [blockerId],
      scheduledDay: '2026-11-03',
      scheduledTime: '09:30',
      timeZone: 'Europe/Istanbul',
      repeatRule: rule,
      provider: { id: providerTask.id, listId: destinationList.id },
      capabilities: { canEdit: true, canMove: true },
    });
    expect((await queries.getTask('a', dependentId)).blockedBy).toEqual([id]);
    expect(
      await one('SELECT task_id,list_id FROM history_events WHERE id=?', 'before-move-history'),
    ).toEqual({ task_id: id, list_id: sourceId });
    for (const list of [sourceId, destinationId]) {
      const page = await queries.listTasks(
        'a',
        { listIds: [list] },
        { today: '2026-11-02', now: clock },
      );
      expect(page.providerCoverage.complete).toBe(true);
    }
    clock += 61_000;
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    await refresh();
    expect(
      (
        await one(
          'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND provider_id=?',
          'a',
          providerTask.id,
        )
      )?.n,
    ).toBe(1);
    expect((await queries.getTask('a', id)).listId).toBe(destinationId);
    expect(
      (
        await one(
          "SELECT COUNT(*) AS n FROM history_events WHERE task_id=? AND kind='task_created'",
          id,
        )
      )?.n,
    ).toBe(0);
    taskPage = async (providerListId) => ({
      items: providerListId === destinationList.id ? [moved] : [providerTask, ...companions],
      nextPageToken: null,
    });
    clock += 61_000;
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    await refresh();
    expect((await queries.getTask('a', id)).listId).toBe(destinationId);
    expect(
      (
        await one(
          'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND provider_id=?',
          'a',
          providerTask.id,
        )
      )?.n,
    ).toBe(1);
  });
  it('preserves parent and child identities when an external move arrives on separate destination pages', async () => {
    const destinationList = { id: 'destination', title: 'destination' };
    const parent = { id: 'parent-id', title: 'parent', etag: 'parent-v1' };
    const child = { id: 'child-id', parent: parent.id, title: 'child', etag: 'child-v1' };
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    taskPage = async (providerListId) => ({
      items: providerListId === defaultList.id ? [parent, child] : [],
      nextPageToken: null,
    });
    await refresh();
    const parentId = await taskId(parent.id);
    const childId = await taskId(child.id);
    const sourceId = await listId();
    const destinationId = (
      await one(
        'SELECT id FROM tasks_lists WHERE account_id=? AND provider_id=?',
        'a',
        destinationList.id,
      )
    )?.id as string;
    await db
      .prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE id=?")
      .bind(childId)
      .run();
    const movedParent = { ...parent, etag: 'parent-v2' };
    const movedChild = { ...child, etag: 'child-v2' };
    getTask = async (providerListId, providerId) => {
      if (providerListId === defaultList.id)
        throw new GoogleTasksError('not_found', { status: 404 });
      return providerId === parent.id ? movedParent : movedChild;
    };
    taskPage = async (providerListId, input) =>
      providerListId === defaultList.id
        ? { items: [], nextPageToken: null }
        : input.pageToken
          ? { items: [movedChild], nextPageToken: null }
          : { items: [movedParent], nextPageToken: 'child-page' };
    clock += 61_000;
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    await sync.requestRefresh('a', { reason: 'entry', visibleListIds: [destinationId] });
    await sync.advance('a');
    await sync.advance('a');
    await sync.advance('a');
    const queries = new TaskQueries(db);
    expect((await queries.getTask('a', parentId)).listId).toBe(destinationId);
    expect(
      await one(
        'SELECT list_id,parent_id,provider_parent_id,deleted_at FROM tasks_tasks WHERE id=?',
        childId,
      ),
    ).toEqual({
      list_id: sourceId,
      parent_id: null,
      provider_parent_id: parent.id,
      deleted_at: null,
    });
    expect(await queries.getTask('a', childId)).toMatchObject({
      priority: 'high',
      starred: true,
      unsupportedHierarchy: true,
      capabilities: { canEdit: false },
    });
    await sync.advance('a');
    await drain();
    expect(await queries.getTask('a', childId)).toMatchObject({
      id: childId,
      listId: destinationId,
      parentId,
      priority: 'high',
      starred: true,
      unsupportedHierarchy: false,
      capabilities: { canEdit: true, canMove: true },
      provider: { id: child.id, listId: destinationList.id },
    });
    expect(
      (
        await one(
          'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND provider_id IN (?,?)',
          'a',
          parent.id,
          child.id,
        )
      )?.n,
    ).toBe(2);
    for (const list of [sourceId, destinationId]) {
      const page = await queries.listTasks(
        'a',
        { listIds: [list] },
        { today: '2026-11-02', now: clock },
      );
      expect(page.providerCoverage.complete).toBe(true);
    }
  });
  it.each(['task revision', 'captured command'] as const)(
    'does not adopt a cross-list identity after its source changes during verification: %s',
    async (change) => {
      const destinationList = { id: 'destination', title: 'destination' };
      const task = { id: 'stable-id', title: 'task', etag: 'v1' };
      lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
      taskPage = async (providerListId) => ({
        items: providerListId === defaultList.id ? [task] : [],
        nextPageToken: null,
      });
      await refresh();
      const id = await taskId(task.id);
      const sourceId = await listId();
      const destinationId = (
        await one(
          'SELECT id FROM tasks_lists WHERE account_id=? AND provider_id=?',
          'a',
          destinationList.id,
        )
      )?.id as string;
      let verified = false;
      getTask = async (providerListId) => {
        expect(providerListId).toBe(defaultList.id);
        verified = true;
        if (change === 'task revision') {
          await db
            .prepare("UPDATE tasks_tasks SET priority='high',revision=revision+1 WHERE id=?")
            .bind(id)
            .run();
        } else {
          await db.batch([
            db
              .prepare(
                "INSERT INTO tasks_command_plans(operation_id,account_id,owner_subject,request_json,capture_nonce,resource_key,total_steps,created_at) VALUES('source-command','a','owner','{}','nonce','copy:source-command',1,?)",
              )
              .bind(clock),
            db
              .prepare(
                "INSERT INTO tasks_operations(id,account_id,owner_subject,kind,resource_key,input_hash,input_json,state,created_at,updated_at) VALUES('source-command','a','owner','task.edit','copy:source-command','hash','{}','accepted',?,?)",
              )
              .bind(clock, clock),
            db
              .prepare('INSERT INTO tasks_command_resources(operation_id,list_id) VALUES(?,?)')
              .bind('source-command', sourceId),
          ]);
        }
        throw new GoogleTasksError('not_found', { status: 404 });
      };
      taskPage = async (providerListId) => ({
        items: providerListId === destinationList.id ? [{ ...task, etag: 'v2' }] : [],
        nextPageToken: null,
      });
      clock += 61_000;
      lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
      await sync.requestRefresh('a', { reason: 'entry', visibleListIds: [destinationId] });
      await sync.advance('a');
      await sync.advance('a');
      await expect(sync.advance('a')).rejects.toThrow();
      expect(verified).toBe(true);
      expect((await new TaskQueries(db).getTask('a', id)).listId).toBe(sourceId);
      expect(
        (
          await one(
            'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND provider_id=?',
            'a',
            task.id,
          )
        )?.n,
      ).toBe(1);
      expect(
        await one(
          'SELECT page_token,scan_id FROM tasks_sync_list_work WHERE account_id=? AND list_id=?',
          'a',
          destinationId,
        ),
      ).toEqual({ page_token: null, scan_id: null });
    },
  );
  it('does not merge equal titles when Google returns a different provider identity', async () => {
    const destinationList = { id: 'destination', title: 'destination' };
    const source = { id: 'source-id', title: 'same title', etag: 'source-v1' };
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    taskPage = async (providerListId) => ({
      items: providerListId === defaultList.id ? [source] : [],
      nextPageToken: null,
    });
    await refresh();
    const originalId = await taskId(source.id);
    await db
      .prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE id=?")
      .bind(originalId)
      .run();
    getTask = async () => {
      throw new GoogleTasksError('not_found', { status: 404 });
    };
    await sync.requestTaskCheck('a', originalId);
    await drain();
    clock += 61_000;
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    taskPage = async (providerListId) => ({
      items: providerListId === destinationList.id ? [{ ...source, id: 'different-id' }] : [],
      nextPageToken: null,
    });
    await refresh();
    const queries = new TaskQueries(db);
    expect(await queries.getTask('a', originalId)).toMatchObject({
      priority: 'high',
      starred: true,
      provider: { id: 'source-id' },
    });
    const newId = await taskId('different-id');
    expect(newId).not.toBe(originalId);
    expect(await queries.getTask('a', newId)).toMatchObject({
      title: source.title,
      priority: 'none',
      starred: false,
    });
  });
  it('keeps identical Google task ids separate when both list addresses still return a live task', async () => {
    const destinationList = { id: 'destination', title: 'destination' };
    const source = { id: 'shared-id', title: 'same title', etag: 'source-v1' };
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    taskPage = async (providerListId) => ({
      items: providerListId === defaultList.id ? [source] : [],
      nextPageToken: null,
    });
    await refresh();
    const originalId = await taskId(source.id);
    const sourceId = await listId();
    const destinationId = (
      await one(
        'SELECT id FROM tasks_lists WHERE account_id=? AND provider_id=?',
        'a',
        destinationList.id,
      )
    )?.id as string;
    await db
      .prepare("UPDATE tasks_tasks SET priority='high',starred=1 WHERE id=?")
      .bind(originalId)
      .run();
    getTask = async () => source;
    taskPage = async () => ({ items: [source], nextPageToken: null });
    clock += 61_000;
    lists = [{ items: [defaultList, destinationList], nextPageToken: null }];
    await refresh();
    const queries = new TaskQueries(db);
    expect(await queries.getTask('a', originalId)).toMatchObject({
      listId: sourceId,
      priority: 'high',
      starred: true,
    });
    const destination = await queries.listTasks(
      'a',
      { listIds: [destinationId] },
      { today: '2026-11-02', now: clock },
    );
    expect(destination.items).toHaveLength(1);
    expect(destination.items[0]).toMatchObject({
      title: source.title,
      priority: 'none',
      starred: false,
    });
    expect(destination.items[0]?.id).not.toBe(originalId);
    expect(
      (
        await one(
          'SELECT COUNT(*) AS n FROM tasks_tasks WHERE account_id=? AND provider_id=?',
          'a',
          source.id,
        )
      )?.n,
    ).toBe(2);
  });
  it('never adopts an exact Google task id from another account', async () => {
    await seedAccount(db, 'b', now);
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES ('foreign-list','b','foreign-provider-list','foreign')",
      )
      .run();
    const projection = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    const foreign = await projection.prepareConfirmedWrites('b', 'foreign-list', [
      { id: 'shared-id', title: 'foreign task', etag: 'foreign-v1' },
    ]);
    await db.batch(foreign.writes);
    const foreignId = foreign.taskIds.get('shared-id')!;
    await db
      .prepare("UPDATE tasks_tasks SET priority='high',starred=1,provider_missing_at=? WHERE id=?")
      .bind(clock, foreignId)
      .run();
    taskPage = async () => ({
      items: [{ id: 'shared-id', title: 'this account task', etag: 'a-v1' }],
      nextPageToken: null,
    });
    await refresh();
    const localId = await taskId('shared-id');
    expect(localId).not.toBe(foreignId);
    const queries = new TaskQueries(db);
    expect(await queries.getTask('a', localId)).toMatchObject({
      title: 'this account task',
      priority: 'none',
      starred: false,
    });
    expect(await queries.getTask('b', foreignId)).toMatchObject({
      title: 'foreign task',
      priority: 'high',
      starred: true,
      listId: 'foreign-list',
    });
    expect(calls.some((call) => call.includes('foreign-provider-list'))).toBe(false);
  });
  it('rejects a known task mapping belonging to another account', async () => {
    await refresh();
    await seedAccount(db, 'b', now);
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES ('foreign-list','b','foreign-list','foreign')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES ('foreign-task','b','foreign-list','foreign-provider','foreign')",
      )
      .run();
    const store = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    await expect(
      store.prepareConfirmedWrites('a', await listId(), [{ id: 'hijack', title: 'changed' }], {
        knownTaskIds: new Map([['hijack', 'foreign-task']]),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await one('SELECT title FROM tasks_tasks WHERE id=?', 'foreign-task'))?.title).toBe(
      'foreign',
    );
  });
  it('retains then-open children when their completion arrives in an earlier page than the parent', async () => {
    taskPage = async () => ({
      items: [
        { id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', etag: 'p1' },
        { id: 'c', title: 'child', parent: 'p', etag: 'c1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    await db
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=? WHERE id=?')
      .bind('{"kept":"rule"}', await taskId('p'))
      .run();
    taskPage = async (_listId, input) =>
      input.pageToken
        ? {
            items: [
              {
                id: 'p',
                title: 'parent',
                due: '2026-11-03T00:00:00Z',
                status: 'completed',
                etag: 'p2',
              },
            ],
            nextPageToken: null,
          }
        : {
            items: [{ id: 'c', title: 'child', parent: 'p', status: 'completed', etag: 'c2' }],
            nextPageToken: 'parent-later',
          };
    clock += 61_000;
    await refresh();
    expect((await one('SELECT COUNT(*) AS n FROM tasks_recurrence_transition_children'))?.n).toBe(
      1,
    );
    expect(
      (await one('SELECT snapshot_json FROM tasks_recurrence_transition_children'))?.snapshot_json,
    ).toContain('"completed":0');
  });
  it('captures owner completion before children change and admits recurrence only after confirmation', async () => {
    taskPage = async () => ({
      items: [
        { id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', etag: 'p1' },
        { id: 'c', title: 'child', parent: 'p', etag: 'c1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    const parent = await taskId('p');
    await db
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=? WHERE id=?')
      .bind('{"kept":"rule"}', parent)
      .run();
    const store = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    await db.batch(store.prepareCompletionCapture('a', parent, 'op', 1));
    expect((await one('SELECT state FROM tasks_recurrence_transitions'))?.state).toBe('captured');
    await db.prepare('UPDATE tasks_tasks SET completed=1 WHERE account_id=?').bind('a').run();
    await db.batch(store.prepareCompletionConfirmationWrites('a', parent, 'op'));
    expect((await one('SELECT state FROM tasks_recurrence_transitions'))?.state).toBe('pending');
    expect(
      (await one('SELECT snapshot_json FROM tasks_recurrence_transition_children'))?.snapshot_json,
    ).toContain('"completed":0');
  });
  it('reports bootstrap, ready, paused, and queued status without provider reads', async () => {
    expect(await sync.getStatus('a')).toMatchObject({
      initialized: false,
      pending: false,
      nextAttemptAt: null,
    });
    await sync.requestRefresh('a', { reason: 'entry' });
    expect(await sync.getStatus('a')).toMatchObject({
      initialized: false,
      pending: true,
      nextAttemptAt: clock,
    });
    await drain();
    expect(await sync.getStatus('a')).toMatchObject({
      initialized: true,
      pending: false,
      phase: 'idle',
    });
  });
  it('preserves assignment and explicit clears in narrow confirmed provider responses', async () => {
    taskPage = async () => ({
      items: [
        {
          id: 't',
          title: 'assigned',
          notes: 'kept',
          due: '2026-11-03T00:00:00Z',
          status: 'completed',
          completed: '2026-11-02T11:00:00Z',
          assignmentInfo: {
            surfaceType: 'DOCUMENT',
            linkToTask: 'https://docs.google.com/document/d/example',
          },
          etag: 'v1',
        },
      ],
      nextPageToken: null,
    });
    await refresh();
    const id = await taskId('t');
    const store = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    const projection = await store.prepareConfirmedWrites(
      'a',
      await listId(),
      [{ id: 't', status: 'needsAction', etag: 'v2' }],
      {
        preserveMissingFields: true,
        clearedFields: new Map([['t', new Set(['due', 'completed'] as const)]]),
      },
    );
    await db.batch(projection.writes);
    expect(await new TaskQueries(db).getTask('a', id)).toMatchObject({
      title: 'assigned',
      notes: 'kept',
      scheduledDay: null,
      completedAt: null,
      capabilities: { canEditNotes: false, canNest: false, assignmentSource: 'docs' },
    });
  });
  it('keeps SQL snapshot functions inside D1’s 32-argument limit', async () => {
    await refresh();
    const checked = {
      ...db,
      prepare(sql: string) {
        for (const match of sql.matchAll(/json_object\(/g)) {
          let depth = 1;
          let quoted = false;
          let count = 1;
          for (let index = match.index + match[0].length; index < sql.length && depth; index++) {
            const char = sql[index];
            if (char === "'") {
              if (quoted && sql[index + 1] === "'") {
                index++;
                continue;
              }
              quoted = !quoted;
            } else if (!quoted && char === '(') depth++;
            else if (!quoted && char === ')') depth--;
            else if (!quoted && depth === 1 && char === ',') count++;
          }
          expect(count).toBeLessThanOrEqual(32);
        }
        return db.prepare(sql);
      },
    } as D1Database;
    const store = new TaskProjectionStore(checked, {
      history: new HistoryService(checked, { now: () => clock }),
      now: () => clock,
    });
    const projection = await store.prepareConfirmedWrites(
      'a',
      await listId(),
      [{ id: 'new', title: 'new' }],
      { observed: true },
    );
    await checked.batch(projection.writes);
  });
  it('refreshes a definite rejected token once and retries the read in a later slice', async () => {
    let refreshed = 0;
    getList = async () => {
      throw new GoogleTasksError('reconnect_required', { status: 401 });
    };
    sync = new TaskSyncService(db, {
      clientFor: async () => reader,
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
      refreshRejectedToken: async () => {
        refreshed++;
      },
    });
    await sync.requestRefresh('a', { reason: 'entry' });
    expect(await sync.advance('a')).toMatchObject({ continued: true, phase: 'default' });
    expect(refreshed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await sync.getStatus('a')).toMatchObject({
      nextAttemptAt: clock + 1_000,
      errorCode: null,
    });
    clock += 1_001;
    await expect(sync.advance('a')).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(refreshed).toBe(1);
    expect(await sync.getStatus('a')).toMatchObject({
      pending: true,
      nextAttemptAt: null,
      errorCode: 'reconnect_required',
    });
  });
  it('gives a visible list a turn between inventory pages and does no idle account polling', async () => {
    lists = [{ items: [defaultList, { id: 'visible', title: 'visible' }], nextPageToken: null }];
    await refresh();
    calls = [];
    clock += 61_000;
    const visible = (await one('SELECT id FROM tasks_lists WHERE provider_id=?', 'visible'))
      ?.id as string;
    lists = [
      { items: [defaultList], nextPageToken: 'next-lists' },
      { items: [{ id: 'visible', title: 'visible' }], nextPageToken: null },
    ];
    await sync.requestRefresh('a', { reason: 'entry', visibleListIds: [visible] });
    await sync.advance('a');
    await sync.advance('a');
    await sync.advance('a');
    await sync.advance('a');
    expect(calls.slice(0, 4)).toEqual([
      'list:@default',
      'inventory:',
      'tasks:visible',
      'inventory:next-lists',
    ]);
    await drain();
    const before = calls.length;
    expect(await sync.advanceNext()).toMatchObject({ phase: 'idle', continued: false });
    expect(calls).toHaveLength(before);
  });
  it('captures 2,000 open checklist rows inside SQLite without materializing task objects', async () => {
    taskPage = async () => ({
      items: [{ id: 'p', title: 'parent', due: '2026-11-03T00:00:00Z', etag: 'p1' }],
      nextPageToken: null,
    });
    await refresh();
    const parent = await taskId('p');
    const list = await listId();
    await db
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=? WHERE id=?')
      .bind('{"kept":"rule"}', parent)
      .run();
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,notes) SELECT printf('child-%04d',x),'a',?,?,printf('child-provider-%04d',x),'child',? FROM n`,
      )
      .bind(list, parent, 'notes '.repeat(1_000))
      .run();
    const store = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    await db.batch(store.prepareCompletionCapture('a', parent, 'large', 1));
    expect((await one('SELECT COUNT(*) AS n FROM tasks_recurrence_transition_children'))?.n).toBe(
      2_000,
    );
  });
  it('keeps a 25-list inventory slice below the free-plan D1 invocation call bound', async () => {
    let count = 0;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (key === 'all' || key === 'first' || key === 'run')
            return (...args: unknown[]) => {
              count++;
              return Reflect.apply(
                Reflect.get(target, key) as (...args: unknown[]) => unknown,
                target,
                args,
              );
            };
          return Reflect.get(target, key);
        },
      });
    const counted = {
      ...db,
      prepare: (sql: string) => wrap(db.prepare(sql)),
      batch: (statements: D1PreparedStatement[]) => {
        count++;
        return db.batch(statements);
      },
    } as D1Database;
    sync = new TaskSyncService(counted, {
      clientFor: async () => reader,
      history: new HistoryService(counted, { now: () => clock }),
      now: () => clock,
    });
    lists = [
      {
        items: Array.from({ length: 25 }, (_, i) =>
          i === 0 ? defaultList : { id: 'list-' + i, title: 'list ' + i },
        ),
        nextPageToken: null,
      },
    ];
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.advance('a');
    count = 0;
    await sync.advance('a');
    expect(count).toBeLessThanOrEqual(35);
  });
  it('retains deeper provider hierarchy and marks both nested parents and descendants unsupported', async () => {
    taskPage = async () => ({
      items: [
        { id: 'g', title: 'grandparent', etag: 'g1' },
        { id: 'p', parent: 'g', title: 'parent', etag: 'p1' },
        { id: 'c', parent: 'p', title: 'child', etag: 'c1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    const parent = await new TaskQueries(db).getTask('a', await taskId('p'));
    const child = await new TaskQueries(db).getTask('a', await taskId('c'));
    expect(parent).toMatchObject({
      parentId: await taskId('g'),
      unsupportedHierarchy: true,
      capabilities: { canEdit: false },
    });
    expect(child).toMatchObject({
      parentId: parent.id,
      unsupportedHierarchy: true,
      capabilities: { canEdit: false },
    });
  });
  it('rotates indexed due account jobs fairly even when request timestamps tie', async () => {
    await seedAccount(db, 'b', now);
    await sync.requestRefresh('a', { reason: 'entry' });
    await sync.requestRefresh('b', { reason: 'entry' });
    expect((await sync.advanceNext()).accountId).toBe('a');
    expect((await sync.advanceNext()).accountId).toBe('b');
  });
  it('defers a tracked read while a captured command owns its list projection', async () => {
    taskPage = async () => ({
      items: [{ id: 't', title: 'task', etag: 'v1' }],
      nextPageToken: null,
    });
    await refresh();
    const task = await taskId('t');
    const list = await listId();
    await db
      .prepare(
        "INSERT INTO tasks_command_plans(operation_id,account_id,owner_subject,request_json,capture_nonce,resource_key,total_steps,created_at) VALUES('command','a','owner','{}','nonce','copy:command',1,?)",
      )
      .bind(clock)
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_operations(id,account_id,owner_subject,kind,resource_key,input_hash,input_json,state,created_at,updated_at) VALUES('command','a','owner','copy.repetition','copy:command','hash','{}','accepted',?,?)",
      )
      .bind(clock, clock)
      .run();
    await db
      .prepare('INSERT INTO tasks_command_resources(operation_id,list_id) VALUES(?,?)')
      .bind('command', list)
      .run();
    calls = [];
    await sync.requestTaskCheck('a', task);
    expect(await sync.advance('a')).toMatchObject({ phase: 'idle', continued: true });
    expect(calls).toEqual([]);
    expect((await sync.getStatus('a')).nextAttemptAt).toBe(clock + 1_000);
    await db.prepare("UPDATE tasks_operations SET state='succeeded' WHERE id='command'").run();
    clock += 1_001;
    await drain();
    expect(calls).toEqual(['task:google-default:t']);
  });
  it('revises dependants and their list projection when confirmed deletion retires an edge', async () => {
    taskPage = async () => ({
      items: [
        { id: 'blocker', title: 'blocker', etag: 'v1' },
        { id: 'waiting', title: 'waiting', etag: 'w1' },
      ],
      nextPageToken: null,
    });
    await refresh();
    const blocker = await taskId('blocker');
    const waiting = await taskId('waiting');
    const list = await listId();
    await db
      .prepare('INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES(?,?,?)')
      .bind('a', waiting, blocker)
      .run();
    const before = Number(
      (await one('SELECT projection_revision FROM tasks_lists WHERE id=?', list))
        ?.projection_revision,
    );
    const projection = new TaskProjectionStore(db, {
      history: new HistoryService(db, { now: () => clock }),
      now: () => clock,
    });
    await db.batch(projection.retireTaskWrites('a', blocker, clock));
    expect(
      (await one('SELECT graph_revision FROM tasks_account_state WHERE account_id=?', 'a'))
        ?.graph_revision,
    ).toBe(1);
    expect((await one('SELECT revision FROM tasks_tasks WHERE id=?', waiting))?.revision).toBe(2);
    expect(
      Number(
        (await one('SELECT projection_revision FROM tasks_lists WHERE id=?', list))
          ?.projection_revision,
      ),
    ).toBeGreaterThan(before);
  });
});
