import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { WorkspaceArchiveStore } from '../archive-store';
import { TransferImportService } from '../../imports/imports';
import { ArchiveSnapshotCopyService } from '../archive-copy';
const now = Date.parse('2026-11-02T12:00:00Z'),
  archiveId = `${now}:abcdefghijklmnop`,
  copyId = `${now}:abcdefghijklmnop2`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
it('copies captured snapshots through ordinary normalized import and leaves historical actions on the original identities', async () => {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  const store = new WorkspaceArchiveStore(database.db, {
      now: () => now,
      identity: async () => ({
        googleSubject: 'different-destination-subject',
        email: 'a@example.com',
        planningZone: 'UTC',
        weekStart: 1,
      }),
    }),
    imports = new TransferImportService(database.db, { now: () => now }),
    service = new ArchiveSnapshotCopyService(database.db, { store, imports });
  const header = {
    format: 'lanes-workspace',
    version: 1,
    id: 'abcdefghijklmnop',
    generatedAt: new Date(now).toISOString(),
    source: {
      googleSubject: 'source-subject',
      email: 'source@example.com',
      planningZone: 'UTC',
      weekStart: 1,
    },
    scope: { kind: 'account' },
    includesTaskSnapshots: true,
    generationNote:
      'paginated retained projections; provider changes can produce a mixed-time export.',
  };
  const records = [
    {
      kind: 'board',
      key: 'sourceboard',
      title: 'home',
      isMain: true,
      emoji: null,
      color: '#fff',
      backgroundUrl: null,
      position: 0,
      revision: 0,
    },
    {
      kind: 'list',
      key: 'sourcelist',
      boardKey: 'sourceboard',
      providerId: 'old-list-provider',
      title: 'source list',
      color: '#fff',
      position: 0,
      revision: 1,
      membershipRevision: 1,
    },
    {
      kind: 'task',
      key: 'sourcetask',
      listKey: 'sourcelist',
      parentKey: null,
      provider: { id: 'old-task-provider', listId: 'old-list-provider', etag: null },
      revision: 1,
      scheduledDay: null,
      scheduledTime: null,
      timeZone: null,
      repeatRule: null,
      labels: [{ key: 'oldlabel', name: 'home', color: '#123456' }],
      priority: 'high',
      starred: true,
      dependencies: [
        {
          key: 'outside',
          provider: { id: 'outside-provider', listId: 'outside-list', etag: null },
        },
      ],
      order: 0,
      snapshot: {
        title: '= exact source',
        notes: 'a\nplain note',
        completed: true,
        completedAt: null,
      },
    },
  ];
  await store.begin({
    id: archiveId,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'copy_task_snapshots',
    header: header as never,
    recordCount: records.length,
  });
  await store.append(
    archiveId,
    'a',
    records.map((value, position) => ({ value, position })),
  );
  await store.seal(archiveId, 'a');
  await service.begin(archiveId, 'a', {
    id: copyId,
    ownerSubject: 'owner',
    destination: { kind: 'new', boardId: 'destination-board' },
  });
  let summary = await imports.get(copyId, 'a');
  for (let n = 0; n < 10 && summary.state === 'staging'; n++)
    summary = await service.captureNext(copyId, 'a');
  expect(summary).toMatchObject({
    state: 'preview',
    completedCount: 1,
    warningCount: 1,
    totalTasks: 1,
  });
  const rows = await imports.readPreviewRecords(copyId, 'a', { kind: 'task' });
  expect(rows.items[0]?.value).toMatchObject({
    key: 't1',
    title: '= exact source',
    notes: 'a\nplain note',
    completed: true,
    completedAt: null,
    priority: 'high',
    starred: true,
    dependencies: [],
  });
  expect(await database.db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n')).toBe(0);
  expect(await database.db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(
    0,
  );
});
