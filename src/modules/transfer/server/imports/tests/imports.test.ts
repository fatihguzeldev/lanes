import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { TransferImportService } from '../imports';
import type { BeginImport } from '../../../contracts/import';
const now = Date.parse('2026-11-02T12:00:00Z'),
  id = `${now}:abcdefghijklmnop`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const manifest = (extra: Partial<BeginImport> = {}): BeginImport => ({
  id,
  accountId: 'a',
  ownerSubject: 'owner',
  source: { kind: 'file', name: 'input.csv', format: 'csv' },
  destination: { kind: 'new', boardId: 'main' },
  totalLists: 1,
  totalTasks: 2,
  issueCount: 1,
  ...extra,
});
const task = (key = 't1', extra: Record<string, unknown> = {}) => ({
  key,
  listKey: 'l1',
  parentKey: null,
  title: key,
  notes: 'exact\ntext',
  completed: false,
  completedAt: null,
  scheduledDay: null,
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  labels: [],
  priority: 'none' as const,
  starred: false,
  dependencies: [],
  order: 0,
  ...extra,
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  const service = new TransferImportService(database.db, { now: () => now });
  return { ...database, service };
}
it('stages bounded normalized chunks idempotently; preview is read only and requires every warning acceptance', async () => {
  const { db, service } = await fixture();
  await service.begin(manifest());
  const chunk = {
    lists: [{ position: 0, value: { key: 'l1', title: 'same' } }],
    tasks: [
      { position: 0, value: task() },
      { position: 1, value: task('t2', { parentKey: 't1' }) },
    ],
    issues: [
      {
        position: 0,
        value: {
          severity: 'warning' as const,
          code: 'omitted_date',
          message: 'choose whether to omit the unreadable date',
        },
      },
    ],
  };
  await service.append(id, 'a', chunk);
  await service.append(id, 'a', chunk);
  const preview = await service.sealPreview(id, 'a');
  expect(preview).toMatchObject({
    state: 'preview',
    capturedTasks: 2,
    warningCount: 1,
    subtaskCount: 1,
    requiredListSlots: 1,
  });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
  await expect(
    service.confirm(id, 'a', { previewHash: preview.previewHash!, acceptWarnings: false }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    service.append(id, 'a', { tasks: [{ position: 0, value: task('t1', { notes: 'changed' }) }] }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(service.get(id, 'other')).rejects.toMatchObject({ code: 'not_found' });
});
it('rejects invalid complete graphs, malformed fields, chunks over64KiB and missing rows before admission', async () => {
  const { db, service } = await fixture();
  await service.begin(manifest({ issueCount: 0 }));
  await expect(
    service.append(id, 'a', {
      tasks: [{ position: 0, value: task('t1', { accountId: 'foreign' }) }],
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    service.append(id, 'a', {
      tasks: [
        { position: 0, value: task('t1', { notes: '😀'.repeat(8192) }) },
        { position: 1, value: task('t2', { notes: '😀'.repeat(8192) }) },
      ],
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await service.append(id, 'a', {
    lists: [{ position: 0, value: { key: 'l1', title: 'list' } }],
    tasks: [{ position: 0, value: task('t1', { dependencies: ['t2'] }) }],
  });
  await expect(service.sealPreview(id, 'a')).rejects.toMatchObject({ code: 'conflict' });
  await service.append(id, 'a', {
    tasks: [{ position: 1, value: task('t2', { dependencies: ['t1'] }) }],
  });
  await expect(service.sealPreview(id, 'a')).rejects.toMatchObject({ code: 'validation_failed' });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
});
it('binds manifest replay and confirmation to one immutable plan and destination', async () => {
  const { service } = await fixture();
  await service.begin(manifest());
  await service.begin(manifest());
  await expect(
    service.begin(
      manifest({ destination: { kind: 'existing', listId: 'unrelated', revision: 1 } }),
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    service.begin(manifest({ source: { kind: 'account', accountId: 'a', snapshotId: 'same' } })),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    service.confirm(id, 'a', { previewHash: '0'.repeat(64), acceptWarnings: true }),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('executes admitted import parents, children and metadata via the ordinary journal; interrupted replay never recreates output', async () => {
  const { db, service: previewOnly } = await fixture();
  const { HistoryService } = await import('../../../../history/server/events/event-store');
  const { TaskProjectionStore } = await import('../../../../tasks/server/projection/store');
  const { TaskMetadataService } = await import('../../../../tasks/server/metadata/tasks');
  const { OperationStore } = await import('../../../../operations/server/journal/store');
  const { TaskCommandService } = await import('../../../../tasks/server/commands/service');
  const { GoogleTasksClient } = await import('../../../../tasks/server/provider/google-tasks');
  const operations = new OperationStore(db),
    history = new HistoryService(db, { now: () => now }),
    projection = new TaskProjectionStore(db, { history, now: () => now });
  const metadata = new TaskMetadataService(db, {
    history,
    commitWrites: async (writes) => db.batch(writes),
  });
  const calls: { method: string; url: URL; body: Record<string, unknown> }[] = [];
  let created = 0;
  const client = new GoogleTasksClient({
    accessToken: 'server-token',
    fetch: async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET',
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url, method, body });
      if (method === 'POST' && url.pathname.endsWith('/lists'))
        return Response.json({ id: 'destination-list', title: body.title, etag: 'list-version' });
      if (method === 'POST' && url.pathname.endsWith('/tasks'))
        return Response.json({
          id: 'destination-task-' + ++created,
          title: body.title,
          notes: body.notes,
          status: body.status,
          position: String(created),
          etag: 'task-version',
          ...(url.searchParams.has('parent') ? { parent: url.searchParams.get('parent') } : {}),
        });
      throw Error('unexpected provider request');
    },
  });
  const commands = new TaskCommandService(db, {
      operations,
      history,
      projection,
      metadata,
      clientFor: async () => client,
      now: () => now,
      validateBoardTarget: async () => {},
      placementWrites: () => [],
    }),
    service = new TransferImportService(db, { commands, operations, now: () => now });
  await previewOnly.begin(manifest({ issueCount: 0 }));
  await previewOnly.append(id, 'a', {
    lists: [{ position: 0, value: { key: 'l1', title: 'a new distinct list' } }],
    tasks: [
      {
        position: 0,
        value: task('t2', {
          parentKey: 't1',
          dependencies: ['t1'],
          priority: 'high',
          labels: ['home'],
        }),
      },
      { position: 1, value: task('t1', { starred: true }) },
    ],
  });
  const preview = await service.sealPreview(id, 'a');
  await service.confirm(id, 'a', { previewHash: preview.previewHash! });
  expect(calls).toEqual([]);
  for (let slice = 0; slice < 40; slice++) {
    const current = await service.advance(id, 'a');
    if (current.state === 'finished') break;
    if (slice === 3) await service.confirm(id, 'a', { previewHash: preview.previewHash! });
  }
  expect((await service.get(id, 'a')).state).toBe('finished');
  expect((await operations.get(id, 'a'))?.state).toBe('succeeded');
  expect(
    calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/tasks')),
  ).toHaveLength(2);
  expect(
    calls.find((call) => call.url.searchParams.has('parent'))?.url.searchParams.get('parent'),
  ).toBe('destination-task-1');
  const output = await service.output(id, 'a');
  expect(output.items).toHaveLength(2);
  expect(
    await db
      .prepare(
        "SELECT priority,starred,notes FROM tasks_tasks WHERE provider_id='destination-task-2'",
      )
      .first(),
  ).toMatchObject({ priority: 'high', notes: 'exact\ntext' });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_dependencies').first('n')).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM history_events WHERE kind='task_completed'")
      .first('n'),
  ).toBe(0);
  await service.advance(id, 'a');
  expect(created).toBe(2);
});
it('freezes large graphs before admission and resumes validation from bounded hash checkpoints', async () => {
  const { service, db } = await fixture();
  await service.begin(manifest({ totalTasks: 220, issueCount: 0 }));
  await service.append(id, 'a', {
    lists: [{ position: 0, value: { key: 'l1', title: 'a list' } }],
  });
  for (let offset = 0; offset < 220; offset += 10)
    await service.append(id, 'a', {
      tasks: Array.from({ length: 10 }, (_, n) => ({
        position: offset + n,
        value: task('t' + (offset + n + 1)),
      })),
    });
  let preview = await service.sealPreview(id, 'a');
  expect(preview.state).toBe('staging');
  expect(preview.validation?.checkedRecords).toBe(100);
  for (let step = 0; step < 10 && preview.state === 'staging'; step++)
    preview = await service.sealPreview(id, 'a');
  expect(preview.state).toBe('preview');
  expect(preview.validation).toMatchObject({ checkedRecords: 221, remainingGraphNodes: 0 });
  expect(await db.prepare('SELECT COUNT(*)AS n FROM tasks_operations').first('n')).toBe(0);
});
it('admits an aged recorded source under one fresh provider operation identity at explicit confirmation', async () => {
  const { db } = await fixture();
  let tick = now;
  const { OperationStore } = await import('../../../../operations/server/journal/store'),
    { TaskCommandService } = await import('../../../../tasks/server/commands/service'),
    { TaskProjectionStore } = await import('../../../../tasks/server/projection/store'),
    { HistoryService } = await import('../../../../history/server/events/event-store');
  const operations = new OperationStore(db),
    history = new HistoryService(db),
    commands = new TaskCommandService(db, {
      operations,
      history,
      projection: new TaskProjectionStore(db, { history }),
      now: () => tick,
      clientFor: async () => {
        throw Error('confirmation must not contact Google');
      },
      validateBoardTarget: async () => {},
    }),
    service = new TransferImportService(db, { commands, operations, now: () => tick });
  await service.begin(manifest({ totalTasks: 0, issueCount: 0 }));
  await service.append(id, 'a', {
    lists: [{ position: 0, value: { key: 'l1', title: 'empty distinct list' } }],
  });
  const preview = await service.sealPreview(id, 'a');
  tick += 2 * 86400000;
  await db
    .prepare("UPDATE tasks_account_state SET inventory_complete_at=?WHERE account_id='a'")
    .bind(tick)
    .run();
  const confirmed = await service.confirm(id, 'a', { previewHash: preview.previewHash! });
  expect(confirmed.operationId).not.toBe(id);
  expect((await operations.get(confirmed.operationId!, 'a'))?.state).toBe('accepted');
  expect((await service.confirm(id, 'a', { previewHash: preview.previewHash! })).operationId).toBe(
    confirmed.operationId,
  );
  expect(await db.prepare('SELECT COUNT(*)AS n FROM tasks_operations').first('n')).toBe(1);
});
