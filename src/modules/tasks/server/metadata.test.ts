import { afterEach, describe, expect, it } from 'vitest';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { HistoryService } from '../../history/server/events/event-store';
import { TaskQueries } from './queries/tasks';
import { TaskMetadataService, type MetadataContext } from './metadata';
import { MetadataCommandSchema, TaskMetadataPatchSchema } from '../metadata-command-contract';

const now = Date.parse('2026-11-02T12:00:00Z');
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const context = (key = 'one'): MetadataContext => ({
  operationId: 'operation',
  stepKey: key,
  origin: 'owner',
  recordedAt: new Date(now).toISOString(),
});
async function fixture(
  commit?: (
    writes: D1PreparedStatement[],
    db: ReturnType<typeof testDatabase>['db'],
  ) => Promise<void>,
) {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  for (const account of ['a', 'b']) {
    await seedAccount(db, account, now);
    await db
      .prepare('INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES (?,?,?,?)')
      .bind(`list-${account}`, account, `google-list-${account}`, account)
      .run();
  }
  const service = new TaskMetadataService(db, {
    history: new HistoryService(db, { now: () => now }),
    commitWrites: async (writes) => {
      if (commit) await commit(writes, db);
      else await db.batch(writes);
    },
  });
  const queries = new TaskQueries(db);
  async function task(id: string, account = 'a') {
    await db
      .prepare(
        'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,notes,scheduled_day) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(id, account, `list-${account}`, `google-${id}`, id, 'keep\nthese notes', '2026-11-02')
      .run();
  }
  async function label(id: string, name = id, account = 'a') {
    await db
      .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES (?,?,?,?,?)')
      .bind(id, account, name, name.normalize('NFC').toLowerCase(), '#123456')
      .run();
  }
  return { ...database, service, queries, task, label };
}

describe('metadata contracts and local writes', () => {
  it('rejects provider fields, defaults and client-supplied actor or receipt context', () => {
    for (const patch of [
      {},
      { title: 'no' },
      { scheduledDay: null },
      { completed: true },
      { priority: 'urgent' },
      { starred: 1 },
      { labelIds: ['a', 'a'] },
      { blockedBy: Array.from({ length: 51 }, (_, n) => String(n)) },
    ])
      expect(TaskMetadataPatchSchema.safeParse(patch).success).toBe(false);
    expect(TaskMetadataPatchSchema.parse({ starred: false })).toEqual({ starred: false });
    expect(
      MetadataCommandSchema.safeParse({
        kind: 'task.patch',
        taskId: 't',
        expectedRevision: 0,
        patch: { starred: true },
        operationId: 'forged',
      }).success,
    ).toBe(false);
  });
  it('changes only selected lanes fields and records confirmed strict history in the same batch', async () => {
    const { service, task, label, queries, db } = await fixture();
    await task('one');
    await label('label');
    const result = await service.patchTask(
      'a',
      'one',
      { labelIds: ['label'], priority: 'high', starred: true },
      0,
      context(),
    );
    expect(result).toEqual({ taskId: 'one', revision: 1, graphRevision: 0 });
    expect(await queries.getTask('a', 'one')).toMatchObject({
      labelIds: ['label'],
      priority: 'high',
      starred: true,
      revision: 1,
      notes: 'keep\nthese notes',
      scheduledDay: '2026-11-02',
      provider: { id: 'google-one' },
    });
    const events = await new HistoryService(db, { now: () => now }).query('a');
    expect(events.items.map((event) => event.kind).sort()).toEqual([
      'labels_changed',
      'priority_changed',
      'star_changed',
    ]);
    expect(JSON.stringify(events)).not.toContain('keep');
    expect(
      events.items.every(
        (event) => event.origin === 'owner' && event.summary.operationId === 'operation',
      ),
    ).toBe(true);
  });
  it('permits retained metadata during expiry/outage and refuses disconnected or deleted tasks', async () => {
    const { service, task, db } = await fixture();
    await task('one');
    for (const [state, revision] of [
      ['reconnect_required', 0],
      ['temporarily_unavailable', 1],
    ] as const) {
      await db.prepare('UPDATE accounts_connections SET state=? WHERE id=?').bind(state, 'a').run();
      await service.patchTask('a', 'one', { starred: revision === 0 }, revision, context(state));
    }
    await db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
    await expect(
      service.patchTask('a', 'one', { starred: true }, 2, context('denied')),
    ).rejects.toMatchObject({ code: 'reconnect_required' });
    await db.prepare("UPDATE accounts_connections SET state='connected' WHERE id='a'").run();
    await db.prepare("UPDATE tasks_tasks SET deleted_at=? WHERE id='one'").bind(now).run();
    await expect(
      service.patchTask('a', 'one', { starred: true }, 2, context('deleted')),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('fences a disconnect between preparation and commit and rolls back history and receipts', async () => {
    const { service, task, db } = await fixture(async (writes, database) => {
      await database
        .prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'")
        .run();
      await database.batch([
        ...writes,
        database
          .prepare(
            "INSERT INTO history_events(id,account_id,list_id,kind,origin,dedup_key,recorded_at,summary_json) VALUES ('receipt','a','list-a','test','owner','receipt',?, '{}')",
          )
          .bind(now),
      ]);
    });
    await task('one');
    await expect(
      service.patchTask('a', 'one', { starred: true }, 0, context()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await db.prepare("SELECT starred FROM tasks_tasks WHERE id='one'").first('starred'),
    ).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n')).toBe(0);
  });
  it('rejects stale task revisions and never bypasses the injected journal executor', async () => {
    const { service, task, db } = await fixture(async () => {
      throw new Error('receipt storage failed');
    });
    await task('one');
    await expect(
      service.patchTask('a', 'one', { starred: true }, 0, context()),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(
      await db.prepare("SELECT revision FROM tasks_tasks WHERE id='one'").first('revision'),
    ).toBe(0);
    const fresh = new TaskMetadataService(db, {
      history: new HistoryService(db, { now: () => now }),
      commitWrites: (writes) => db.batch(writes),
    });
    await fresh.patchTask('a', 'one', { starred: true }, 0, context());
    await expect(
      fresh.patchTask('a', 'one', { priority: 'high' }, 0, context('stale')),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('labels', () => {
  it('normalizes name uniqueness by account/NFC/fold while preserving chosen spelling and colors', async () => {
    const { service } = await fixture();
    const label = await service.createLabel(
      'a',
      { name: '  E\u0301cole  ', color: '#AbC' },
      context(),
      'first',
    );
    expect(label).toMatchObject({ id: 'first', name: 'École', color: '#abc', revision: 0 });
    await expect(
      service.createLabel('a', { name: 'éCOLE', color: '#000' }, context('duplicate')),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await service.createLabel('b', { name: 'école', color: '#000' }, context('other')),
    ).toMatchObject({ accountId: 'b' });
    expect(
      await service.updateLabel('a', 'first', { name: 'ÉCOLE' }, 0, context('rename')),
    ).toMatchObject({ id: 'first', name: 'ÉCOLE', color: '#abc', revision: 1 });
  });
  it('atomically rejects cross-account, missing, duplicate and excessive task label references', async () => {
    const { service, task, label, db } = await fixture();
    await task('one');
    await label('private', 'private', 'b');
    for (const labelIds of [
      ['missing'],
      ['private'],
      ['a', 'a'],
      Array.from({ length: 21 }, (_, n) => String(n)),
    ]) {
      await expect(service.patchTask('a', 'one', { labelIds }, 0, context())).rejects.toMatchObject(
        { code: 'validation_failed' },
      );
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_task_labels').first('n')).toBe(0);
    await expect(
      service.updateLabel('a', 'private', { color: '#fff' }, 0, context()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('keeps label deletion durable and bounded, denies new assignments, and preserves task/provider content', async () => {
    const { service, task, label, db, queries } = await fixture();
    await label('remove');
    await label('keep');
    for (let n = 0; n < 13; n++) {
      await task(`task-${n.toString().padStart(2, '0')}`);
      await service.patchTask(
        'a',
        `task-${n.toString().padStart(2, '0')}`,
        { labelIds: ['remove', 'keep'] },
        0,
        context(`assign-${n}`),
      );
    }
    const job = await service.startLabelDeletion('a', 'remove', 0, context('delete'), 'delete-job');
    expect(job).toMatchObject({ id: 'delete-job', state: 'pending', removedAssociations: 0 });
    await expect(
      service.patchTask('a', 'task-00', { labelIds: ['remove'] }, 1, context('late')),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      service.updateLabel('a', 'remove', { name: 'changed' }, 0, context('rename')),
    ).rejects.toMatchObject({ code: 'conflict' });
    const first = await service.continueLabelDeletion('a', 'delete-job', context('slice-1'));
    expect(first).toMatchObject({ state: 'pending', removedAssociations: 10, revision: 1 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM tasks_task_labels WHERE label_id='remove'")
        .first('n'),
    ).toBe(3);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM tasks_labels WHERE id='remove'").first('n'),
    ).toBe(1);
    expect(
      await service.continueLabelDeletion('a', 'delete-job', context('slice-2')),
    ).toMatchObject({ state: 'completed', removedAssociations: 13, revision: 2 });
    expect(await queries.getTask('a', 'task-00')).toMatchObject({
      revision: 2,
      labelIds: ['keep'],
      notes: 'keep\nthese notes',
      provider: { id: 'google-task-00' },
    });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM tasks_labels WHERE id='remove'").first('n'),
    ).toBe(0);
    expect(await service.getLabelDeletion('a', 'delete-job')).toMatchObject({ state: 'completed' });
    await expect(service.getLabelDeletion('b', 'delete-job')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('a stale deletion chunk or a failed receipt changes neither associations nor its progress', async () => {
    const { task, label, db, service } = await fixture();
    await task('one');
    await label('remove');
    await service.patchTask('a', 'one', { labelIds: ['remove'] }, 0, context('assign'));
    await service.startLabelDeletion('a', 'remove', 0, context('start'), 'job');
    const failing = new TaskMetadataService(db, {
      history: new HistoryService(db, { now: () => now }),
      commitWrites: async (writes) => {
        await db.batch([...writes, db.prepare('INSERT INTO missing_table VALUES (1)')]);
      },
    });
    await expect(failing.continueLabelDeletion('a', 'job', context('fail'))).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(await service.getLabelDeletion('a', 'job')).toMatchObject({
      removedAssociations: 0,
      revision: 0,
      state: 'pending',
    });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_task_labels').first('n')).toBe(1);
  });
});

describe('serialized dependencies', () => {
  it('rejects self, cross-account, deleted and missing blockers and uses a recursive cycle check', async () => {
    const { service, task, db } = await fixture();
    for (const id of ['one', 'two', 'three']) await task(id);
    await task('private', 'b');
    for (const blockedBy of [['one'], ['missing'], ['private']])
      await expect(
        service.patchTask('a', 'one', { blockedBy }, 0, context(), 0),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await service.patchTask('a', 'one', { blockedBy: ['two'] }, 0, context('one-two'), 0);
    await service.patchTask('a', 'two', { blockedBy: ['three'] }, 0, context('two-three'), 1);
    await expect(
      service.patchTask('a', 'three', { blockedBy: ['one'] }, 0, context('cycle'), 2),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await service.getGraphRevision('a')).toBe(2);
    await db.prepare("UPDATE tasks_tasks SET deleted_at=? WHERE id='three'").bind(now).run();
    await expect(
      service.patchTask('a', 'one', { blockedBy: ['three'] }, 1, context('deleted'), 2),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('serializes competing additions even on different tasks so concurrent edges cannot create a cycle', async () => {
    const { service, task, db } = await fixture();
    await task('one');
    await task('two');
    const attempts = await Promise.allSettled([
      service.patchTask('a', 'one', { blockedBy: ['two'] }, 0, context('a'), 0),
      service.patchTask('a', 'two', { blockedBy: ['one'] }, 0, context('b'), 0),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (attempts.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_dependencies').first('n')).toBe(1);
    expect(await service.getGraphRevision('a')).toBe(1);
  });
  it('replaces edges narrowly, retains missing-provider blockers and lets completion affect blocking without rewriting edges', async () => {
    const { service, task, db, queries } = await fixture();
    await task('one');
    await task('two');
    await service.patchTask('a', 'one', { blockedBy: ['two'] }, 0, context('edge'), 0);
    await db.prepare("UPDATE tasks_tasks SET provider_missing_at=? WHERE id='two'").bind(now).run();
    await service.patchTask('a', 'one', { starred: true }, 1, context('star'));
    expect((await queries.getTask('a', 'one')).blockedBy).toEqual(['two']);
    await service.patchTask('a', 'one', { blockedBy: [] }, 2, context('clear'), 1);
    expect((await queries.getTask('a', 'one')).blockedBy).toEqual([]);
    expect(await service.getGraphRevision('a')).toBe(2);
  });
  it('enforces both task and graph CAS inside the caller-owned commit, not only during preparation', async () => {
    const { service, task, db } = await fixture();
    await task('one');
    await task('two');
    const prepared = await service.prepareTaskPatch(
      'a',
      'one',
      { blockedBy: ['two'] },
      0,
      context('prepared'),
      0,
    );
    await service.patchTask('a', 'two', { starred: true }, 0, context('other'));
    await db
      .prepare(
        "UPDATE tasks_account_state SET graph_revision=graph_revision+1 WHERE account_id='a'",
      )
      .run();
    await expect(db.batch(prepared.writes)).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_dependencies').first('n')).toBe(0);
  });
});

describe('creation/copy preparation', () => {
  it('joins metadata after new task projection in the same commit, remaps dependencies only within the captured set and emits no fake edit/completion', async () => {
    const { service, label, db } = await fixture();
    await label('label');
    const writes = await service.prepareCreatedMetadata(
      'a',
      [
        {
          taskId: 'copy-a',
          expectedTaskRevision: 0,
          labelIds: ['label'],
          priority: 'high',
          starred: true,
          blockedBy: ['copy-b'],
        },
        {
          taskId: 'copy-b',
          expectedTaskRevision: 0,
          labelIds: [],
          priority: 'none',
          starred: false,
          blockedBy: [],
        },
      ],
      context('copy'),
      0,
    );
    const create = ['copy-a', 'copy-b'].map((id) =>
      db
        .prepare(
          'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES (?,?,?,?,?)',
        )
        .bind(id, 'a', 'list-a', `google-${id}`, id),
    );
    await db.batch([...create, ...writes]);
    const queries = new TaskQueries(db);
    expect(await queries.getTask('a', 'copy-a')).toMatchObject({
      revision: 0,
      labelIds: ['label'],
      priority: 'high',
      starred: true,
      blockedBy: ['copy-b'],
    });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n')).toBe(0);
    expect(await service.getGraphRevision('a')).toBe(1);
  });
  it('rolls back newly-created projections when captured metadata refers to a missing blocker or another account label', async () => {
    const { service, task, label, db } = await fixture();
    await task('original');
    await label('foreign', 'foreign', 'b');
    const missing = await service.prepareCreatedMetadata(
      'a',
      [
        {
          taskId: 'copy',
          expectedTaskRevision: 0,
          labelIds: [],
          priority: 'none',
          starred: false,
          blockedBy: ['missing'],
        },
      ],
      context('copy'),
      0,
    );
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES ('copy','a','list-a','google-copy','copy')",
        ),
        ...missing,
      ]),
    ).rejects.toThrow();
    const writes = await service.prepareCreatedMetadata(
      'a',
      [
        {
          taskId: 'copy',
          expectedTaskRevision: 0,
          labelIds: ['foreign'],
          priority: 'none',
          starred: false,
          blockedBy: [],
        },
      ],
      context('foreign'),
      0,
    );
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES ('copy','a','list-a','google-copy','copy')",
        ),
        ...writes,
      ]),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM tasks_tasks WHERE id='copy'").first('n'),
    ).toBe(0);
  });
});

describe('metadata bounds and transactional races', () => {
  it('uses JSON-bound sets for twenty labels and fifty blockers without consuming the one hundred parameter budget', async () => {
    const { service, task, label, queries } = await fixture();
    await task('one');
    const labelIds = Array.from({ length: 20 }, (_, n) => `label-${n}`),
      blockedBy = Array.from({ length: 50 }, (_, n) => `blocker-${n}`);
    for (const value of labelIds) await label(value);
    for (const value of blockedBy) await task(value);
    const prepared = await service.prepareTaskPatch(
      'a',
      'one',
      { labelIds, blockedBy, priority: 'low', starred: false },
      0,
      context(),
      0,
    );
    expect(
      prepared.writes.every(
        (statement) => (statement as unknown as { values: unknown[] }).values.length < 100,
      ),
    ).toBe(true);
    const result = await service.patchTask(
      'a',
      'one',
      { labelIds, blockedBy, priority: 'low', starred: false },
      0,
      context(),
      0,
    );
    expect(result.graphRevision).toBe(1);
    expect(await queries.getTask('a', 'one')).toMatchObject({
      labelIds: expect.arrayContaining(labelIds),
      blockedBy: expect.arrayContaining(blockedBy),
      priority: 'low',
      starred: false,
    });
  });
  it('admits only one concurrent normalized label name without orphan writes', async () => {
    const { service, db } = await fixture();
    const attempts = await Promise.allSettled([
      service.createLabel('a', { name: 'CAFÉ', color: '#000' }, context('a'), 'a-label'),
      service.createLabel('a', { name: 'cafe\u0301', color: '#fff' }, context('b'), 'b-label'),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(
      (attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_labels').first('n')).toBe(1);
  });
  it('rejects over-budget metadata before touching rows', async () => {
    const { service, task, db } = await fixture();
    await task('one');
    const labelIds = Array.from({ length: 20 }, (_, n) => `${n}`.padEnd(1_024, 'x'));
    const blockedBy = Array.from({ length: 50 }, (_, n) => `${n}`.padEnd(1_024, 'y'));
    await expect(
      service.patchTask('a', 'one', { labelIds, blockedBy }, 0, context(), 0),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await db.prepare('SELECT SUM(revision) AS n FROM tasks_tasks').first('n')).toBe(0);
  });
  it('rejects a stale deletion chunk after its task changed and does not advance its job receipt', async () => {
    const { task, label, service, db } = await fixture();
    await task('one');
    await label('remove');
    await service.patchTask('a', 'one', { labelIds: ['remove'] }, 0, context('assign'));
    await service.startLabelDeletion('a', 'remove', 0, context('start'), 'job');
    const raced = new TaskMetadataService(db, {
      history: new HistoryService(db, { now: () => now }),
      commitWrites: async (writes) => {
        await db
          .prepare("UPDATE tasks_tasks SET starred=1,revision=revision+1 WHERE id='one'")
          .run();
        await db.batch(writes);
      },
    });
    await expect(raced.continueLabelDeletion('a', 'job', context('slice'))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await service.getLabelDeletion('a', 'job')).toMatchObject({
      state: 'pending',
      revision: 0,
      removedAssociations: 0,
    });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_task_labels').first('n')).toBe(1);
  });
  it('completes empty-label deletion and commits a terminal no-op receipt through the same executor', async () => {
    let executions = 0;
    const { service, label, db } = await fixture(async (writes, database) => {
      executions++;
      await database.batch(writes);
    });
    await label('empty');
    await service.startLabelDeletion('a', 'empty', 0, context('start'), 'job');
    expect(await service.continueLabelDeletion('a', 'job', context('first'))).toMatchObject({
      state: 'completed',
      removedAssociations: 0,
      revision: 1,
    });
    expect(await service.continueLabelDeletion('a', 'job', context('terminal'))).toMatchObject({
      state: 'completed',
      revision: 1,
    });
    expect(executions).toBe(3);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_labels').first('n')).toBe(0);
  });
  it('rejects cycles among newly created nodes and preserves revision-one projections on valid initial metadata', async () => {
    const { service, db } = await fixture();
    const copies = ['first', 'second'].map((taskId, index) => ({
      taskId,
      expectedTaskRevision: 1,
      labelIds: [],
      priority: 'none' as const,
      starred: false,
      blockedBy: [index === 0 ? 'second' : 'first'],
    }));
    const writes = await service.prepareCreatedMetadata('a', copies, context('cycle'), 0);
    const create = ['first', 'second'].map((taskId) =>
      db
        .prepare(
          'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,revision) VALUES (?,?,?,?,?,1)',
        )
        .bind(taskId, 'a', 'list-a', `google-${taskId}`, taskId),
    );
    await expect(db.batch([...create, ...writes])).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(0);
    const valid = await service.prepareCreatedMetadata(
      'a',
      [{ ...copies[0]!, blockedBy: [], priority: 'high' }],
      context('valid'),
      99,
    );
    await db.batch([create[0]!, ...valid]);
    expect(await new TaskQueries(db).getTask('a', 'first')).toMatchObject({
      revision: 1,
      priority: 'high',
    });
    expect(await service.getGraphRevision('a')).toBe(0);
  });
});

it('settles captured create metadata after disconnect while fresh user metadata remains fenced', async () => {
  const { service, task, db } = await fixture();
  await task('created');
  await db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
  const settlement = await service.prepareCreatedMetadata(
    'a',
    [
      {
        taskId: 'created',
        expectedTaskRevision: 0,
        priority: 'high',
        starred: true,
        labelIds: [],
        blockedBy: [],
      },
    ],
    context('settle'),
    0,
  );
  // Production composition adds its known-response claim guard before these writes.
  await db.batch(settlement);
  expect(await new TaskQueries(db).getTask('a', 'created')).toMatchObject({
    priority: 'high',
    starred: true,
    revision: 0,
  });
  await expect(
    service.patchTask('a', 'created', { priority: 'low' }, 0, context('fresh')),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('paginates pending label deletions after reload and keeps job cursors account-scoped', async () => {
  const { service, label, db } = await fixture();
  await label('first');
  await label('second');
  await label('private', 'private', 'b');
  await service.startLabelDeletion('a', 'first', 0, context('first'), 'job-a');
  await service.startLabelDeletion('a', 'second', 0, context('second'), 'job-z');
  await service.startLabelDeletion('b', 'private', 0, context('private'), 'private-job');
  await db.prepare("UPDATE accounts_connections SET state='disconnected' WHERE id='a'").run();
  const page = await service.listPendingLabelDeletions('a', { limit: 1 });
  expect(page.items.map((item) => item.id)).toEqual(['job-a']);
  expect(
    (
      await service.listPendingLabelDeletions('a', { cursor: page.nextCursor!, limit: 1 })
    ).items.map((item) => item.id),
  ).toEqual(['job-z']);
  await expect(
    service.listPendingLabelDeletions('b', { cursor: page.nextCursor! }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
});

it('settles captured mixed metadata before a provider projection advances revision while disconnect drains', async () => {
  const { service, task, db } = await fixture();
  await task('one');
  await db.prepare("UPDATE accounts_connections SET state='disconnecting' WHERE id='a'").run();
  const prepared = await service.prepareConfirmedTaskPatch(
    'a',
    'one',
    { starred: true },
    0,
    context('mixed'),
  );
  await db.batch([
    ...prepared.writes,
    db.prepare("UPDATE tasks_tasks SET title='accepted title',revision=revision+1 WHERE id='one'"),
  ]);
  expect(await new TaskQueries(db).getTask('a', 'one')).toMatchObject({
    title: 'accepted title',
    starred: true,
    revision: 2,
  });
  await expect(
    service.prepareConfirmedTaskPatch('a', 'one', { priority: 'high' }, 0, context('stale')),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    service.prepareTaskPatch('a', 'one', { starred: false }, 2, context('fresh')),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('advances list projection fences alongside metadata so an old in-flight provider page cannot overwrite it', async () => {
  const { service, task, label, db } = await fixture();
  await task('one');
  await label('remove');
  await service.patchTask('a', 'one', { labelIds: ['remove'], starred: true }, 0, context('edit'));
  expect(
    await db
      .prepare("SELECT projection_revision FROM tasks_lists WHERE id='list-a'")
      .first('projection_revision'),
  ).toBe(1);
  await service.startLabelDeletion('a', 'remove', 0, context('start'), 'job');
  await service.continueLabelDeletion('a', 'job', context('slice'));
  expect(
    await db
      .prepare("SELECT projection_revision FROM tasks_lists WHERE id='list-a'")
      .first('projection_revision'),
  ).toBe(2);
});

it('preflights direct creation metadata before any provider call can be admitted', async () => {
  const { service, task, label, db } = await fixture();
  await task('blocker');
  await label('label');
  await label('private', 'private', 'b');
  await expect(
    service.validateCreationMetadata('a', { labelIds: ['private'] }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    service.validateCreationMetadata('a', { blockedBy: ['missing'] }, 0),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    service.validateCreationMetadata('a', { blockedBy: ['blocker'] }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(
    service.validateCreationMetadata('a', { blockedBy: ['blocker'] }, 1),
  ).rejects.toMatchObject({ code: 'conflict' });
  await service.validateCreationMetadata(
    'a',
    { labelIds: ['label'], priority: 'high', starred: true, blockedBy: ['blocker'] },
    0,
  );
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_dependencies').first('n')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n')).toBe(0);
});

it('applies initial copied edges after base metadata without overwriting it or inventing edit history', async () => {
  const { service, task, label, db, queries } = await fixture();
  await task('one');
  await task('two');
  await label('label');
  await service.patchTask(
    'a',
    'one',
    { priority: 'high', starred: true, labelIds: ['label'] },
    0,
    context('base'),
  );
  const beforeEvents = await db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n');
  const writes = await service.prepareCopiedDependencies(
    'a',
    [
      { taskId: 'one', expectedTaskRevision: 1, blockedBy: ['two'] },
      { taskId: 'two', expectedTaskRevision: 0, blockedBy: [] },
    ],
    context('initial-edges'),
    0,
  );
  await db.batch(writes);
  expect(await queries.getTask('a', 'one')).toMatchObject({
    priority: 'high',
    starred: true,
    labelIds: ['label'],
    blockedBy: ['two'],
    revision: 2,
  });
  expect(await queries.getTask('a', 'two')).toMatchObject({ revision: 0 });
  expect(await service.getGraphRevision('a')).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n')).toBe(
    beforeEvents,
  );
});

it('rejects copied edges on stale baselines, existing edited edges and concurrent cycles atomically', async () => {
  const { service, task, db, queries } = await fixture();
  await task('one');
  await task('two');
  const cyclic = await service.prepareCopiedDependencies(
    'a',
    [
      { taskId: 'one', expectedTaskRevision: 0, blockedBy: ['two'] },
      { taskId: 'two', expectedTaskRevision: 0, blockedBy: ['one'] },
    ],
    context('cycle'),
    0,
  );
  await expect(db.batch(cyclic)).rejects.toThrow();
  expect((await queries.getTask('a', 'one')).blockedBy).toEqual([]);
  const stale = await service.prepareCopiedDependencies(
    'a',
    [{ taskId: 'one', expectedTaskRevision: 0, blockedBy: ['two'] }],
    context('stale'),
    0,
  );
  await service.patchTask('a', 'one', { starred: true }, 0, context('edit'));
  await expect(db.batch(stale)).rejects.toThrow();
  expect((await queries.getTask('a', 'one')).blockedBy).toEqual([]);
});

it('resolves reusable label definitions by normalized account name and preserves destination colors', async () => {
  const { service, label, db } = await fixture();
  await label('existing', 'école');
  const prepared = await service.prepareResolveLabelDefinitions(
    'a',
    [
      { name: 'E\u0301COLE', color: '#fff' },
      { name: '  new label ', color: '#AbC' },
    ],
    context('resolve'),
  );
  expect(prepared.labelIds[0]).toBe('existing');
  expect(prepared.colorConflicts).toEqual([
    { name: 'école', requestedColor: '#fff', keptColor: '#123456' },
  ]);
  await db.batch(prepared.writes);
  expect(
    await db
      .prepare('SELECT name,color FROM tasks_labels WHERE id=?')
      .bind(prepared.labelIds[1])
      .first(),
  ).toEqual({ name: 'new label', color: '#abc' });
  const replay = await service.prepareResolveLabelDefinitions(
    'a',
    [{ name: 'new label', color: '#abc' }],
    context('other-copy'),
  );
  expect(replay.labelIds).toEqual([prepared.labelIds[1]]);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM history_events').first('n')).toBe(0);
});

it('a racing label resolution rolls back its task receipt and can reconcile onto the winning definition', async () => {
  const { service, db } = await fixture();
  const a = await service.prepareResolveLabelDefinitions(
    'a',
    [{ name: 'same', color: '#000' }],
    context('a'),
  );
  const b = await service.prepareResolveLabelDefinitions(
    'a',
    [{ name: 'SAME', color: '#fff' }],
    context('b'),
  );
  await db.batch(a.writes);
  await expect(db.batch(b.writes)).rejects.toThrow();
  const repair = await service.prepareResolveLabelDefinitions(
    'a',
    [{ name: 'SAME', color: '#fff' }],
    context('b'),
  );
  expect(repair.labelIds).toEqual(a.labelIds);
  expect(repair.colorConflicts).toMatchObject([{ keptColor: '#000' }]);
});
