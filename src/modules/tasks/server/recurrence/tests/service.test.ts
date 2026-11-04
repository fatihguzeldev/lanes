import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDatabase, seedAccount } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import { RepeatRuleSchema } from '../../../contracts/planning';
import { TaskMetadataService } from '../../metadata/tasks';
import { OperationStore } from '../../../../operations/server/journal/store';
import { GoogleTasksClient } from '../../provider/google-tasks';
import { TaskCommandService } from '../../commands/service';
import { TaskProjectionStore } from '../../projection/store';
import { TaskSyncService } from '../../sync/service';
import { RecurrenceService } from '../service';
const now = Date.parse('2026-11-02T12:00:00Z');
const rule = RepeatRuleSchema.parse({
  frequency: 'daily',
  interval: 1,
  anchorDay: '2026-10-01',
  zone: 'Europe/Istanbul',
});
describe('completion-driven recurrence', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let clock: number;
  let projection: TaskProjectionStore;
  let service: RecurrenceService;
  let operations: OperationStore;
  let commands: TaskCommandService;
  let provider: Map<string, Record<string, unknown>>;
  let writes: { method: string; url: URL; body: Record<string, unknown> | null }[];
  let loseCreate: boolean;
  let sync: TaskSyncService;
  const db = () => fixture.db;
  const row = (sql: string, ...bindings: (string | number)[]) =>
    db()
      .prepare(sql)
      .bind(...bindings)
      .first<Record<string, unknown>>();
  beforeEach(async () => {
    fixture = testDatabase();
    clock = now;
    loseCreate = false;
    writes = [];
    provider = new Map();
    await seedAccount(db(), 'a', clock);
    await db()
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at,last_synced_at) VALUES('list','a','google-list','home',1,?,?,?)",
      )
      .bind(clock, clock, clock)
      .run();
    const history = new HistoryService(db(), { now: () => clock });
    projection = new TaskProjectionStore(db(), { history, now: () => clock });
    operations = createOperationStore(db());
    let serial = 0;
    const client = new GoogleTasksClient({
      accessToken: 'test-token',
      now: () => clock,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        if (method !== 'GET') writes.push({ method, url, body });
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        if (method === 'GET')
          return provider.has(id)
            ? Response.json(provider.get(id))
            : Response.json({ error: {} }, { status: 404 });
        if (method === 'POST' && url.pathname.endsWith('/tasks')) {
          const id = 'new-' + ++serial;
          const task: Record<string, unknown> = {
            id,
            title: '',
            status: 'needsAction',
            etag: 'etag-' + id,
            position: String(100 + serial),
            ...body,
          };
          if (task.due === null) delete task.due;
          if (url.searchParams.get('parent')) task.parent = url.searchParams.get('parent');
          provider.set(id, task);
          if (loseCreate) throw new Error('lost response');
          return Response.json(task);
        }
        if (method === 'DELETE') {
          provider.delete(id);
          for (const [key, task] of provider) if (task.parent === id) provider.delete(key);
          return new Response(null, { status: 204 });
        }
        if (method === 'PATCH') {
          const task: Record<string, unknown> = {
            ...provider.get(id),
            ...body,
            etag: 'edit-' + ++serial,
          };
          for (const key of ['due', 'completed']) if (task[key] === null) delete task[key];
          provider.set(id, task);
          return Response.json(task);
        }
        throw new Error('unexpected request');
      },
    });
    const metadata = new TaskMetadataService(db(), {
      history,
      commitWrites: async (statements) => {
        await db().batch(statements);
      },
    });
    commands = new TaskCommandService(db(), {
      operations,
      projection,
      history,
      metadata,
      now: () => clock,
      clientFor: async () => client,
    });
    sync = new TaskSyncService(db(), { clientFor: async () => client, history, now: () => clock });
    service = new RecurrenceService(db(), {
      commands,
      operations,
      ownerSubjectFor: async () => 'owner',
      now: () => clock,
      requestTaskCheck: (accountId, taskId) => sync.requestTaskCheck(accountId, taskId),
    });
  });
  afterEach(() => fixture.close());
  async function source(children = false) {
    const records = [
      {
        id: 'google-source',
        title: 'morning checklist',
        notes: 'a plain note',
        status: 'needsAction' as const,
        etag: 'source-1',
        position: '100',
        due: '2026-10-01T00:00:00Z',
      },
      ...(children
        ? [
            {
              id: 'google-child',
              title: 'open child',
              notes: 'child note',
              parent: 'google-source',
              status: 'needsAction' as const,
              etag: 'child-1',
              position: '200',
            },
            {
              id: 'google-done',
              title: 'old completed child',
              parent: 'google-source',
              status: 'completed' as const,
              etag: 'done-1',
              position: '300',
            },
          ]
        : []),
    ];
    const prepared = await projection.prepareConfirmedWrites('a', 'list', records, {
      knownTaskIds: new Map([
        ['google-source', 'source'],
        ['google-child', 'child'],
        ['google-done', 'done'],
      ]),
    });
    await db().batch(prepared.writes);
    for (const record of records) provider.set(record.id, record);
    await db()
      .prepare(
        "UPDATE tasks_tasks SET repeat_rule_json=?,scheduled_time='08:30',time_zone='Europe/Istanbul',priority='high',starred=1 WHERE id='source'",
      )
      .bind(JSON.stringify(rule))
      .run();
  }
  async function complete(id = 'source', operation = 'completion') {
    const current = await row('SELECT revision,provider_id FROM tasks_tasks WHERE id=?', id);
    await db().batch(
      projection.prepareCompletionCapture('a', id, operation, Number(current?.revision)),
    );
    await db()
      .prepare('UPDATE tasks_tasks SET completed=1,provider_etag=?,revision=revision+1 WHERE id=?')
      .bind(operation, id)
      .run();
    const address = String(current?.provider_id);
    provider.set(address, { ...provider.get(address), status: 'completed', etag: operation });
    await db().batch(projection.prepareCompletionConfirmationWrites('a', id, operation));
  }
  async function drain(limit = 100) {
    for (let i = 0; i < limit; i++) {
      const result = await service.advanceNext();
      const synced = await sync.advanceNext();
      if (!result.advanced && !synced.continued && synced.phase === 'idle') {
        const next = await row(
          'SELECT MIN(next_at) AS at FROM tasks_recurrence_occurrences WHERE next_at IS NOT NULL',
        );
        if (typeof next?.at === 'number' && next.at > clock && next.at <= clock + 5_000) {
          clock = next.at;
          continue;
        }
        return;
      }
    }
    throw new Error('recurrence did not settle');
  }

  it('exposes a retained externally paused rule without enabling it or leaking it across accounts', async () => {
    await source();
    const prepared = await projection.prepareConfirmedWrites(
      'a',
      'list',
      [
        {
          id: 'google-source',
          title: 'morning checklist',
          status: 'needsAction',
          etag: 'outside-day-removed',
        },
      ],
      { observed: true },
    );
    await db().batch(prepared.writes);
    expect(await service.status('a', 'source')).toMatchObject({
      state: 'paused',
      occurrenceId: null,
      pausedRule: { rule, reason: 'provider_day_removed', pausedAt: clock },
    });
    expect(await service.status('other-account', 'source')).toBeNull();
    expect(
      (await row('SELECT repeat_rule_json FROM tasks_tasks WHERE id=?', 'source'))
        ?.repeat_rule_json,
    ).toBeNull();
    expect(writes).toEqual([]);
    await db()
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=?,scheduled_day=? WHERE id=?')
      .bind(JSON.stringify(rule), '2026-11-03', 'source')
      .run();
    expect((await service.status('a', 'source'))?.pausedRule).toBeNull();
  });
  it('creates nothing merely because a rule date arrives', async () => {
    await source();
    await service.advanceNext();
    expect(writes).toEqual([]);
    expect((await row('SELECT COUNT(*) AS n FROM tasks_recurrence_occurrences'))?.n).toBe(0);
  });
  it('creates one successor after a confirmed late completion, preserving metadata and skipping backlog', async () => {
    await source();
    await complete();
    await drain();
    expect(await row('SELECT phase,error_code FROM tasks_recurrence_occurrences')).toMatchObject({
      error_code: null,
    });
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(writes.find((call) => call.method === 'POST')?.body).toMatchObject({
      title: 'morning checklist',
      notes: 'a plain note',
      due: '2026-11-02T00:00:00.000Z',
    });
    expect(writes.find((call) => call.method === 'POST')?.url.searchParams.get('previous')).toBe(
      'google-source',
    );
    const status = await service.status('a', 'source');
    expect(status).toMatchObject({ state: 'active', createdCount: 2 });
    expect(
      await row(
        'SELECT scheduled_time,priority,starred FROM tasks_tasks WHERE id=?',
        status!.successorTaskId!,
      ),
    ).toMatchObject({ scheduled_time: '08:30', priority: 'high', starred: 1 });
    await drain();
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('copies only then-open checklist children and remaps internal blockers while preserving external blockers', async () => {
    await source(true);
    await db()
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES('external','a','list','google-external','external')",
      )
      .run();
    await db()
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES('a','source','child'),('a','child','external')",
      )
      .run();
    await complete();
    await db().prepare("UPDATE tasks_tasks SET completed=1 WHERE id='child'").run();
    await drain();
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(2);
    const status = await service.status('a', 'source');
    const child = await row(
      'SELECT id,title FROM tasks_tasks WHERE parent_id=? AND deleted_at IS NULL',
      status!.successorTaskId!,
    );
    expect(child?.title).toBe('open child');
    expect(
      await row(
        'SELECT blocker_id FROM tasks_dependencies WHERE task_id=?',
        status!.successorTaskId!,
      ),
    ).toMatchObject({ blocker_id: child?.id });
    expect(
      await row('SELECT blocker_id FROM tasks_dependencies WHERE task_id=?', String(child?.id)),
    ).toMatchObject({ blocker_id: 'external' });
  });
  it('uses one intent when duplicate completion observations race', async () => {
    await source();
    await complete();
    await db()
      .prepare(
        "INSERT INTO tasks_recurrence_transitions(id,account_id,task_id,provider_version,kind,snapshot_json,children_complete,observed_at) SELECT 'second','a',task_id,'second','completed',snapshot_json,children_complete,observed_at FROM tasks_recurrence_transitions LIMIT 1",
      )
      .run();
    await Promise.all([service.advanceNext(), service.advanceNext()]);
    await drain();
    expect((await row('SELECT COUNT(*) AS n FROM tasks_recurrence_occurrences'))?.n).toBe(1);
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('counts only confirmed parent creations and stops at an inclusive count end', async () => {
    await source();
    await db()
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=? WHERE id=?')
      .bind(JSON.stringify({ ...rule, end: { type: 'count', count: 1 } }), 'source')
      .run();
    await complete();
    await drain();
    expect(writes).toEqual([]);
    expect(await service.status('a', 'source')).toMatchObject({
      state: 'finished',
      createdCount: 1,
    });
  });
  it('leaves an ambiguous create visibly uncertain without a second provider create', async () => {
    await source();
    await complete();
    loseCreate = true;
    await drain();
    expect(await service.status('a', 'source')).toMatchObject({
      state: 'uncertain',
      createdCount: 1,
    });
    clock += 60_000;
    await drain();
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('requires explicit one-off reopen after any successor checklist edit', async () => {
    await source(true);
    await complete();
    await drain();
    const status = await service.status('a', 'source');
    await db()
      .prepare('UPDATE tasks_tasks SET notes=?,revision=revision+1 WHERE parent_id=?')
      .bind('edited', status!.successorTaskId!)
      .run();
    expect(await service.previewReopen('a', 'source')).toMatchObject({ choices: ['one_off'] });
    expect(writes.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });
  it('removes only a confirmed untouched successor after explicit confirmation and reopens the original', async () => {
    await source(true);
    await complete();
    await drain();
    const preview = await service.previewReopen('a', 'source');
    expect(preview.choices).toContain('remove_untouched');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      operationId: now + ':reopenabcdefghijkl',
      choice: 'remove_untouched',
      confirm: true,
      token: preview.token,
    });
    await drain();
    expect(writes.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect((await row("SELECT completed FROM tasks_tasks WHERE id='source'"))?.completed).toBe(0);
    expect(await service.status('a', 'source')).toMatchObject({ state: 'active' });
  });
  it('preserves confirmed output while reconnect pauses the remaining copy', async () => {
    await source();
    await complete();
    await service.advanceNext();
    await db().prepare("UPDATE accounts_connections SET state='reconnect_required'").run();
    await drain();
    expect(await service.status('a', 'source')).toMatchObject({ state: 'paused' });
    expect((await row("SELECT completed FROM tasks_tasks WHERE id='source'"))?.completed).toBe(1);
  });
  it('cancels an unsent successor before reopening the original', async () => {
    await source();
    await complete();
    await service.advanceNext();
    const preview = await service.previewReopen('a', 'source');
    expect(preview.choices).toContain('cancel_pending');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':unsentabcdefghijkl',
      choice: 'cancel_pending',
      confirm: true,
    });
    await drain();
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect((await row("SELECT completed FROM tasks_tasks WHERE id='source'"))?.completed).toBe(0);
    expect(await service.status('a', 'source')).toMatchObject({ state: 'active', createdCount: 1 });
  });
  it('keeps an edited successor and detaches the original on explicit one-off reopen', async () => {
    await source(true);
    await complete();
    await drain();
    const before = await service.status('a', 'source');
    await db()
      .prepare('UPDATE tasks_tasks SET notes=?,revision=revision+1 WHERE parent_id=?')
      .bind('owner edit', before!.successorTaskId!)
      .run();
    const preview = await service.previewReopen('a', 'source');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':oneoffabcdefghijkl',
      choice: 'one_off',
      confirm: true,
    });
    await drain();
    expect(writes.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect(
      await row(
        "SELECT completed,repeat_rule_json,series_id,occurrence_id FROM tasks_tasks WHERE id='source'",
      ),
    ).toMatchObject({ completed: 0, repeat_rule_json: null, series_id: null, occurrence_id: null });
    expect(
      (await row('SELECT deleted_at FROM tasks_tasks WHERE id=?', before!.successorTaskId!))
        ?.deleted_at,
    ).toBeNull();
  });
  it('verifies externally edited children before undo and refuses destructive deletion', async () => {
    await source(true);
    await complete();
    await drain();
    const status = await service.status('a', 'source');
    const child = await row(
      'SELECT provider_id FROM tasks_tasks WHERE parent_id=?',
      status!.successorTaskId!,
    );
    const providerId = String(child?.provider_id);
    provider.set(providerId, {
      ...provider.get(providerId),
      notes: 'changed in google',
      etag: 'external-edit',
    });
    const preview = await service.previewReopen('a', 'source');
    expect(preview.choices).toContain('remove_untouched');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':externalabcdefghij',
      choice: 'remove_untouched',
      confirm: true,
    });
    await drain();
    expect(writes.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect((await service.previewReopen('a', 'source')).choices).toEqual(['one_off']);
  });
  it('stops unsent work if its active occurrence is deleted or its rule is cleared', async () => {
    await source();
    await complete();
    await service.advanceNext();
    await db()
      .prepare("UPDATE tasks_tasks SET repeat_rule_json=NULL,revision=revision+1 WHERE id='source'")
      .run();
    await drain();
    expect(writes).toEqual([]);
    expect(await service.status('a', 'source')).toMatchObject({
      state: 'stopped',
      createdCount: 1,
    });
  });
  it('reaches the count limit after confirmed parent creation without counting children or skipped dates', async () => {
    await source(true);
    await db()
      .prepare('UPDATE tasks_tasks SET repeat_rule_json=? WHERE id=?')
      .bind(JSON.stringify({ ...rule, end: { type: 'count', count: 2 } }), 'source')
      .run();
    await complete();
    await drain();
    const successor = (await service.status('a', 'source'))!.successorTaskId!;
    expect((await service.status('a', successor))?.createdCount).toBe(2);
    await complete(successor, 'second-completion');
    await drain();
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(await service.status('a', successor)).toMatchObject({
      state: 'finished',
      createdCount: 2,
    });
  });
  it('preserves month-end anchors and uses the rule zone when calculating the next day', async () => {
    await source();
    await db()
      .prepare('UPDATE tasks_tasks SET scheduled_day=?,repeat_rule_json=? WHERE id=?')
      .bind(
        '2026-01-31',
        JSON.stringify({ ...rule, frequency: 'monthly', anchorDay: '2026-01-31' }),
        'source',
      )
      .run();
    await complete();
    await service.advanceNext();
    expect(
      (await row('SELECT scheduled_day FROM tasks_recurrence_occurrences'))?.scheduled_day,
    ).toBe('2026-11-30');
  });
  it('captures a 2,000-child input in SQL and appends only a bounded source page', async () => {
    await source();
    await db()
      .prepare(
        `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,notes,provider_position) SELECT printf('c-%04d',x),'a','list','source',printf('gc-%04d',x),'child',?,printf('%04d',x) FROM n`,
      )
      .bind('notes '.repeat(1_000))
      .run();
    await complete();
    await service.advanceNext();
    expect((await row('SELECT COUNT(*) AS n FROM tasks_recurrence_copy_items'))?.n).toBe(2_001);
    await service.advanceNext();
    await service.advanceNext();
    expect(
      (await row('SELECT append_position FROM tasks_recurrence_occurrences'))?.append_position,
    ).toBeLessThanOrEqual(10);
    expect(writes).toEqual([]);
  });
  it('erases consumed note snapshots after confirmation while retaining undo evidence', async () => {
    await source(true);
    await complete();
    await drain();
    expect(
      (await row("SELECT COUNT(*) AS n FROM tasks_recurrence_copy_items WHERE snapshot_json<>'{}'"))
        ?.n,
    ).toBe(0);
    expect((await row('SELECT COUNT(*) AS n FROM tasks_recurrence_transition_children'))?.n).toBe(
      0,
    );
    expect((await service.previewReopen('a', 'source')).choices).toContain('remove_untouched');
  });
  it('keeps undo evidence after ordinary operation receipts expire', async () => {
    await source(true);
    await complete();
    await drain();
    clock += 91 * 86_400_000;
    await operations.cleanup(100, clock);
    expect((await service.previewReopen('a', 'source')).choices).toContain('remove_untouched');
  });
  it('admits another account’s completion between steps of an existing copy', async () => {
    await source();
    await complete();
    await service.advanceNext();
    await seedAccount(db(), 'b', clock);
    await db()
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES('list-b','b','google-list-b','other',1,?,?)",
      )
      .bind(clock, clock)
      .run();
    await db()
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,scheduled_day,repeat_rule_json,revision) SELECT 'source-b','b','list-b','google-source-b',title,scheduled_day,repeat_rule_json,1 FROM tasks_tasks WHERE id='source'",
      )
      .run();
    await db().batch(projection.prepareCompletionCapture('b', 'source-b', 'completion-b', 1));
    await db()
      .prepare("UPDATE tasks_tasks SET completed=1,revision=revision+1 WHERE id='source-b'")
      .run();
    await db().batch(
      projection.prepareCompletionConfirmationWrites('b', 'source-b', 'completion-b'),
    );
    await service.advanceNext();
    await service.advanceNext();
    expect(
      (await row("SELECT COUNT(*) AS n FROM tasks_recurrence_occurrences WHERE account_id='b'"))?.n,
    ).toBe(1);
  });
  it('coalesces expired overlapping recurrence claims into the same captured copy', async () => {
    await source();
    await complete();
    await service.advanceNext();
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wrapped = new Proxy(commands, {
      get(target, key) {
        if (key === 'beginCapturedCopy')
          return async (...args: Parameters<TaskCommandService['beginCapturedCopy']>) => {
            if (++calls === 1) await gate;
            return target.beginCapturedCopy(...args);
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const overlap = new RecurrenceService(db(), {
      commands: wrapped,
      operations,
      ownerSubjectFor: async () => 'owner',
      now: () => clock,
    });
    const first = overlap.advanceNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock += 46_000;
    await service.advanceNext();
    release();
    await first;
    await drain();
    expect((await row('SELECT COUNT(*) AS n FROM tasks_recurrence_occurrences'))?.n).toBe(1);
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('refuses deletion when metadata changes after undo was admitted', async () => {
    await source(true);
    await complete();
    await drain();
    const status = await service.status('a', 'source');
    const preview = await service.previewReopen('a', 'source');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':lateeditabcdefghij',
      choice: 'remove_untouched',
      confirm: true,
    });
    for (let i = 0; i < 30; i++) {
      await service.advanceNext();
      await sync.advanceNext();
      clock += 1_001;
      if ((await row('SELECT phase FROM tasks_recurrence_occurrences'))?.phase === 'undo_delete')
        break;
    }
    expect((await row('SELECT phase FROM tasks_recurrence_occurrences'))?.phase).toBe(
      'undo_delete',
    );
    await db()
      .prepare('UPDATE tasks_tasks SET priority=?,revision=revision+1 WHERE parent_id=?')
      .bind('high', status!.successorTaskId!)
      .run();
    await service.advanceNext();
    expect(writes.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect((await service.previewReopen('a', 'source')).choices).toEqual(['one_off']);
  });
  it('keeps an ambiguous successor visible after reopening the original as a one-off', async () => {
    await source();
    await complete();
    loseCreate = true;
    await drain();
    loseCreate = false;
    const preview = await service.previewReopen('a', 'source');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':unknownabcdefghijk',
      choice: 'one_off',
      confirm: true,
    });
    await drain();
    expect(
      await row("SELECT completed,repeat_rule_json FROM tasks_tasks WHERE id='source'"),
    ).toMatchObject({ completed: 0, repeat_rule_json: null });
    expect(await service.status('a', 'source')).toMatchObject({
      state: 'uncertain',
      createdCount: 1,
      errorCode: 'outcome_uncertain',
    });
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(writes.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });
  it('binds a reopen operation identity to the exact canonical choice and input', async () => {
    await source();
    await complete();
    await drain();
    const preview = await service.previewReopen('a', 'source');
    const input = {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':canonicalabcdefghi',
      choice: 'one_off' as const,
      confirm: true as const,
    };
    await service.requestReopen('a', 'owner', input);
    await expect(
      service.requestReopen('a', 'owner', { ...input, revision: input.revision + 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('does not reuse an ordinary command identity for a different reopen action', async () => {
    await source();
    await complete();
    await drain();
    const preview = await service.previewReopen('a', 'source');
    const copy = await service.status('a', 'source');
    await expect(
      service.requestReopen('a', 'owner', {
        taskId: 'source',
        revision: preview.revision,
        token: preview.token,
        operationId: copy!.operationId!,
        choice: 'one_off',
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('attaches a manually resolved late create receipt without sending another create', async () => {
    await source();
    await complete();
    loseCreate = true;
    await drain();
    loseCreate = false;
    const copyId = (await service.status('a', 'source'))!.operationId!;
    const preview = await service.previewReopen('a', 'source');
    await service.requestReopen('a', 'owner', {
      taskId: 'source',
      revision: preview.revision,
      token: preview.token,
      operationId: now + ':lateresolveabcdefg',
      choice: 'one_off',
      confirm: true,
    });
    await drain();
    const step = await operations.getStep(copyId, 'copy.task:i0');
    await operations.recordResponse(
      copyId,
      'copy.task:i0',
      step!.claimId!,
      provider.get('new-1'),
      clock,
    );
    clock += 31_000;
    await commands.advance('a', copyId);
    await service.resume('a', 'source');
    expect(await service.status('a', 'source')).toMatchObject({
      state: 'active',
      createdCount: 2,
      checklistComplete: false,
    });
    expect(writes.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
