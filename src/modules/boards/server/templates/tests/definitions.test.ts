import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { ListSnapshotStore } from '../../../../tasks/server/templates/lists';
import { BoardTemplateService, readTemplateListAppearance } from '../definitions';
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
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = testDatabase();
  databases.push(database);
  const { db } = database;
  await seedAccount(db, 'a', now);
  await seedAccount(db, 'b', now);
  await db
    .prepare(
      "INSERT INTO boards_boards(id,account_id,title,position,created_at,emoji,color,background_url) VALUES ('source','a','home',0,?,'🌱','#dce3d3','https://example.com/image.webp')",
    )
    .bind(now)
    .run();
  for (const [index, key] of ['one', 'two'].entries()) {
    await db
      .prepare(
        'INSERT INTO tasks_lists(id,account_id,provider_id,title,revision,tasks_complete_at,completed_complete_at) VALUES (?,?,?,?,1,?,?)',
      )
      .bind(key, 'a', `provider-${key}`, 'equal title', now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO boards_memberships(account_id,list_id,board_id,position,color) VALUES ('a',?,'source',?,?)",
      )
      .bind(key, 1 - index, index ? '#bbaabb' : '#aabbcc')
      .run();
    await db
      .prepare(
        'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title) VALUES (?,?,?,?,?)',
      )
      .bind(`task-${key}`, 'a', key, `provider-task-${key}`, key)
      .run();
  }
  const snapshots = new ListSnapshotStore(db),
    service = new BoardTemplateService(db, {
      snapshots,
      commitWrites: (writes) => db.batch(writes),
    });
  return { ...database, snapshots, service };
}
const input = { name: 'at home', boardId: 'source', boardRevision: 0 };
describe('board template composition', () => {
  it('captures appearance, list order/colors and equal-title identities without a live source link', async () => {
    const { service, snapshots, db } = await fixture();
    const saved = await service.create('a', input, context);
    expect(saved).toMatchObject({
      kind: 'board',
      snapshot: { listCount: 2, taskCount: 2 },
      appearance: {
        title: 'home',
        emoji: '🌱',
        color: '#dce3d3',
        backgroundUrl: 'https://example.com/image.webp',
      },
    });
    const lists = (await snapshots.listLists('a', saved.snapshot.id)).items;
    expect(lists.map((list) => list.color)).toEqual(['#bbaabb', '#aabbcc']);
    expect(lists[0]?.key).not.toBe(lists[1]?.key);
    await db.prepare("DELETE FROM boards_memberships WHERE board_id='source'").run();
    await db.prepare("DELETE FROM boards_boards WHERE id='source'").run();
    expect((await service.get('a', saved.id)).snapshot.taskCount).toBe(2);
    await expect(service.get('b', saved.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('aborts a snapshot when source membership changed before its atomic commit', async () => {
    const { service, snapshots, db } = await fixture();
    const raced = new BoardTemplateService(db, {
      snapshots,
      commitWrites: async (writes) => {
        await db
          .prepare(
            "UPDATE boards_memberships SET revision=revision+1,color='#fff' WHERE list_id='one'",
          )
          .run();
        return db.batch(writes);
      },
    });
    await expect(raced.create('a', input, context)).rejects.toMatchObject({ code: 'conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM boards_templates').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_template_nodes').first('n')).toBe(0);
  });
  it('preserves replacement revisions and keeps pinned run content after reusable deletion', async () => {
    const { service, snapshots, db, sqlite } = await fixture();
    const saved = await service.create('a', input, context);
    await db.batch([snapshots.pinWrite('a', saved.snapshot.id, 'run:unfinished')]);
    const pinnedTasks = (await snapshots.listTasks('a', saved.snapshot.id)).items,
      pinnedLists = (await snapshots.listLists('a', saved.snapshot.id)).items;
    const drain = async (snapshotId: string, protectPinned: boolean) => {
      for (let slice = 0; slice < 20; slice++) {
        if (
          !(await db
            .prepare('SELECT id FROM tasks_template_snapshots WHERE account_id=? AND id=?')
            .bind('a', snapshotId)
            .first())
        )
          break;
        const before = sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
        await snapshots.cleanup(100);
        const after = sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
        expect(after - before).toBeLessThanOrEqual(100);
        if (protectPinned) {
          expect(await snapshots.get('a', saved.snapshot.id)).toEqual(saved.snapshot);
          expect((await snapshots.listTasks('a', saved.snapshot.id)).items).toEqual(pinnedTasks);
          expect((await snapshots.listLists('a', saved.snapshot.id)).items).toEqual(pinnedLists);
          expect(
            await db
              .prepare(
                "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE snapshot_id=? AND owner_key='run:unfinished'",
              )
              .bind(saved.snapshot.id)
              .first('n'),
          ).toBe(1);
        }
      }
      await expect(snapshots.get('a', snapshotId)).rejects.toMatchObject({ code: 'not_found' });
    };
    const next = await service.replace(
      'a',
      saved.id,
      { boardId: 'source', boardRevision: 0, dateMode: 'none' },
      0,
      { ...context, stepKey: 'replace' },
    );
    expect(next).toMatchObject({ revision: 1, contentRevision: 2 });
    expect((await service.getVersion('a', saved.id, 1)).snapshot.id).toBe(saved.snapshot.id);
    await service.delete('a', saved.id, 1, { ...context, stepKey: 'delete' });
    await drain(next.snapshot.id, true);
    await db.batch([snapshots.releasePinWrite('a', saved.snapshot.id, 'run:unfinished')]);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks_template_snapshot_pins WHERE snapshot_id=? AND owner_key='run:unfinished'",
        )
        .bind(saved.snapshot.id)
        .first('n'),
    ).toBe(0);
    await drain(saved.snapshot.id, false);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').first('n')).toBe(2);
  });
  it('supplies account-scoped list appearance with an atomic source revision fence', async () => {
    const { db } = await fixture();
    const appearance = await readTemplateListAppearance(db, 'a', 'one');
    expect(appearance.color).toBe('#aabbcc');
    await db.prepare("UPDATE boards_memberships SET revision=revision+1 WHERE list_id='one'").run();
    await expect(db.batch(appearance.guardWrites)).rejects.toThrow();
    await expect(readTemplateListAppearance(db, 'b', 'one')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
