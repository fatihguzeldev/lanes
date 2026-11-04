import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { TaskSnapshotReader } from '../../tasks/server/queries/snapshot-reader';
import { OperationStore } from '../../operations/server/journal/store';
import { TransferImportService } from './imports';
import { TransferLifecycle } from './lifecycle';
const now = Date.parse('2026-11-02T12:00:00Z'),
  id = `${now}:abcdefghijklmnop`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  const imports = new TransferImportService(database.db, { now: () => now });
  await imports.begin({
    id,
    ownerSubject: 'owner',
    accountId: 'a',
    source: { kind: 'file', name: 'tasks.csv', format: 'csv' },
    destination: { kind: 'new', boardId: 'main' },
    totalLists: 1,
    totalTasks: 120,
  });
  await imports.append(id, 'a', {
    lists: [{ position: 0, value: { key: 'l1', title: 'a list' } }],
  });
  for (let offset = 0; offset < 120; offset += 10)
    await imports.append(id, 'a', {
      tasks: Array.from({ length: 10 }, (_, index) => ({
        position: offset + index,
        value: {
          key: 't' + (offset + index + 1),
          listKey: 'l1',
          parentKey: null,
          title: 'task',
          notes: 'retained note',
          completed: false,
          completedAt: null,
          labels: [],
          priority: 'none',
          starred: false,
          dependencies: [],
          order: offset + index,
        },
      })),
    });
  const operations = new OperationStore(database.db),
    snapshots = new TaskSnapshotReader(database.db);
  const lifecycle = new TransferLifecycle(database.db, { operations, snapshots, now: () => now });
  return { ...database, imports, lifecycle, operations };
}
it('pauses owner work without provider access and removes children before parents within the exact actual-row budget', async () => {
  const f = await fixture();
  await expect(f.lifecycle.pause('a')).rejects.toThrow();
  await f.db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
  expect(await f.lifecycle.pause('a')).toEqual({ done: true, pending: false });
  expect(await f.imports.get(id, 'a')).toMatchObject({ paused: true, state: 'staging' });
  await expect(f.lifecycle.remove('a', 100)).rejects.toThrow();
  await f.db
    .prepare(
      "UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='a'",
    )
    .run();
  let total = 0;
  for (let turn = 0; turn < 10; turn++) {
    const before = Number(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n);
    const result = await f.lifecycle.remove('a', 100);
    const changed = Number(f.sqlite.prepare('SELECT total_changes() AS n').get()?.n) - before;
    expect(changed).toBe(result.deleted);
    expect(result.deleted).toBeLessThanOrEqual(100);
    total += result.deleted;
    if (result.done) break;
  }
  expect(total).toBe(122);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_imports').first('n')).toBe(0);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts_connections').first('n')).toBe(1);
});
it('retains transfer evidence when the shared provider journal still has an unresolved issued outcome', async () => {
  const f = await fixture();
  await f.operations.admit(
    {
      id: now + ':uncertainabcdefghi',
      accountId: 'a',
      ownerSubject: 'owner',
      kind: 'test',
      resourceKey: 'x',
      input: {},
      steps: [{ key: 'sent', kind: 'task.create', input: {} }],
    },
    now,
  );
  await f.operations.claimNext(now + ':uncertainabcdefghi', 'claim', now);
  await f.operations.markDispatched(now + ':uncertainabcdefghi', 'sent', 'claim', now);
  await f.operations.rejectStep(
    now + ':uncertainabcdefghi',
    'sent',
    'claim',
    { code: 'outcome_uncertain', definitelyRejected: false },
    now,
  );
  await f.db
    .prepare(
      "UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='a'",
    )
    .run();
  expect(await f.lifecycle.hasUnresolved('a')).toBe(true);
  await expect(f.lifecycle.remove('a', 100)).rejects.toMatchObject({ code: 'outcome_uncertain' });
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_import_records').first('n')).toBe(
    121,
  );
});
it('removes partial import/archive graph checkpoints explicitly without FK cascades or hidden row changes', async () => {
  const f = await fixture();
  await f.imports.sealPreview(id, 'a');
  const { WorkspaceArchiveStore } = await import('./archive-store');
  const store = new WorkspaceArchiveStore(f.db, {
      now: () => now,
      identity: async () => ({
        googleSubject: 'subject-a',
        email: 'a@example.com',
        planningZone: 'UTC',
        weekStart: 1,
      }),
    }),
    archiveId = now + ':archivegraphabcdef';
  const header = {
    format: 'lanes-workspace' as const,
    version: 1 as const,
    id: 'archivegraphabcdef',
    generatedAt: new Date(now).toISOString(),
    source: {
      googleSubject: 'subject-a',
      email: 'a@example.com',
      planningZone: 'UTC',
      weekStart: 1 as const,
    },
    scope: { kind: 'account' as const },
    includesTaskSnapshots: false,
    generationNote:
      'paginated retained projections; provider changes can produce a mixed-time export.' as const,
  };
  await store.begin({
    id: archiveId,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'restore_metadata',
    header,
    recordCount: 207,
  });
  await store.append(archiveId, 'a', [
    {
      position: 0,
      value: {
        kind: 'board',
        key: 'board',
        title: 'main',
        isMain: true,
        emoji: null,
        color: '#fff',
        backgroundUrl: null,
        position: 0,
        revision: 0,
      },
    },
    {
      position: 1,
      value: {
        kind: 'list',
        key: 'list',
        boardKey: 'board',
        providerId: 'provider-list',
        title: 'a list',
        color: '#fff',
        position: 0,
        revision: 0,
        membershipRevision: 0,
      },
    },
  ]);
  for (let offset = 0; offset < 205; offset += 10)
    await store.append(
      archiveId,
      'a',
      Array.from({ length: Math.min(10, 205 - offset) }, (_, index) => {
        const n = offset + index;
        return {
          position: n + 2,
          value: {
            kind: 'task',
            key: 't' + n,
            listKey: 'list',
            parentKey: null,
            provider: { id: 'p' + n, listId: 'provider-list', etag: null },
            revision: 0,
            scheduledDay: null,
            scheduledTime: null,
            timeZone: null,
            repeatRule: null,
            labels: [],
            priority: 'none',
            starred: false,
            dependencies: n
              ? [
                  {
                    key: 't' + (n - 1),
                    provider: { id: 'p' + (n - 1), listId: 'provider-list', etag: null },
                  },
                ]
              : [],
            order: n,
          },
        };
      }),
    );
  expect((await store.seal(archiveId, 'a')).state).toBe('staging');
  await f.db.prepare("UPDATE accounts_connections SET state='disconnecting'WHERE id='a'").run();
  await f.lifecycle.pause('a');
  await f.db
    .prepare(
      "UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='a'",
    )
    .run();
  const tables = [
    'transfer_import_graph_edges',
    'transfer_import_graph_nodes',
    'transfer_archive_graph_edges',
    'transfer_archive_graph_nodes',
    'transfer_archive_template_labels',
    'transfer_import_records',
    'transfer_archive_records',
    'transfer_imports',
    'transfer_archives',
  ];
  const initial = tables.reduce(
    (sum, table) => sum + Number(f.sqlite.prepare('SELECT COUNT(*)AS n FROM ' + table).get()?.n),
    0,
  );
  let deleted = 0;
  for (let slice = 0; slice < 20; slice++) {
    const before = Number(f.sqlite.prepare('SELECT total_changes()AS n').get()?.n),
      result = await f.lifecycle.remove('a', 100);
    expect(Number(f.sqlite.prepare('SELECT total_changes()AS n').get()?.n) - before).toBe(
      result.deleted,
    );
    expect(result.deleted).toBeLessThanOrEqual(100);
    deleted += result.deleted;
    if (result.done) break;
  }
  expect(deleted).toBe(initial);
  for (const table of tables)
    expect(f.sqlite.prepare('SELECT COUNT(*)AS n FROM ' + table).get()?.n).toBe(0);
});
