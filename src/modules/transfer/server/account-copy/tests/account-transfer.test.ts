import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { TaskSnapshotReader } from '../../../../tasks/server/queries/snapshot-reader';
import { TransferImportService } from '../../imports/imports';
import { AccountTransferService } from '../account-transfer';
const now = Date.parse('2026-11-02T12:00:00Z'),
  id = `${now}:accounttransfer1`;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
async function fixture(clock = () => now) {
  const database = testDatabase();
  closes.push(database.close);
  const { db } = database;
  await seedAccount(db, 'source', now);
  await seedAccount(db, 'destination', now);
  for (const list of ['one', 'two'])
    await db
      .prepare(
        "INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES(?,'source',?,'equal names',1,?,?)",
      )
      .bind(list, 'google-' + list, now, now)
      .run();
  for (const [task, list, parent, complete] of [
    ['parent', 'one', null, 1],
    ['child', 'one', 'parent', 0],
    ['other', 'two', null, 0],
  ] as const)
    await db
      .prepare(
        "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,notes,parent_id,completed,revision)VALUES(?,'source',?,?,?,'exact source notes',?,?,1)",
      )
      .bind(task, list, 'google-' + task, task, parent, complete)
      .run();
  await db
    .prepare(
      "INSERT INTO tasks_labels(id,account_id,name,name_key,color)VALUES('label','source','Home','home','#aabbcc')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_task_labels(account_id,task_id,label_id)VALUES('source','child','label')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id)VALUES('source','child','other')",
    )
    .run();
  const imports = new TransferImportService(db, { now: clock }),
    snapshots = new TaskSnapshotReader(db, { now: clock });
  const service = new AccountTransferService(db, {
    imports,
    snapshots,
    now: clock,
    destinationMainBoard: async (accountId) => ({
      id: 'main',
      accountId,
      title: 'everyday',
      isMain: true,
      emoji: null,
      color: '#fff',
      backgroundUrl: null,
      position: 0,
      revision: 0,
      createdAt: new Date(now).toISOString(),
    }),
    labelsByNames: async () => [
      {
        id: 'destination-label',
        accountId: 'destination',
        name: 'home',
        color: '#111111',
        revision: 1,
      },
    ],
  });
  return { ...database, service, imports };
}
it('captures source-preserving distinct lists, exact notes, metadata colors and internal refs', async () => {
  const f = await fixture();
  const before = (await f.db.prepare('SELECT * FROM tasks_tasks ORDER BY id').all()).results;
  await f.service.begin({
    id,
    ownerSubject: 'owner',
    sourceAccountId: 'source',
    destinationAccountId: 'destination',
    listIds: ['one', 'two'],
  });
  let summary = await f.imports.get(id, 'destination');
  for (let step = 0; step < 20 && summary.state === 'staging'; step++)
    summary = await f.service.captureNext(id, 'destination');
  expect(summary).toMatchObject({
    state: 'preview',
    capturedTasks: 3,
    totalLists: 2,
    warningCount: 1,
    requiredListSlots: 2,
  });
  const lists = await f.imports.readPreviewRecords(id, 'destination', { kind: 'list' });
  expect(lists.items.map((item) => (item.value as { title: string }).title)).toEqual([
    'equal names',
    'equal names',
  ]);
  const tasks = await f.imports.readPreviewRecords(id, 'destination', { kind: 'task' });
  expect(tasks.items.map((item) => (item.value as { notes: string }).notes)).toEqual([
    'exact source notes',
    'exact source notes',
    'exact source notes',
  ]);
  expect(
    tasks.items.find((item) => (item.value as { parentKey: string | null }).parentKey)?.value,
  ).toMatchObject({ labels: ['Home'], dependencies: ['t3'] });
  expect((await f.db.prepare('SELECT * FROM tasks_tasks ORDER BY id').all()).results).toEqual(
    before,
  );
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
});
it('shows omitted external edges and completed-parent context instead of dropping either silently', async () => {
  const f = await fixture();
  await f.service.begin({
    id,
    ownerSubject: 'owner',
    sourceAccountId: 'source',
    destinationAccountId: 'destination',
    listIds: ['one'],
    includeCompleted: false,
  });
  let summary = await f.imports.get(id, 'destination');
  for (let step = 0; step < 20 && summary.state === 'staging'; step++)
    summary = await f.service.captureNext(id, 'destination');
  expect(summary.warningCount).toBe(3);
  const rows = await f.imports.readPreviewRecords(id, 'destination', { kind: 'task' });
  expect(rows.items[0]?.value).toMatchObject({ completed: false, completedAt: null });
  expect(rows.items[1]?.value).toMatchObject({ dependencies: [] });
});
it('rejects same-account destination and stale source capture without provider writes', async () => {
  const f = await fixture();
  await expect(
    f.service.begin({
      id,
      ownerSubject: 'owner',
      sourceAccountId: 'source',
      destinationAccountId: 'source',
      listIds: ['one'],
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await f.service.begin({
    id,
    ownerSubject: 'owner',
    sourceAccountId: 'source',
    destinationAccountId: 'destination',
    listIds: ['one'],
  });
  await f.service.captureNext(id, 'destination');
  await f.db
    .prepare("UPDATE tasks_lists SET projection_revision=projection_revision+1 WHERE id='one'")
    .run();
  await expect(f.service.captureNext(id, 'destination')).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_operations').first('n')).toBe(0);
});
it('replays frozen selection after source snapshot cleanup without authorization, recapture or changed board assumptions', async () => {
  let clock = now;
  const f = await fixture(() => clock),
    input = {
      id,
      ownerSubject: 'owner',
      sourceAccountId: 'source',
      destinationAccountId: 'destination',
      listIds: ['one'],
      includeCompleted: true,
    };
  await f.service.begin(input);
  let summary = await f.imports.get(id, 'destination');
  for (let n = 0; n < 20 && summary.state === 'staging'; n++)
    summary = await f.service.captureNext(id, 'destination');
  const reader = new TaskSnapshotReader(f.db);
  for (let n = 0; n < 10; n++)
    if ((await reader.removeSnapshotSlice('transfer:' + id, 'source', 100)).done) break;
  await f.db.prepare("UPDATE accounts_connections SET state='disconnected'WHERE id='source'").run();
  clock += 91 * 86400000;
  expect(await f.service.begin(input)).toMatchObject({ id, state: 'preview' });
  await expect(f.service.begin({ ...input, includeCompleted: false })).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await f.db.prepare('SELECT COUNT(*)AS n FROM tasks_snapshots').first('n')).toBe(0);
});
it('rejects expired or future unrecorded identities before authorization or source snapshot capture', async () => {
  const f = await fixture();
  for (const state of ['connected', 'disconnected']) {
    await f.db
      .prepare('UPDATE accounts_connections SET state=? WHERE id=?')
      .bind(state, 'destination')
      .run();
    for (const issued of [now - 86400001, now + 300001])
      await expect(
        f.service.begin({
          id: `${issued}:accounttransfer1`,
          ownerSubject: 'owner',
          sourceAccountId: 'source',
          destinationAccountId: 'destination',
          listIds: ['one'],
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
  }
  for (const table of ['tasks_snapshots', 'transfer_imports', 'transfer_account_captures'])
    expect(await f.db.prepare(`SELECT COUNT(*)AS n FROM ${table}`).first('n')).toBe(0);
});
it('accepts fresh identity boundaries without silently narrowing the replay window', async () => {
  const f = await fixture();
  for (const issued of [now - 86400000, now + 300000])
    expect(
      await f.service.begin({
        id: `${issued}:accounttransfer1`,
        ownerSubject: 'owner',
        sourceAccountId: 'source',
        destinationAccountId: 'destination',
        listIds: ['one'],
      }),
    ).toMatchObject({ state: 'staging' });
});
