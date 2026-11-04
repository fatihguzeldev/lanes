import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { OperationStore } from '../../tasks/server/operations';
import { TaskSnapshotReader } from '../../tasks/server/queries/snapshot-reader';
import { ListSnapshotStore } from '../../tasks/server/list-templates';
import { TemplateDocumentStore } from '../../tasks/server/template-documents';
import { TransferImportService } from './imports';
import { transferDigest } from './content-hash';
import { AccountTransferService } from './account-transfer';
import { WorkspaceArchiveStore } from './archive-store';
import { TransferRetention } from './retention';
import type { D1Database } from '@cloudflare/workers-types';

const initial = Date.parse('2026-11-02T12:00:00Z'),
  day = 86400000;
const id = (suffix = 'a') => `${initial}:${suffix.repeat(16)}`;
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
const task = (number: number) => ({
  key: 't' + (number + 1),
  listKey: 'l1',
  parentKey: null,
  title: 'task ' + number,
  notes: 'retained-note-' + number,
  completed: !!(number % 2),
  completedAt: number % 2 ? new Date(initial).toISOString() : null,
  scheduledDay: null,
  scheduledTime: null,
  timeZone: null,
  repeatRule: null,
  labels: [],
  priority: 'none' as const,
  starred: false,
  dependencies: [],
  order: number,
});
const manifest = (count = 1, operationId = id()) => ({
  id: operationId,
  accountId: 'a',
  ownerSubject: 'owner',
  source: { kind: 'file' as const, name: 'tasks.csv', format: 'csv' },
  destination: { kind: 'new' as const, boardId: 'main' },
  totalLists: 1,
  totalTasks: count,
});
const archiveHeader = {
  format: 'lanes-workspace' as const,
  version: 1 as const,
  id: 'archive-0123456789abcdef',
  generatedAt: new Date(initial).toISOString(),
  source: {
    googleSubject: 'subject-a',
    email: 'a@example.com',
    planningZone: 'UTC',
    weekStart: 1 as const,
  },
  scope: { kind: 'account' as const },
  includesTaskSnapshots: true,
  generationNote:
    'paginated retained projections; provider changes can produce a mixed-time export.' as const,
};
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  let queries = 0;
  const statement = (value: object): object =>
    new Proxy(value, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (key === 'bind')
          return (...values: unknown[]) => statement(method.apply(target, values));
        if (['first', 'all', 'run', 'raw'].includes(String(key)))
          return (...values: unknown[]) => {
            queries++;
            return method.apply(target, values);
          };
        return method;
      },
    });
  const db = {
    prepare: (sql: string) => statement(database.db.prepare(sql)),
    batch: (statements: unknown[]) => {
      queries++;
      return database.db.batch(statements as never);
    },
    exec: (sql: string) => {
      queries++;
      return database.db.exec(sql);
    },
  } as unknown as D1Database;
  await seedAccount(db, 'a', initial);
  await seedAccount(db, 'b', initial);
  const operations = new OperationStore(db),
    snapshots = new TaskSnapshotReader(db, { now: () => initial }),
    listSnapshots = new ListSnapshotStore(db);
  const documents = new TemplateDocumentStore(db, {
    snapshots: listSnapshots,
    commitWrites: (writes) => db.batch(writes),
  });
  const imports = new TransferImportService(db, { now: () => initial, operations });
  const archives = new WorkspaceArchiveStore(db, {
    identity: async () => archiveHeader.source,
    now: () => initial,
  });
  const retention = new TransferRetention(db, {
    operations,
    snapshots,
    documents,
    now: () => initial + 2 * day,
  });
  async function captured(count = 1, operationId = id()) {
    const input = manifest(count, operationId);
    await imports.begin(input);
    await imports.append(operationId, 'a', {
      lists: [{ position: 0, value: { key: 'l1', title: 'a list' } }],
    });
    for (let offset = 0; offset < count; offset += 10)
      await imports.append(operationId, 'a', {
        tasks: Array.from({ length: Math.min(10, count - offset) }, (_, index) => ({
          position: offset + index,
          value: task(offset + index),
        })),
      });
    return input;
  }
  const changes = () => Number(database.sqlite.prepare('SELECT total_changes() AS n').get()?.n);
  return {
    ...database,
    db,
    operations,
    snapshots,
    documents,
    imports,
    archives,
    retention,
    captured,
    changes,
    queryCount: () => queries,
  };
}

describe('transfer retention budget and receipts', () => {
  it('prunes a2000-task terminal payload in bounded calls while preserving hashes, counts, and exact replay', async () => {
    const f = await fixture(),
      input = await f.captured(2000);
    await f.db
      .prepare("UPDATE transfer_imports SET state='finished',finished_at=?,updated_at=? WHERE id=?")
      .bind(initial, initial, id())
      .run();
    const original = await f.db
      .prepare(
        "SELECT input_hash FROM transfer_import_records WHERE import_id=? AND kind='task' AND item_key='t1'",
      )
      .bind(id())
      .first('input_hash');
    let pruned = false;
    for (let turn = 0; turn < 30; turn++) {
      const before = f.changes(),
        reported = await f.retention.cleanup(100);
      expect(reported).toBeLessThanOrEqual(100);
      expect(f.changes() - before).toBe(reported);
      if (
        !(await f.db
          .prepare(
            "SELECT 1 FROM transfer_import_records WHERE input_json LIKE '%retained-note-%' LIMIT 1",
          )
          .first())
      ) {
        pruned = true;
        break;
      }
    }
    expect(pruned).toBe(true);
    expect(
      await f.db
        .prepare(
          "SELECT input_hash FROM transfer_import_records WHERE import_id=? AND kind='task' AND item_key='t1'",
        )
        .bind(id())
        .first('input_hash'),
    ).toBe(original);
    expect(await f.imports.begin(input)).toMatchObject({
      state: 'finished',
      capturedTasks: 2000,
      completedCount: 1000,
    });
    await f.imports.append(id(), 'a', { tasks: [{ position: 0, value: task(0) }] });
    await expect(
      f.imports.append(id(), 'a', {
        tasks: [{ position: 0, value: { ...task(0), notes: 'changed intent' } }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (await f.imports.readPreviewRecords(id(), 'a', { kind: 'task', limit: 1 })).items[0]?.value,
    ).toBe(null);
  });
  it('never prunes cancelled input while its distinct provider operation remains uncertain', async () => {
    const f = await fixture();
    await f.captured();
    const providerId = id('p');
    await f.operations.admit(
      {
        id: providerId,
        ownerSubject: 'owner',
        accountId: 'a',
        kind: 'task.create',
        resourceKey: 'one-create',
        input: {},
        steps: [{ key: 'create', kind: 'task.create', input: {} }],
      },
      initial,
    );
    await f.operations.claimNext(providerId, 'worker', initial);
    await f.operations.markDispatched(providerId, 'create', 'worker', initial);
    await f.operations.rejectStep(
      providerId,
      'create',
      'worker',
      { code: 'outcome_uncertain', definitelyRejected: false },
      initial,
    );
    await f.db
      .prepare(
        "UPDATE transfer_imports SET state='cancelled',finished_at=?,updated_at=?,operation_id=? WHERE id=?",
      )
      .bind(initial, initial, providerId, id())
      .run();
    expect(await f.retention.cleanup(100)).toBe(0);
    expect(
      await f.db
        .prepare("SELECT input_json FROM transfer_import_records WHERE kind='task'")
        .first('input_json'),
    ).toContain('retained-note-0');
    expect(
      await f.db
        .prepare('SELECT payload_pruned_at FROM transfer_imports')
        .first('payload_pruned_at'),
    ).toBe(null);
  });
  it('expires abandoned unconfirmed previews by inactivity and preserves active validation work', async () => {
    const f = await fixture();
    await f.captured(1);
    await f.captured(1, id('b'));
    const now = initial + 30 * day;
    await f.db
      .prepare('UPDATE transfer_imports SET updated_at=?,created_at=? WHERE id=?')
      .bind(now - 2 * day, initial, id())
      .run();
    await f.db
      .prepare(
        'UPDATE transfer_imports SET updated_at=?,created_at=?,validation_revision=revision WHERE id=?',
      )
      .bind(now - 1000, initial, id('b'))
      .run();
    await f.retention.cleanup(100, now);
    expect((await f.imports.get(id(), 'a')).state).toBe('cancelled');
    expect((await f.imports.get(id('b'), 'a')).state).toBe('staging');
    expect(
      await f.db
        .prepare("SELECT input_json FROM transfer_import_records WHERE import_id=? AND kind='task'")
        .bind(id('b'))
        .first('input_json'),
    ).toContain('retained-note-0');
  });
  it('strips settled archive/action bodies but retains minimal destination matches and result identities', async () => {
    const f = await fixture(),
      archiveId = id('r');
    await f.archives.begin({
      id: archiveId,
      accountId: 'a',
      ownerSubject: 'owner',
      mode: 'restore_metadata',
      header: archiveHeader,
      recordCount: 1,
    });
    const value = {
      kind: 'task' as const,
      key: 't1',
      listKey: 'l1',
      parentKey: null,
      provider: { id: 'google-task', listId: 'google-list', etag: null },
      revision: 1,
      labels: [],
      priority: 'none' as const,
      starred: false,
      dependencies: [],
      order: 0,
      scheduledDay: null,
      scheduledTime: null,
      timeZone: null,
      repeatRule: null,
      snapshot: {
        title: 'exact task',
        notes: 'archive note payload',
        completed: false,
        completedAt: null,
      },
    };
    await f.archives.append(archiveId, 'a', [{ position: 0, value }]);
    const operationId = id('l');
    await f.operations.admit(
      {
        id: operationId,
        accountId: 'a',
        ownerSubject: 'owner',
        kind: 'archive.restore.local',
        resourceKey: 'archive:' + archiveId,
        input: {},
        steps: [{ key: 'restore', kind: 'local', input: {} }],
      },
      initial,
    );
    await f.operations.claimNext(operationId, 'worker', initial);
    await f.operations.commitLocalStep(
      operationId,
      'restore',
      'worker',
      { id: 'destination' },
      [],
      initial,
    );
    await f.db
      .prepare(
        'INSERT INTO transfer_archive_actions(archive_id,item_key,phase,operation_id,input_json,result_json)VALUES(?,?,?,?,?,?)',
      )
      .bind(
        archiveId,
        't1',
        'task',
        operationId,
        JSON.stringify({ notes: 'action note payload' }),
        JSON.stringify({ id: 'destination' }),
      )
      .run();
    await f.db
      .prepare('UPDATE transfer_archive_records SET match_json=? WHERE archive_id=?')
      .bind(
        JSON.stringify({
          key: 't1',
          kind: 'task',
          status: 'matched',
          message: 'matched',
          destinationId: 'destination',
          destinationRevision: 3,
          changes: { notes: 'preview payload' },
          fields: [],
          blockedFields: {},
          defaultIncomingFields: [],
        }),
        archiveId,
      )
      .run();
    await f.db
      .prepare(
        "UPDATE transfer_archives SET state='cancelled',finished_at=?,updated_at=? WHERE id=?",
      )
      .bind(initial, initial, archiveId)
      .run();
    for (let turn = 0; turn < 10; turn++) await f.retention.cleanup(100);
    expect(
      await f.db
        .prepare('SELECT input_json FROM transfer_archive_records WHERE archive_id=?')
        .bind(archiveId)
        .first('input_json'),
    ).toBe('{}');
    expect(
      await f.db
        .prepare('SELECT input_json FROM transfer_archive_actions WHERE archive_id=?')
        .bind(archiveId)
        .first('input_json'),
    ).toBe('{}');
    expect(
      await f.db
        .prepare('SELECT result_json FROM transfer_archive_actions WHERE archive_id=?')
        .bind(archiveId)
        .first('result_json'),
    ).toContain('destination');
    expect(
      await f.db
        .prepare('SELECT match_json FROM transfer_archive_records WHERE archive_id=?')
        .bind(archiveId)
        .first('match_json'),
    ).toContain('destination');
    expect(
      await f.db
        .prepare('SELECT match_json FROM transfer_archive_records WHERE archive_id=?')
        .bind(archiveId)
        .first('match_json'),
    ).not.toContain('preview payload');
    expect((await f.archives.page(archiveId, 'a')).items[0]?.value).toBe(null);
  });
  it('releases only document capture pins while preserving installed snapshot pins with a one-row budget', async () => {
    const f = await fixture(),
      archiveId = id('t'),
      key = 'template1';
    await f.archives.begin({
      id: archiveId,
      accountId: 'a',
      ownerSubject: 'owner',
      mode: 'restore_metadata',
      header: archiveHeader,
      recordCount: 1,
    });
    const header = {
      schemaVersion: 1 as const,
      dateMode: 'none' as const,
      saveDay: '2026-11-02',
      zone: 'UTC',
      listCount: 0,
      taskCount: 0,
    };
    await f.archives.append(archiveId, 'a', [
      {
        position: 0,
        value: {
          kind: 'template',
          key,
          templateKind: 'board',
          name: 'routine',
          description: '',
          contentRevision: 1,
          header,
          appearance: { title: 'board', emoji: null, color: '#abc', backgroundUrl: null },
        },
      },
    ]);
    const snapshotId =
      'archive-snapshot-' +
      (
        await transferDigest(
          archiveHeader.source.googleSubject + ':' + archiveHeader.id + ':' + key + ':' + archiveId,
        )
      ).slice(0, 32);
    await f.documents.begin(
      'a',
      header,
      {
        operationId: 'capture',
        stepKey: 'begin',
        origin: 'owner',
        recordedAt: new Date(initial).toISOString(),
      },
      snapshotId,
    );
    await f.db
      .prepare(
        'INSERT INTO tasks_template_snapshot_pins(account_id,snapshot_id,owner_key)VALUES(?,?,?)',
      )
      .bind('a', snapshotId, 'board-version:installed:1')
      .run();
    await f.db
      .prepare(
        "UPDATE transfer_archives SET state='cancelled',finished_at=?,updated_at=? WHERE id=?",
      )
      .bind(initial, initial, archiveId)
      .run();
    for (let turn = 0; turn < 10; turn++) {
      const before = f.changes(),
        reported = await f.retention.cleanup(1);
      expect(reported).toBeLessThanOrEqual(1);
      expect(f.changes() - before).toBe(reported);
    }
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key LIKE 'document:%'",
        )
        .first('n'),
    ).toBe(0);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key='board-version:installed:1'",
        )
        .first('n'),
    ).toBe(1);
  });
  it('garbage-collects frozen source snapshots without recreating them on retained account-transfer replay', async () => {
    const f = await fixture();
    await f.db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES ('source-list','a','google-list','source',1,?,?)",
      )
      .bind(initial, initial)
      .run();
    await f.db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,revision) VALUES ('source-task','a','source-list','google-task','source task',1)",
      )
      .run();
    const transfer = new AccountTransferService(f.db, {
      snapshots: f.snapshots,
      imports: f.imports,
      now: () => initial,
      labelsByNames: async () => [],
      destinationMainBoard: async () => ({
        id: 'main-b',
        accountId: 'b',
        title: 'main',
        isMain: true,
        emoji: null,
        color: '#abc',
        backgroundUrl: null,
        position: 0,
        revision: 0,
        createdAt: new Date(initial).toISOString(),
      }),
    });
    const request = {
      id: id('s'),
      ownerSubject: 'owner',
      sourceAccountId: 'a',
      destinationAccountId: 'b',
      listIds: ['source-list'],
      includeCompleted: true,
    };
    let summary = await transfer.begin(request);
    for (let turn = 0; turn < 20 && summary.state === 'staging'; turn++)
      summary = await transfer.captureNext(request.id, 'b');
    expect(summary.state).toBe('preview');
    for (
      let turn = 0;
      turn < 10 &&
      !(await f.db
        .prepare('SELECT snapshot_released FROM transfer_account_captures WHERE import_id=?')
        .bind(request.id)
        .first('snapshot_released'));
      turn++
    )
      await f.retention.cleanup(100, initial + 1000);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_snapshots').first('n')).toBe(0);
    await f.db
      .prepare("UPDATE accounts_connections SET state='reconnect_required' WHERE id='a'")
      .run();
    expect((await transfer.begin(request)).state).toBe('preview');
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_snapshots').first('n')).toBe(0);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(1);
  });
  it('shares one actual row budget with delegate cleanup and deletes children before90-day headers', async () => {
    const f = await fixture();
    await f.captured(3);
    await f.db
      .prepare("UPDATE transfer_imports SET state='finished',finished_at=?,updated_at=? WHERE id=?")
      .bind(initial, initial, id())
      .run();
    f.sqlite.exec('CREATE TABLE retention_delegate (bucket TEXT,n INTEGER,PRIMARY KEY(bucket,n))');
    for (const bucket of ['sheets', 'archives'])
      for (let n = 0; n < 10; n++)
        await f.db.prepare('INSERT INTO retention_delegate VALUES (?,?)').bind(bucket, n).run();
    const delegate = (bucket: string) => ({
      cleanup: async (limit: number) =>
        (
          await f.db
            .prepare(
              'DELETE FROM retention_delegate WHERE rowid IN(SELECT rowid FROM retention_delegate WHERE bucket=? LIMIT ?)',
            )
            .bind(bucket, limit)
            .run()
        ).meta.changes,
    });
    const retention = new TransferRetention(f.db, {
      operations: f.operations,
      snapshots: f.snapshots,
      sheets: delegate('sheets'),
      archiveExports: delegate('archives'),
    });
    for (let turn = 0; turn < 20; turn++) {
      const before = f.changes(),
        reported = await retention.cleanup(3, initial + 91 * day);
      expect(reported).toBeLessThanOrEqual(3);
      expect(f.changes() - before).toBe(reported);
    }
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_import_records').first('n')).toBe(
      0,
    );
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_imports').first('n')).toBe(0);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM retention_delegate').first('n')).toBe(0);
    await expect(
      new TransferImportService(f.db, { now: () => initial + 91 * day }).begin(manifest(3)),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('never deletes90-day template records before releasing their document pins', async () => {
    const f = await fixture(),
      archiveId = id('z');
    await f.archives.begin({
      id: archiveId,
      accountId: 'a',
      ownerSubject: 'owner',
      mode: 'restore_metadata',
      header: archiveHeader,
      recordCount: 11,
    });
    const header = {
      schemaVersion: 1 as const,
      dateMode: 'none' as const,
      saveDay: '2026-11-02',
      zone: 'UTC',
      listCount: 0,
      taskCount: 0,
    };
    for (let index = 0; index < 11; index++) {
      const key = 'template' + index;
      await f.archives.append(archiveId, 'a', [
        {
          position: index,
          value: {
            kind: 'template',
            key,
            templateKind: 'board',
            name: key,
            description: '',
            contentRevision: 1,
            header,
            appearance: { title: 'board', emoji: null, color: '#abc', backgroundUrl: null },
          },
        },
      ]);
      const snapshotId =
        'archive-snapshot-' +
        (
          await transferDigest(
            archiveHeader.source.googleSubject +
              ':' +
              archiveHeader.id +
              ':' +
              key +
              ':' +
              archiveId,
          )
        ).slice(0, 32);
      await f.documents.begin(
        'a',
        header,
        {
          operationId: 'capture',
          stepKey: 'begin',
          origin: 'owner',
          recordedAt: new Date(initial).toISOString(),
        },
        snapshotId,
      );
    }
    await f.db
      .prepare(
        "UPDATE transfer_archives SET state='cancelled',finished_at=?,updated_at=? WHERE id=?",
      )
      .bind(initial, initial, archiveId)
      .run();
    for (let turn = 0; turn < 20; turn++) await f.retention.cleanup(100, initial + 91 * day);
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transfer_archives').first('n')).toBe(0);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key LIKE 'document:%'",
        )
        .first('n'),
    ).toBe(0);
  });
  it('keeps a mixed receipt/pruning pass within the freeD1 query count', async () => {
    const f = await fixture();
    for (let n = 0; n < 3; n++) {
      const operationId = id('j' + n),
        importId = id('i' + n),
        archiveId = id('r' + n);
      await f.captured(1, importId);
      await f.operations.admit(
        {
          id: operationId,
          accountId: 'a',
          ownerSubject: 'owner',
          kind: 'local',
          resourceKey: 'local-' + n,
          input: {},
          steps: [{ key: 'local', kind: 'local', input: {} }],
        },
        initial,
      );
      await f.operations.claimNext(operationId, 'worker', initial);
      await f.operations.commitLocalStep(operationId, 'local', 'worker', {}, [], initial);
      await f.db
        .prepare(
          "UPDATE transfer_imports SET state='finished',operation_id=?,finished_at=? WHERE id=?",
        )
        .bind(operationId, initial, importId)
        .run();
      await f.archives.begin({
        id: archiveId,
        accountId: 'a',
        ownerSubject: 'owner',
        mode: 'restore_metadata',
        header: archiveHeader,
        recordCount: 0,
      });
      await f.db
        .prepare(
          "INSERT INTO transfer_archive_actions(archive_id,item_key,phase,operation_id,input_json)VALUES(?,'item','local',?,'{}')",
        )
        .bind(archiveId, id('s' + n))
        .run();
      await f.db
        .prepare("UPDATE transfer_archives SET state='cancelled',finished_at=? WHERE id=?")
        .bind(initial, archiveId)
        .run();
    }
    const before = f.queryCount();
    await f.retention.cleanup(100);
    expect(f.queryCount() - before).toBeLessThanOrEqual(35);
  });
});
