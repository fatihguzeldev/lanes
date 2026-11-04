import { expect, it } from 'vitest';
import { parseWorkspaceArchive, validateArchiveDocument } from '../archive';
import type { ArchiveDocument } from '../../contracts/archive';
const header = {
  format: 'lanes-workspace' as const,
  version: 1 as const,
  id: 'abcdefghijklmnop',
  generatedAt: '2026-11-02T12:00:00Z',
  source: {
    googleSubject: 'subject',
    email: 'owner@example.com',
    planningZone: 'Europe/Istanbul',
    weekStart: 1 as const,
  },
  scope: { kind: 'account' as const },
  includesTaskSnapshots: true,
  generationNote:
    'paginated retained projections; provider changes can produce a mixed-time export.' as const,
};
const document = (): ArchiveDocument => ({
  header,
  records: [
    {
      kind: 'board',
      key: 'b1',
      title: 'everyday',
      isMain: true,
      emoji: null,
      color: '#fff',
      backgroundUrl: null,
      position: 0,
      revision: 0,
    },
    {
      kind: 'list',
      key: 'l1',
      boardKey: 'b1',
      providerId: 'google-list',
      title: 'home',
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
      provider: { id: 'google-task', listId: 'google-list', etag: null },
      revision: 1,
      scheduledDay: null,
      scheduledTime: null,
      timeZone: null,
      repeatRule: null,
      labels: [],
      priority: 'none',
      starred: false,
      dependencies: [],
      order: 0,
      snapshot: {
        title: '= keep exact',
        notes: '\u0001 exact\ntext',
        completed: false,
        completedAt: null,
      },
    },
  ],
});
it('preserves exact archive text and refuses credentials, unsupported versions and arbitrary zip/json', () => {
  const value = document();
  expect(parseWorkspaceArchive(new TextEncoder().encode(JSON.stringify(value)))).toEqual(value);
  for (const invalid of [
    { ...value, token: 'secret' },
    { ...value, header: { ...header, version: 2 } },
    { ...value, records: [...value.records, { kind: 'credential', accessToken: 'secret' }] },
    { not: 'an archive' },
  ])
    expect(() =>
      parseWorkspaceArchive(new TextEncoder().encode(JSON.stringify(invalid))),
    ).toThrow();
  expect(() => parseWorkspaceArchive(new Uint8Array(20 * 1024 * 1024 + 1))).toThrow(/20 mib/);
});
it('validates complete export-local references and snapshot limits without title identity', () => {
  const value = document();
  expect(() => validateArchiveDocument(value)).not.toThrow();
  const task = value.records.find((record) => record.kind === 'task')!;
  expect(() =>
    validateArchiveDocument({
      ...value,
      records: [
        ...value.records,
        {
          ...task,
          key: 't2',
          provider: { ...task.provider, id: 'other-task' },
          parentKey: 'missing',
        },
      ],
    }),
  ).toThrow(/reference|parent/);
  expect(() =>
    validateArchiveDocument({
      ...value,
      records: [
        ...value.records,
        { ...task, key: 't2', provider: { ...task.provider, id: 'other-task' }, parentKey: 't1' },
        { ...task, key: 't3', provider: { ...task.provider, id: 'third-task' }, parentKey: 't2' },
      ],
    }),
  ).toThrow(/hierarchy|nested/);
  expect(() =>
    validateArchiveDocument({ ...value, records: [...value.records, { ...task, key: 't1' }] }),
  ).toThrow(/unique/);
});
it('rejects imported history with future ownership/schema fields and keeps ordinary retention outside parsing', () => {
  const value = document();
  const historical = {
    kind: 'history',
    key: 'h1',
    event: {
      id: 'old-event',
      schemaVersion: 1,
      accountId: 'a1',
      taskId: 't1',
      listId: 'l1',
      kind: 'task_created',
      origin: 'owner',
      dedupKey: 'original-event',
      recordedAt: '2026-01-01T00:00:00Z',
      providerAt: null,
      taskTitle: 'old title',
      listTitle: 'home',
      summary: { source: 'direct', operationId: 'old-operation', stepKey: 'created' },
    },
  };
  expect(() =>
    validateArchiveDocument({ ...value, records: [...value.records, historical] }),
  ).not.toThrow();
  expect(() =>
    validateArchiveDocument({
      ...value,
      records: [
        ...value.records,
        { ...historical, event: { ...historical.event, accountId: 'unmapped-account' } },
      ],
    }),
  ).toThrow();
});
