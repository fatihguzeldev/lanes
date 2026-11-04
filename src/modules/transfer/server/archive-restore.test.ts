import { afterEach, expect, it, vi } from 'vitest';
import { testDatabase, seedAccount } from '../../../../tests/sqlite-d1';
import { AccountsPortability } from '../../accounts/portability';
import { BoardService } from '../../boards/server';
import { HistoryService } from '../../history/server';
import { TaskQueries } from '../../tasks/server/queries/tasks';
import { TaskMetadataService } from '../../tasks/server/metadata';
import { TaskSnapshotReader } from '../../tasks/server/queries/snapshot-reader';
import { TaskProjectionStore } from '../../tasks/server/projection';
import { TaskCommandService } from '../../tasks/server/commands/provider-commands';
import { OperationStore } from '../../tasks/server/operations';
import { WorkspaceArchiveStore } from './archive-store';
import { ArchiveRestoreService } from './archive-restore';
import { createTemplateOwners } from '../../../worker/template-services';
import { TemplateDocumentStore } from '../../tasks/server/template-documents';
const now = Date.parse('2026-11-02T12:00:00Z'),
  id = `${now}:abcdefghijklmnop`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const header = {
  format: 'lanes-workspace' as const,
  version: 1 as const,
  id: 'abcdefghijklmnop',
  generatedAt: new Date(now).toISOString(),
  source: {
    googleSubject: 'subject-a',
    email: 'a@example.com',
    planningZone: 'Europe/Istanbul',
    weekStart: 1 as const,
  },
  scope: { kind: 'account' as const },
  includesTaskSnapshots: false,
  generationNote:
    'paginated retained projections; provider changes can produce a mixed-time export.' as const,
};
const records = [
  {
    kind: 'board',
    key: 'b1',
    title: 'source board',
    isMain: true,
    emoji: null,
    color: '#abc',
    backgroundUrl: null,
    position: 0,
    revision: 0,
  },
  {
    kind: 'list',
    key: 'l1',
    boardKey: 'b1',
    providerId: 'google-list',
    title: 'title is not identity',
    color: '#abc',
    position: 0,
    revision: 1,
    membershipRevision: 0,
  },
  {
    kind: 'task',
    key: 't1',
    listKey: 'l1',
    parentKey: null,
    provider: { id: 'google-task', listId: 'google-list', etag: 'etag' },
    revision: 1,
    scheduledDay: '2026-11-03',
    scheduledTime: null,
    timeZone: null,
    repeatRule: null,
    labels: [],
    priority: 'high',
    starred: true,
    dependencies: [],
    order: 0,
  },
];
it('rolls back a failed local restore commit and retries its same unfinished action after backoff and payload cleanup', async () => {
  let clock = now;
  const f = await fixture(records, () => clock);
  for (let n = 0; n < records.length; n++) await f.service.previewNext(id, 'a');
  await f.service.choose(id, 'a', [{ key: 'b1', fields: ['appearance'] }]);
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  const original = f.db.batch.bind(f.db);
  let fail = true;
  vi.spyOn(f.db, 'batch').mockImplementation(async (statements) => {
    const sql = (statements as unknown as { sql: string }[]).map((statement) => statement.sql);
    if (
      fail &&
      sql.some((query) => query.includes('UPDATE boards_boards SET')) &&
      sql.some((query) => query.includes("state='confirmed'"))
    ) {
      fail = false;
      return original([
        ...statements,
        f.db.prepare('INSERT INTO tasks_write_guards(valid) VALUES(0)'),
      ]);
    }
    return original(statements);
  });
  await expect(f.service.advance(id, 'a')).rejects.toMatchObject({
    code: 'storage_unavailable',
    retryable: true,
  });
  expect(fail).toBe(false);
  expect(
    await f.db
      .prepare('SELECT color,revision FROM boards_boards WHERE id=?')
      .bind(f.main.id)
      .first(),
  ).toEqual({ color: f.main.color, revision: f.main.revision });
  const action = await f.db
    .prepare("SELECT operation_id,state FROM transfer_archive_actions WHERE phase='appearance'")
    .first<{ operation_id: string; state: string }>();
  expect(action?.state).toBe('pending');
  expect(await f.operations.summary(action!.operation_id, 'a')).toMatchObject({
    state: 'partial',
    finished: false,
    confirmedSteps: 0,
    nextAttemptAt: clock + 5000,
  });
  expect(await f.operations.getStep(action!.operation_id, 'restore')).toMatchObject({
    state: 'accepted',
    response: null,
  });
  clock += 86400000;
  expect(await f.operations.pruneTerminalPayloads(100, clock)).toBe(0);
  expect((await f.operations.get(action!.operation_id, 'a'))?.input).toMatchObject({
    kind: 'archive.restore.board.update',
  });
  await f.service.resume(id, 'a');
  let finished = false;
  for (let n = 0; n < 10 && !finished; n++)
    finished = (await f.service.advance(id, 'a')).state === 'finished';
  expect(finished).toBe(true);
  expect(
    await f.db
      .prepare('SELECT color,revision FROM boards_boards WHERE id=?')
      .bind(f.main.id)
      .first(),
  ).toEqual({ color: '#abc', revision: f.main.revision + 1 });
  expect(await f.operations.summary(action!.operation_id, 'a')).toMatchObject({
    state: 'succeeded',
    finished: true,
    confirmedSteps: 1,
  });
  expect(
    await f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks_operations WHERE kind='archive.restore.board.update'",
      )
      .first('n'),
  ).toBe(1);
});
it('keeps a definitive local revision conflict terminal without replacing newer board values', async () => {
  const f = await fixture();
  for (let n = 0; n < records.length; n++) await f.service.previewNext(id, 'a');
  await f.service.choose(id, 'a', [{ key: 'b1', fields: ['appearance'] }]);
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  await f.db
    .prepare("UPDATE boards_boards SET color='#def',revision=revision+1 WHERE id=?")
    .bind(f.main.id)
    .run();
  await expect(f.service.advance(id, 'a')).rejects.toMatchObject({
    code: 'conflict',
    retryable: false,
  });
  expect(
    await f.db
      .prepare(
        "SELECT state,terminal_at IS NOT NULL AS finished FROM tasks_operations WHERE kind='archive.restore.board.update'",
      )
      .first(),
  ).toEqual({ state: 'failed', finished: 1 });
  expect(
    await f.db.prepare('SELECT color FROM boards_boards WHERE id=?').bind(f.main.id).first('color'),
  ).toBe('#def');
});
async function fixture(sourceRecords: unknown[] = records, clock = () => now) {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  await seedAccount(db, 'a', now);
  const boards = new BoardService(db, { assertLocalWritable: async () => {} }),
    main = await boards.ensureMainBoard('a');
  await db
    .prepare(
      "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at)VALUES('list','a','google-list','retained title',1,?,?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO boards_memberships(account_id,list_id,board_id,position)VALUES('a','list',?,0)",
    )
    .bind(main.id)
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,notes,scheduled_day,revision)VALUES('task','a','list','google-task','same title','source notes','2026-11-03',1)",
    )
    .run();
  const accounts = new AccountsPortability(db),
    store = new WorkspaceArchiveStore(db, {
      identity: (account) => accounts.identity(account),
      now: () => now,
    }),
    history = new HistoryService(db, { now: () => now }),
    operations = new OperationStore(db),
    queries = new TaskQueries(db),
    snapshotReader = new TaskSnapshotReader(db);
  const commands = new TaskCommandService(db, {
    operations,
    history,
    projection: new TaskProjectionStore(db, { history }),
    metadata: new TaskMetadataService(db, { history, commitWrites: (writes) => db.batch(writes) }),
    now: clock,
    clientFor: async () => {
      throw Error('metadata restore must not request Google credentials');
    },
  });
  const service = new ArchiveRestoreService(db, {
    store,
    accounts,
    queries,
    snapshotReader,
    commands,
    operations,
    boards,
    history,
    now: clock,
    ownerFactory: (commitWrites) => {
      const templates = createTemplateOwners(
        db,
        { boards, commands, operations, ownerSubjectFor: async () => 'owner' },
        commitWrites,
      );
      return {
        ...templates,
        documents: new TemplateDocumentStore(db, { snapshots: templates.snapshots, commitWrites }),
        boards: new BoardService(db, { assertLocalWritable: async () => {}, commitWrites }),
        metadata: new TaskMetadataService(db, { history, commitWrites }),
      };
    },
  });
  await store.begin({
    id,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'restore_metadata',
    header,
    recordCount: sourceRecords.length,
  });
  for (let offset = 0; offset < sourceRecords.length; offset += 10)
    await store.append(
      id,
      'a',
      sourceRecords
        .slice(offset, offset + 10)
        .map((value, position) => ({ value, position: offset + position })),
    );
  for (let attempt = 0; attempt < 1000; attempt++)
    if ((await store.seal(id, 'a')).state === 'preview') break;
  return { ...database, service, store, queries, operations, main };
}
it('drains cancelled local actions across bounded replays and background advances without resetting cancellation time', async () => {
  let clock = now;
  const f = await fixture(records, () => clock);
  for (let index = 0; index < 12; index++) {
    const operationId = `${now}:cancelaction${String(index).padStart(5, '0')}`;
    if (index !== 1) {
      await f.operations.admit(
        {
          id: operationId,
          accountId: 'a',
          ownerSubject: 'owner',
          kind: 'archive.restore.local',
          resourceKey: `archive:${id}:${index}`,
          input: {},
          steps: [{ key: 'restore', kind: 'local', input: {} }],
        },
        now,
      );
      if (index === 0) {
        await f.operations.claimNext(operationId, 'worker', now);
        await f.operations.commitLocalStep(operationId, 'restore', 'worker', {}, [], now);
      }
    }
    await f.db
      .prepare(
        'INSERT INTO transfer_archive_actions(archive_id,item_key,phase,operation_id,input_json)VALUES(?,?,?,?,?)',
      )
      .bind(id, 'item' + String(index).padStart(2, '0'), 'local', operationId, '{}')
      .run();
  }
  const pending = () =>
    f.db
      .prepare(
        "SELECT COUNT(*)AS n FROM transfer_archive_actions WHERE archive_id=? AND state='pending'",
      )
      .bind(id)
      .first('n');
  expect((await f.service.cancel(id, 'a')).state).toBe('cancelled');
  expect(await pending()).toBe(7);
  expect(
    await f.db
      .prepare('SELECT finished_at FROM transfer_archives WHERE id=?')
      .bind(id)
      .first('finished_at'),
  ).toBe(now);
  clock += 60000;
  expect((await f.service.advanceNext())?.state).toBe('cancelled');
  expect(await pending()).toBe(2);
  expect((await f.service.advance(id, 'a')).state).toBe('cancelled');
  expect(await pending()).toBe(0);
  expect(await f.service.advanceNext()).toBe(null);
  expect(
    await f.db
      .prepare('SELECT finished_at FROM transfer_archives WHERE id=?')
      .bind(id)
      .first('finished_at'),
  ).toBe(now);
  expect(
    await f.db
      .prepare('SELECT COUNT(*)AS n FROM tasks_operations WHERE terminal_at IS NULL')
      .first('n'),
  ).toBe(0);
  expect(await f.queries.getTask('a', 'task')).toMatchObject({ priority: 'none', starred: false });
});
it('keeps unresolved issued actions pending when a cancelled restore is drained again', async () => {
  const f = await fixture(),
    operationId = `${now}:unresolvedaction1`;
  await f.operations.admit(
    {
      id: operationId,
      accountId: 'a',
      ownerSubject: 'owner',
      kind: 'archive.restore.local',
      resourceKey: 'archive:' + id,
      input: {},
      steps: [{ key: 'restore', kind: 'local', input: {} }],
    },
    now,
  );
  await f.operations.claimNext(operationId, 'worker', now);
  await f.operations.markDispatched(operationId, 'restore', 'worker', now);
  await f.db
    .prepare(
      'INSERT INTO transfer_archive_actions(archive_id,item_key,phase,operation_id,input_json)VALUES(?,?,?,?,?)',
    )
    .bind(id, 'unresolved', 'local', operationId, '{}')
    .run();
  await f.service.cancel(id, 'a');
  await f.service.advanceNext();
  expect(
    await f.db
      .prepare('SELECT state FROM transfer_archive_actions WHERE archive_id=?')
      .bind(id)
      .first('state'),
  ).toBe('pending');
  expect(await f.operations.get(operationId, 'a')).toMatchObject({
    finished: false,
    cancelRequested: true,
  });
  expect((await f.operations.getStep(operationId, 'restore'))?.state).toBe('dispatched');
});
it('previews exact provider matches without writes and preserves all conflicting current values by default', async () => {
  const f = await fixture();
  for (let n = 0; n < records.length; n++) await f.service.previewNext(id, 'a');
  const preview = await f.service.preview(id, 'a');
  expect(preview.pendingMatches).toBe(0);
  expect(preview.conflicts).toBeGreaterThan(0);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  for (let n = 0; n < 10; n++) if ((await f.service.advance(id, 'a')).state === 'finished') break;
  expect(await f.queries.getTask('a', 'task')).toMatchObject({
    priority: 'none',
    starred: false,
    notes: 'source notes',
  });
  expect(
    (await new BoardService(f.db, { assertLocalWritable: async () => {} }).getMainBoard('a')).title,
  ).toBe('everyday');
});
it('applies explicitly selected local fields through the common task journal and never changes provider content', async () => {
  const f = await fixture();
  for (let n = 0; n < records.length; n++) await f.service.previewNext(id, 'a');
  await f.service.choose(id, 'a', [{ key: 't1', fields: ['priority', 'starred'] }]);
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  for (let n = 0; n < 20; n++) if ((await f.service.advance(id, 'a')).state === 'finished') break;
  expect(await f.queries.getTask('a', 'task')).toMatchObject({
    title: 'same title',
    notes: 'source notes',
    priority: 'high',
    starred: true,
    scheduledDay: '2026-11-03',
  });
  expect(
    (await f.operations.list('a', {})).items.some((operation) => operation.state === 'succeeded'),
  ).toBe(true);
});
it('shows unmatched equal titles and rejects a stale selected metadata revision', async () => {
  const f = await fixture();
  for (let n = 0; n < records.length; n++) await f.service.previewNext(id, 'a');
  await f.service.choose(id, 'a', [{ key: 't1', fields: ['priority'] }]);
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  await f.db
    .prepare("UPDATE tasks_tasks SET revision=revision+1,priority='low'WHERE id='task'")
    .run();
  await expect(f.service.advance(id, 'a')).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.queries.getTask('a', 'task')).toMatchObject({ priority: 'low' });
});
it('preserves restored history identity/time while applying normal retention and no copy completion events', async () => {
  const event = (key: string, recordedAt: string) => ({
    kind: 'history',
    key,
    event: {
      id: key + '-original',
      schemaVersion: 1,
      accountId: 'a1',
      taskId: 't1',
      listId: 'l1',
      kind: 'task_created',
      origin: 'owner',
      dedupKey: key + '-dedup',
      recordedAt,
      providerAt: null,
      taskTitle: 'old task title',
      listTitle: 'old list title',
      summary: { source: 'direct', operationId: 'old-operation', stepKey: 'created' },
    },
  });
  const source = [
      ...records,
      event('recent', '2026-10-02T00:00:00Z'),
      event('expired', '2026-01-01T00:00:00Z'),
    ],
    f = await fixture(source);
  for (let n = 0; n < source.length; n++) await f.service.previewNext(id, 'a');
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  for (let n = 0; n < 20; n++) if ((await f.service.advance(id, 'a')).state === 'finished') break;
  expect(
    await f.db
      .prepare(
        "SELECT id,task_id,list_id,recorded_at FROM history_events WHERE id='recent-original'",
      )
      .first(),
  ).toEqual({
    id: 'recent-original',
    task_id: 'task',
    list_id: 'list',
    recorded_at: Date.parse('2026-10-02T00:00:00Z'),
  });
  expect(
    await f.db
      .prepare("SELECT COUNT(*) AS n FROM history_events WHERE id='expired-original'")
      .first('n'),
  ).toBe(0);
  expect(
    await f.db
      .prepare("SELECT COUNT(*) AS n FROM history_events WHERE kind='task_completed'")
      .first('n'),
  ).toBe(0);
});
it('restores declarative template bodies and schedule definitions through their owners with schedules paused', async () => {
  const source = [
    ...records,
    {
      kind: 'template',
      key: 'tpl1',
      templateKind: 'list',
      name: 'a captured template',
      description: 'exact reusable content',
      contentRevision: 1,
      header: {
        schemaVersion: 1,
        dateMode: 'none',
        saveDay: '2026-11-02',
        zone: 'UTC',
        listCount: 1,
        taskCount: 1,
        contextParentCount: 0,
        completedIncludedCount: 0,
        omittedDependencyCount: 0,
      },
    },
    {
      kind: 'template_list',
      key: 'tl1',
      templateKey: 'tpl1',
      value: { key: 'inside-list', title: 'template list', color: '#abc', position: 0 },
    },
    {
      kind: 'template_task',
      key: 'tt1',
      templateKey: 'tpl1',
      value: {
        key: 'inside-task',
        listKey: 'inside-list',
        parentKey: null,
        position: 0,
        title: '= exact text',
        notes: 'a\nplain note',
        dayOffset: null,
        scheduledTime: null,
        timeZone: null,
        repeatPreset: null,
        labels: [],
        priority: 'high',
        starred: true,
        dependencyKeys: [],
      },
    },
    {
      kind: 'schedule',
      key: 's1',
      templateKey: 'tpl1',
      templateKind: 'list',
      boardKey: 'b1',
      timing: { frequency: 'weekly', weekday: 1, zone: 'UTC', startsOn: '2026-11-02' },
      useRelativeDates: true,
      listPrefix: 'weekly ',
      wasActive: true,
    },
  ];
  const f = await fixture(source);
  for (let n = 0; n < source.length; n++) await f.service.previewNext(id, 'a');
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  let state = '';
  for (let n = 0; n < 40; n++) {
    state = (await f.service.advance(id, 'a')).state;
    if (state === 'finished') break;
  }
  expect(state).toBe('finished');
  expect(await f.db.prepare('SELECT name,description FROM tasks_list_templates').first()).toEqual({
    name: 'a captured template',
    description: 'exact reusable content',
  });
  expect(
    await f.db.prepare('SELECT content_json FROM tasks_template_nodes').first('content_json'),
  ).toContain('a\\nplain note');
  expect(
    await f.db
      .prepare('SELECT state,next_run_at,pause_reason FROM boards_template_schedules')
      .first(),
  ).toEqual({ state: 'paused', next_run_at: null, pause_reason: 'imported' });
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(1);
});

it('keeps a large template prepared across dependency checkpoints and installs only the fully validated owner snapshot', async () => {
  const count = 120;
  const source = [
    ...records,
    {
      kind: 'template',
      key: 'tpl1',
      templateKind: 'list',
      name: 'checkpointed chain',
      description: 'all captured tasks',
      contentRevision: 1,
      header: {
        schemaVersion: 1,
        dateMode: 'none',
        saveDay: '2026-11-02',
        zone: 'UTC',
        listCount: 1,
        taskCount: count,
        contextParentCount: 0,
        completedIncludedCount: 0,
        omittedDependencyCount: 0,
      },
    },
    {
      kind: 'template_list',
      key: 'tl1',
      templateKey: 'tpl1',
      value: { key: 'inside-list', title: 'all tasks', color: '#abc', position: 0 },
    },
    ...Array.from({ length: count }, (_, n) => ({
      kind: 'template_task',
      key: 'tt' + n,
      templateKey: 'tpl1',
      value: {
        key: 'inside-' + n,
        listKey: 'inside-list',
        parentKey: null,
        position: n,
        title: 'task ' + n,
        notes: 'note ' + n,
        dayOffset: null,
        scheduledTime: null,
        timeZone: null,
        repeatPreset: null,
        labels: [],
        priority: 'none',
        starred: false,
        dependencyKeys: n ? ['inside-' + (n - 1)] : [],
      },
    })),
  ];
  const f = await fixture(source);
  for (let n = 0; n < source.length; n++) await f.service.previewNext(id, 'a');
  const preview = await f.service.preview(id, 'a');
  await f.service.confirm(id, 'a', {
    previewHash: preview.archive.previewHash!,
    revision: preview.archive.revision,
  });
  let sawPending = false,
    finished = false;
  for (let n = 0; n < 300 && !finished; n++) {
    const result = await f.service.advance(id, 'a');
    finished = result.state === 'finished';
    const validation = await f.db
      .prepare('SELECT stage FROM tasks_template_validation')
      .first<{ stage: string }>();
    if (validation && validation.stage !== 'ready') {
      sawPending = true;
      expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_list_templates').first('n')).toBe(
        0,
      );
      expect(
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM transfer_archive_actions WHERE phase='seal' AND state='confirmed'",
          )
          .first('n'),
      ).toBe(0);
      expect(
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks_operations WHERE kind='archive.restore.document.seal'",
          )
          .first('n'),
      ).toBe(0);
    }
  }
  expect(sawPending).toBe(true);
  expect(finished).toBe(true);
  expect(
    await f.db
      .prepare('SELECT task_count FROM tasks_template_snapshots WHERE sealed=1')
      .first('task_count'),
  ).toBe(count);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_template_nodes').first('n')).toBe(
    count,
  );
  expect(
    await f.db
      .prepare(
        "SELECT json_extract(content_json,'$.notes') AS note FROM tasks_template_nodes WHERE item_key='inside-119'",
      )
      .first('note'),
  ).toBe('note 119');
  expect(
    await f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks_operations WHERE kind='archive.restore.document.seal' AND state='succeeded'",
      )
      .first('n'),
  ).toBe(1);
});
