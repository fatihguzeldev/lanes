import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { WorkspaceArchiveStore } from './archive-store';
const now = Date.parse('2026-11-02T12:00:00Z'),
  id = `${now}:abcdefghijklmnop`;
const header = {
  format: 'lanes-workspace' as const,
  version: 1 as const,
  id: 'abcdefghijklmnop',
  generatedAt: '2026-11-02T12:00:00Z',
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
const board = {
  kind: 'board' as const,
  key: 'b1',
  title: 'everyday',
  isMain: true,
  emoji: null,
  color: '#fff',
  backgroundUrl: null,
  position: 0,
  revision: 0,
};
const list = {
  kind: 'list' as const,
  key: 'l1',
  boardKey: 'b1',
  providerId: 'list-provider',
  title: 'home',
  color: '#fff',
  position: 0,
  revision: 0,
  membershipRevision: 0,
};
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  return {
    ...database,
    store: new WorkspaceArchiveStore(database.db, {
      identity: async () => ({
        googleSubject: 'subject-a',
        email: 'a@example.com',
        planningZone: 'Europe/Istanbul',
        weekStart: 1,
      }),
      now: () => now,
    }),
  };
}
it('binds restore to an explicit verified same-subject account mapping and stages strict immutable chunks', async () => {
  const { store, db } = await fixture();
  await expect(
    store.begin({
      id,
      accountId: 'a',
      ownerSubject: 'owner',
      mode: 'restore_metadata',
      header: { ...header, source: { ...header.source, googleSubject: 'other' } },
      recordCount: 2,
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await store.begin({
    id,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'restore_metadata',
    header,
    recordCount: 2,
  });
  await store.append(id, 'a', [{ position: 0, value: board }]);
  await store.append(id, 'a', [{ position: 0, value: board }]);
  await expect(
    store.append(id, 'a', [{ position: 0, value: { ...board, title: 'changed' } }]),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    store.append(id, 'a', [{ position: 1, value: { ...list, accessToken: 'secret' } }]),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(store.seal(id, 'a')).rejects.toMatchObject({ code: 'conflict' });
  await store.append(id, 'a', [{ position: 1, value: list }]);
  expect(await store.seal(id, 'a')).toMatchObject({ state: 'preview', recordCount: 2 });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
  await expect(store.get(id, 'different-account')).rejects.toMatchObject({ code: 'not_found' });
});
it('rejects invalid global membership and references before any restore action', async () => {
  const { store } = await fixture();
  await store.begin({
    id,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'restore_metadata',
    header,
    recordCount: 2,
  });
  await store.append(id, 'a', [
    { position: 0, value: board },
    { position: 1, value: { ...list, boardKey: 'missing' } },
  ]);
  await expect(store.seal(id, 'a')).rejects.toMatchObject({ code: 'validation_failed' });
});
it('validates large metadata-only graphs and hashes across bounded resumable slices without task note reads', async () => {
  const { store } = await fixture();
  const count = 205;
  await store.begin({
    id,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'restore_metadata',
    header,
    recordCount: count + 2,
  });
  await store.append(id, 'a', [
    { position: 0, value: board },
    { position: 1, value: list },
  ]);
  for (let offset = 0; offset < count; offset += 10)
    await store.append(
      id,
      'a',
      Array.from({ length: Math.min(10, count - offset) }, (_, index) => {
        const n = offset + index;
        return {
          position: n + 2,
          value: {
            kind: 'task',
            key: 't' + n,
            listKey: 'l1',
            parentKey: null,
            provider: { id: 'provider-' + n, listId: 'list-provider', etag: null },
            revision: 1,
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
                    provider: { id: 'provider-' + (n - 1), listId: 'list-provider', etag: null },
                  },
                ]
              : [],
            order: n,
          },
        };
      }),
    );
  let summary = await store.seal(id, 'a');
  expect(summary.state).toBe('staging');
  expect(summary.validation?.checkedRecords).toBe(100);
  expect(summary.validation?.remainingGraphNodes).toBeGreaterThan(0);
  for (let turn = 0; turn < 50 && summary.state === 'staging'; turn++)
    summary = await store.seal(id, 'a');
  expect(summary.state).toBe('preview');
  expect(summary.validation).toMatchObject({ checkedRecords: 207, remainingGraphNodes: 0 });
});
it('rejects cyclic included dependencies and conflicting template label colors before preview admission', async () => {
  const { store } = await fixture();
  await store.begin({
    id,
    accountId: 'a',
    ownerSubject: 'owner',
    mode: 'restore_metadata',
    header,
    recordCount: 4,
  });
  await store.append(id, 'a', [
    { position: 0, value: board },
    { position: 1, value: list },
    ...Array.from({ length: 2 }, (_, n) => ({
      position: n + 2,
      value: {
        kind: 'task',
        key: 't' + n,
        listKey: 'l1',
        parentKey: null,
        provider: { id: 'provider-' + n, listId: 'list-provider', etag: null },
        revision: 1,
        scheduledDay: null,
        scheduledTime: null,
        timeZone: null,
        repeatRule: null,
        labels: [],
        priority: 'none',
        starred: false,
        dependencies: [
          {
            key: 't' + (1 - n),
            provider: { id: 'provider-' + (1 - n), listId: 'list-provider', etag: null },
          },
        ],
        order: n,
      },
    })),
  ]);
  await expect(store.seal(id, 'a')).rejects.toMatchObject({ code: 'validation_failed' });
});
