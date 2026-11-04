import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { ListSnapshotStore, ListTemplateService, materializeTemplateTask } from '../lists';
const now = Date.parse('2026-11-02T12:00:00Z');
const context = {
  operationId: 'op',
  stepKey: 'save',
  origin: 'owner' as const,
  recordedAt: new Date(now).toISOString(),
  saveDay: '2026-11-02',
  zone: 'Europe/Istanbul',
};
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  await seedAccount(db, 'a', now);
  await seedAccount(db, 'b', now);
  for (const account of ['a', 'b'])
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES (?,?,?,?,1,?,?)',
      )
      .bind(`list-${account}`, account, `provider-${account}`, 'same title', now, now)
      .run();
  const snapshots = new ListSnapshotStore(db);
  const service = new ListTemplateService(db, {
    snapshots,
    sourceListAppearance: async () => ({ color: '#aabbcc', guardWrites: [] }),
    commitWrites: (writes) => db.batch(writes),
  });
  const task = async (
    id: string,
    fields: {
      parent?: string;
      completed?: boolean;
      day?: string;
      time?: string;
      zone?: string;
      rule?: unknown;
    } = {},
  ) =>
    db
      .prepare(
        'INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,provider_position,title,notes,completed,scheduled_day,scheduled_time,time_zone,repeat_rule_json,series_id,occurrence_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        'a',
        'list-a',
        fields.parent ?? null,
        `provider-${id}`,
        id,
        id,
        'plain\nnotes',
        fields.completed ? 1 : 0,
        fields.day ?? null,
        fields.time ?? null,
        fields.zone ?? null,
        fields.rule ? JSON.stringify(fields.rule) : null,
        'source-series',
        'source-occurrence',
      )
      .run();
  return { ...database, snapshots, service, task };
}
const source = {
  name: 'weekly reset',
  description: 'a saved checklist',
  listId: 'list-a',
  listRevision: 1,
  dateMode: 'relative' as const,
};
describe('immutable reusable list snapshots', () => {
  it('captures open-child parent context, local labels and internal dependencies while omitting external edges', async () => {
    const { service, snapshots, task, db } = await fixture();
    await task('parent', { completed: true });
    await task('child', {
      parent: 'parent',
      day: '2026-10-31',
      time: '09:30',
      zone: 'Europe/Istanbul',
    });
    await task('outside', { completed: true });
    await db
      .prepare(
        "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES ('label','a','École','école','#aabbcc')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES ('a','child','label')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) VALUES ('a','child','parent'),('a','child','outside')",
      )
      .run();
    const saved = await service.create('a', source, context);
    expect(saved.snapshot).toMatchObject({
      taskCount: 2,
      contextParentCount: 1,
      omittedDependencyCount: 1,
      sourceDatedCount: 1,
      sourceTimedCount: 1,
    });
    const nodes = (await snapshots.listTasks('a', saved.snapshot.id)).items;
    const child = nodes.find((node) => node.title === 'child')!;
    expect(child).toMatchObject({
      dayOffset: -2,
      scheduledTime: '09:30',
      timeZone: 'Europe/Istanbul',
      labels: [{ name: 'École', color: '#aabbcc' }],
      dependencyKeys: [nodes.find((node) => node.title === 'parent')!.key],
    });
    expect(JSON.stringify(nodes)).not.toMatch(
      /provider-|source-series|source-occurrence|labelIds|history|accountId/,
    );
    await db
      .prepare("UPDATE tasks_tasks SET title='changed',notes='changed' WHERE id='child'")
      .run();
    await db.prepare("UPDATE tasks_lists SET deleted_at=? WHERE id='list-a'").bind(now).run();
    expect(
      (await snapshots.listTasks('a', saved.snapshot.id)).items.find(
        (node) => node.key === child.key,
      )?.title,
    ).toBe('child');
  });
  it('starts included completed tasks open and drops scheduling only through an explicit no-date application', async () => {
    const { service, snapshots, task } = await fixture();
    await task('done', {
      completed: true,
      day: '2026-11-01',
      time: '10:00',
      zone: 'Europe/Istanbul',
    });
    const saved = await service.create('a', { ...source, includeCompleted: true }, context);
    expect(saved.snapshot.completedIncludedCount).toBe(1);
    const node = (await snapshots.listTasks('a', saved.snapshot.id)).items[0]!;
    const applied = materializeTemplateTask(node, {
      applicationDay: '2026-12-01',
      useRelativeDates: true,
      listPrefix: '',
    });
    expect(applied.entry).toMatchObject({
      completed: false,
      completedAt: null,
      scheduledDay: '2026-11-30',
      scheduledTime: '10:00',
      timeZone: 'Europe/Istanbul',
    });
    expect(
      materializeTemplateTask(node, {
        applicationDay: '2026-12-01',
        useRelativeDates: false,
        listPrefix: '',
      }).entry,
    ).toMatchObject({ scheduledDay: null, scheduledTime: null, timeZone: null, repeatRule: null });
  });
  it('shifts repeat end dates, reanchors independent presets and never copies source occurrence identities', async () => {
    const { service, snapshots, task } = await fixture();
    await task('repeat', {
      day: '2026-11-03',
      rule: {
        frequency: 'monthly',
        interval: 1,
        anchorDay: '2026-01-31',
        zone: 'Europe/Istanbul',
        weekStart: 1,
        weekdays: [],
        end: { type: 'date', day: '2027-01-03' },
      },
    });
    const saved = await service.create('a', source, context),
      node = (await snapshots.listTasks('a', saved.snapshot.id)).items[0]!;
    expect(node.repeatPreset?.end).toEqual({ type: 'date', offsetDays: 62 });
    const applied = materializeTemplateTask(node, {
      applicationDay: '2027-02-01',
      useRelativeDates: true,
      listPrefix: '',
    });
    expect(applied.entry).toMatchObject({
      scheduledDay: '2027-02-02',
      repeatRule: { anchorDay: '2027-02-02', end: { type: 'date', day: '2027-04-04' } },
    });
    expect(JSON.stringify(applied)).not.toContain('source-series');
  });
  it('rejects incomplete/cross-account/unsupported source selections before saving a template', async () => {
    const { service, db, task } = await fixture();
    await task('one');
    await expect(
      service.create('a', { ...source, listId: 'list-b' }, context),
    ).rejects.toMatchObject({ code: 'not_found' });
    await db.prepare("UPDATE tasks_lists SET completed_complete_at=NULL WHERE id='list-a'").run();
    await expect(service.create('a', source, context)).rejects.toMatchObject({ code: 'conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_list_templates').first('n')).toBe(0);
  });
  it('uses CAS for replacement and metadata, preserving every already captured version and pinned run', async () => {
    const { service, snapshots, task, db } = await fixture();
    await task('one');
    const first = await service.create('a', source, context);
    await db.batch([snapshots.pinWrite('a', first.snapshot.id, 'run:one')]);
    await db.prepare("UPDATE tasks_tasks SET title='new source' WHERE id='one'").run();
    const replaced = await service.replace(
      'a',
      first.id,
      { listId: 'list-a', listRevision: 1, dateMode: 'none' },
      0,
      { ...context, stepKey: 'replace' },
    );
    expect(replaced).toMatchObject({
      revision: 1,
      contentRevision: 2,
      snapshot: { dateMode: 'none' },
    });
    expect((await service.getVersion('a', first.id, 1)).snapshot.id).toBe(first.snapshot.id);
    await expect(
      service.update('a', first.id, { name: 'stale' }, 0, context),
    ).rejects.toMatchObject({ code: 'conflict' });
    await service.delete('a', first.id, 1, { ...context, stepKey: 'delete' });
    await expect(service.get('a', first.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await snapshots.listTasks('a', first.snapshot.id)).items[0]?.title).toBe('one');
  });
  it('a failed journal receipt rolls back the header and the entire captured payload', async () => {
    const { db, snapshots, task } = await fixture();
    await task('one');
    const service = new ListTemplateService(db, {
      snapshots,
      sourceListAppearance: async () => ({ color: '#aabbcc', guardWrites: [] }),
      commitWrites: (writes) =>
        db.batch([...writes, db.prepare('INSERT INTO no_table VALUES (1)')]),
    });
    await expect(service.create('a', source, context)).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_template_nodes').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_list_templates').first('n')).toBe(0);
  });
});
it('indexes reusable label definitions and previews destination color conflicts without rewriting either side', async () => {
  const { service, snapshots, task, db } = await fixture();
  await task('one');
  await db
    .prepare(
      "INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES ('label','a','École','école','#aabbcc')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO tasks_task_labels(account_id,task_id,label_id) VALUES ('a','one','label')",
    )
    .run();
  const saved = await service.create('a', source, context);
  await db.prepare("UPDATE tasks_labels SET color='#ffffff' WHERE id='label'").run();
  expect(
    await snapshots.previewApplication('a', saved.snapshot.id, {
      applicationDay: '2026-12-01',
      useRelativeDates: true,
      listPrefix: '',
    }),
  ).toMatchObject({ labelDefinitionCount: 1, labelColorConflictCount: 1 });
  expect((await snapshots.listLabelColorConflicts('a', saved.snapshot.id)).items).toEqual([
    { name: 'École', requestedColor: '#aabbcc', keptColor: '#ffffff' },
  ]);
  expect((await snapshots.listTasks('a', saved.snapshot.id)).items[0]?.labels).toEqual([
    { name: 'École', color: '#aabbcc' },
  ]);
  expect(await db.prepare("SELECT color FROM tasks_labels WHERE id='label'").first('color')).toBe(
    '#ffffff',
  );
});
it('rejects over-limit source content rather than truncating its first two thousand tasks', async () => {
  const { service, db } = await fixture();
  await db
    .prepare(
      "WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n<2000) INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) SELECT 'task-'||n,'a','list-a','provider-'||n,'one' FROM numbers",
    )
    .run();
  await expect(service.create('a', source, context)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_list_templates').first('n')).toBe(0);
  await db.prepare("DELETE FROM tasks_tasks WHERE id='task-2000'").run();
  const saved = await service.create('a', source, context);
  expect(saved.snapshot.taskCount).toBe(2000);
  expect((await snapshotsFor(db, saved.snapshot.id)).taskCount).toBe(2000);
  async function snapshotsFor(database: typeof db, id: string) {
    return new ListSnapshotStore(database).get('a', id);
  }
});
it('previews source counts and date mode without writing a snapshot or changing the source', async () => {
  const { service, task, db } = await fixture();
  await task('open', { day: '2026-11-01' });
  await task('done', { completed: true });
  expect(
    await service.previewSource(
      'a',
      { listId: 'list-a', listRevision: 1, includeCompleted: false, dateMode: 'none' },
      context,
    ),
  ).toMatchObject({ taskCount: 1, listCount: 1, dateMode: 'none', sourceDatedCount: 1 });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_template_snapshots').first('n')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(2);
});
