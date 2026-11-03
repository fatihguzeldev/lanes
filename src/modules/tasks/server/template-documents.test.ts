import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/sqlite-d1';
import { ListSnapshotStore, ListTemplateService } from './list-templates';
import { TemplateDocumentStore } from './template-documents';
import {
  TemplateDocumentHeaderSchema,
  TemplateTaskSchema,
  type TemplateTask,
} from '../template-contract';
import { BoardTemplateService } from '../../boards/server/templates';
import { invocationDatabase } from '../../../../tests/d1-invocation';
const now = Date.parse('2026-11-02T12:00:00Z'),
  context = {
    operationId: 'capture',
    stepKey: 'one',
    origin: 'owner' as const,
    recordedAt: new Date(now).toISOString(),
    saveDay: '2026-11-02',
    zone: 'Europe/Istanbul',
  };
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a', now);
  await seedAccount(database.db, 'b', now);
  const snapshots = new ListSnapshotStore(database.db),
    documents = new TemplateDocumentStore(database.db, {
      snapshots,
      commitWrites: (writes) => database.db.batch(writes),
    }),
    lists = new ListTemplateService(database.db, {
      snapshots,
      sourceListAppearance: async () => ({ color: '#fff', guardWrites: [] }),
      commitWrites: (writes) => database.db.batch(writes),
    }),
    boards = new BoardTemplateService(database.db, {
      snapshots,
      commitWrites: (writes) => database.db.batch(writes),
    });
  return { ...database, snapshots, documents, lists, boards };
}
const header = (count = 2) => ({
  schemaVersion: 1 as const,
  dateMode: 'relative' as const,
  saveDay: '2026-11-02',
  zone: 'Europe/Istanbul',
  listCount: 1,
  taskCount: count,
});
const list = { key: 'list', title: 'a list', color: '#aabbcc', position: 0 };
const task = (key: string, position: number, fields: Partial<TemplateTask> = {}): TemplateTask => ({
  key,
  listKey: 'list',
  parentKey: null,
  position,
  title: key,
  notes: 'plain\nnotes',
  dayOffset: 0,
  scheduledTime: null,
  timeZone: null,
  repeatPreset: null,
  labels: [],
  priority: 'none',
  starred: false,
  dependencyKeys: [],
  ...fields,
});
describe('bounded declarative template staging', () => {
  // the timeout covers staging and all checkpoints; each invocation keeps its query budget.
  for (const count of [500, 2000])
    it(`validates ${count} chained template tasks through bounded checkpoints while the snapshot stays hidden`, async () => {
      const f = await fixture();
      await f.documents.begin('a', header(count), context, 'snapshot');
      await f.documents.appendLists('a', 'snapshot', [list]);
      for (let offset = 0; offset < count; offset += 10)
        await f.documents.appendTasks(
          'a',
          'snapshot',
          Array.from({ length: 10 }, (_, n) =>
            task('n' + (offset + n), offset + n, {
              dependencyKeys: offset + n ? ['n' + (offset + n - 1)] : [],
            }),
          ),
        );
      let sealed = false,
        slices = 0;
      while (!sealed && slices++ < 250) {
        const invocation = invocationDatabase(f.db, 35),
          snapshots = new ListSnapshotStore(invocation.db),
          documents = new TemplateDocumentStore(invocation.db, {
            snapshots,
            commitWrites: (writes) => invocation.db.batch(writes),
          });
        const result = await documents.seal('a', 'snapshot');
        sealed = result.sealed;
        expect(invocation.queries).toBeLessThanOrEqual(35);
        if (!sealed) {
          expect(result.snapshot).toBeNull();
          await expect(f.snapshots.get('a', 'snapshot')).rejects.toMatchObject({
            code: 'not_found',
          });
          await expect(
            f.lists.createFromSnapshot('a', 'snapshot', { name: 'too soon' }, context),
          ).rejects.toMatchObject({ code: 'not_found' });
        }
      }
      expect(sealed).toBe(true);
      expect(slices).toBeGreaterThan(1);
      expect((await f.snapshots.get('a', 'snapshot')).taskCount).toBe(count);
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM tasks_template_nodes WHERE snapshot_id='snapshot'")
          .first('n'),
      ).toBe(count);
      expect(await f.documents.seal('a', 'snapshot')).toMatchObject({
        sealed: true,
        validation: { stage: 'ready', checkedTasks: count, remainingTasks: 0 },
      });
      const before = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      await f.snapshots.cleanup(1);
      expect(
        (f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - before,
      ).toBeLessThanOrEqual(1);
      expect((await f.snapshots.get('a', 'snapshot')).taskCount).toBe(count);
    }, 30_000);
  it('captures resumable chunks, hides incomplete snapshots and keeps exact source content provider-free', async () => {
    const f = await fixture();
    await f.documents.begin('a', header(12), context, 'snapshot');
    await f.documents.appendLists('a', 'snapshot', [list]);
    await f.documents.appendTasks(
      'a',
      'snapshot',
      Array.from({ length: 10 }, (_, index) => task('task-' + index, index)),
    );
    await expect(f.snapshots.get('a', 'snapshot')).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.documents.seal('a', 'snapshot')).rejects.toMatchObject({ code: 'conflict' });
    const reloaded = new TemplateDocumentStore(f.db, {
      snapshots: f.snapshots,
      commitWrites: (writes) => f.db.batch(writes),
    });
    await reloaded.appendTasks('a', 'snapshot', [task('task-10', 10), task('task-11', 11)]);
    await reloaded.seal('a', 'snapshot');
    const first = await f.snapshots.listTasks('a', 'snapshot');
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();
    expect(
      (await f.snapshots.listTasks('a', 'snapshot', { cursor: first.nextCursor! })).items,
    ).toHaveLength(2);
    await expect(f.snapshots.listTasks('b', 'snapshot')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(JSON.stringify(first)).not.toMatch(/providerId|credentials|history/);
  });
  it('rejects unknown future versions, executable/credential fields and invalid reusable metadata', () => {
    expect(TemplateDocumentHeaderSchema.safeParse({ ...header(), schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(
      TemplateTaskSchema.safeParse({ ...task('one', 0), providerId: 'live-task' }).success,
    ).toBe(false);
    expect(
      TemplateTaskSchema.safeParse({ ...task('one', 0), execute: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      TemplateTaskSchema.safeParse(
        task('one', 0, {
          labels: [
            { name: 'École', color: '#000' },
            { name: 'e\u0301COLE', color: '#fff' },
          ],
        }),
      ).success,
    ).toBe(false);
  });
  it('rejects graph cycles/deeper hierarchy before sealing, and no-date documents cannot hide active scheduling', async () => {
    const f = await fixture();
    await f.documents.begin('a', header(), context, 'snapshot');
    await f.documents.appendLists('a', 'snapshot', [list]);
    await f.documents.appendTasks('a', 'snapshot', [
      task('one', 0, { dependencyKeys: ['two'] }),
      task('two', 1, { dependencyKeys: ['one'] }),
    ]);
    await expect(f.documents.seal('a', 'snapshot')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await f.documents.begin('a', { ...header(1), dateMode: 'none' }, context, 'none');
    await f.documents.appendLists('a', 'none', [list]);
    await expect(f.documents.appendTasks('a', 'none', [task('one', 0)])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
  it('bounds each chunk to ten records and 64 kib, while large pages shrink without truncation', async () => {
    const f = await fixture();
    await f.documents.begin('a', header(8), context, 'snapshot');
    await f.documents.appendLists('a', 'snapshot', [list]);
    await expect(
      f.documents.appendTasks(
        'a',
        'snapshot',
        Array.from({ length: 11 }, (_, index) => task(String(index), index)),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const nodes = Array.from({ length: 8 }, (_, index) =>
      task(String(index), index, { notes: 'a'.repeat(8192) }),
    );
    await expect(f.documents.appendTasks('a', 'snapshot', nodes)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    for (let index = 0; index < nodes.length; index += 2)
      await f.documents.appendTasks('a', 'snapshot', nodes.slice(index, index + 2));
    await f.documents.seal('a', 'snapshot');
    const first = await f.snapshots.listTasks('a', 'snapshot');
    expect(first.items.length).toBeLessThan(8);
    const second = await f.snapshots.listTasks('a', 'snapshot', { cursor: first.nextCursor! });
    expect(first.items.length + second.items.length).toBe(8);
  });
  it('pins in-progress and sealed input until an owning personal template takes over', async () => {
    const f = await fixture();
    await f.documents.begin('a', header(1), context, 'snapshot');
    await f.documents.appendLists('a', 'snapshot', [list]);
    await f.documents.appendTasks('a', 'snapshot', [task('one', 0)]);
    await f.snapshots.cleanup();
    await f.documents.seal('a', 'snapshot');
    await f.snapshots.cleanup();
    const personal = await f.lists.createFromSnapshot(
      'a',
      'snapshot',
      { name: 'restored' },
      context,
    );
    expect(personal.snapshot.taskCount).toBe(1);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE owner_key='document:snapshot'",
        )
        .first('n'),
    ).toBe(0);
    await f.lists.delete('a', personal.id, 0, context);
    for (let i = 0; i < 10; i++) await f.snapshots.cleanup();
    await expect(f.snapshots.get('a', 'snapshot')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('saves every bundled starter through normal validation as an independent personal snapshot', async () => {
    const f = await fixture();
    for (const entry of f.lists.gallery()) {
      const saved = await f.lists.saveGallery('a', entry.id, context);
      expect(saved.snapshot.taskCount).toBe(entry.document.tasks.length);
      expect(saved.snapshot.zone).toBe('Europe/Istanbul');
    }
    for (const entry of f.boards.gallery()) {
      const saved = await f.boards.saveGallery('a', entry.id, context);
      expect(saved.snapshot.listCount).toBe(entry.document.lists.length);
      expect(saved.appearance).toEqual(entry.appearance);
    }
    expect(await f.db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(0);
  });
  it('removes account content in a strict shared row budget without cascading source/provider data', async () => {
    const f = await fixture();
    await f.documents.begin('a', header(120), context, 'snapshot');
    await f.documents.appendLists('a', 'snapshot', [list]);
    for (let start = 0; start < 120; start += 10)
      await f.documents.appendTasks(
        'a',
        'snapshot',
        Array.from({ length: 10 }, (_, index) => task(String(start + index), start + index)),
      );
    for (let i = 0; i < 10; i++) if ((await f.documents.seal('a', 'snapshot')).sealed) break;
    await f.lists.createFromSnapshot('a', 'snapshot', { name: 'large' }, context);
    const first = await f.snapshots.removeAccountSlice('a', 100);
    expect(first).toMatchObject({ done: false, deleted: 100 });
    const second = await f.snapshots.removeAccountSlice('a', 100);
    expect(second.deleted).toBeLessThanOrEqual(100);
    let done = second.done;
    for (let i = 0; i < 10 && !done; i++) {
      const before = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      const next = await f.snapshots.removeAccountSlice('a', 100);
      expect(
        (f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - before,
      ).toBeLessThanOrEqual(100);
      done = next.done;
    }
    expect(done).toBe(true);
    expect(
      await f.db.prepare("SELECT COUNT(*) AS n FROM accounts_connections WHERE id='a'").first('n'),
    ).toBe(1);
  });
});

it('restores an explicitly selected replacement as a new immutable content revision without resetting names', async () => {
  const f = await fixture();
  const saved = await f.lists.saveGallery('a', f.lists.gallery()[0]!.id, context);
  await f.documents.begin('a', header(1), context, 'incoming');
  await f.documents.appendLists('a', 'incoming', [list]);
  await f.documents.appendTasks('a', 'incoming', [task('replacement', 0)]);
  await f.documents.seal('a', 'incoming');
  const replaced = await f.lists.replaceFromSnapshot('a', saved.id, 'incoming', 0, context);
  expect(replaced).toMatchObject({
    name: saved.name,
    contentRevision: 2,
    revision: 1,
    snapshot: { id: 'incoming' },
  });
  expect((await f.lists.getVersion('a', saved.id, 1)).snapshot.id).toBe(saved.snapshot.id);
  await expect(
    f.lists.replaceFromSnapshot('a', saved.id, 'incoming', 0, context),
  ).rejects.toMatchObject({ code: 'conflict' });
});
