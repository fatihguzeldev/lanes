import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { HistoryService } from '../../../../history/server/events/event-store';
import type { GoogleTaskDTO } from '../../provider/google-tasks';
import { TaskProjectionStore } from '../store';

const at = Date.parse('2026-11-05T12:00:00Z');
const task: GoogleTaskDTO = {
  id: 'google-task',
  title: 'task',
  notes: 'notes',
  status: 'needsAction',
  etag: 'v1',
  position: '001',
};

describe('confirmed projection changes', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let projection: TaskProjectionStore;

  beforeEach(async () => {
    fixture = testDatabase();
    await seedAccount(fixture.db, 'account', at);
    await fixture.db
      .prepare('INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES (?,?,?,?)')
      .bind('list', 'account', 'google-list', 'list')
      .run();
    projection = new TaskProjectionStore(fixture.db, {
      history: new HistoryService(fixture.db, { now: () => at }),
      now: () => at,
    });
  });
  afterEach(() => fixture.close());

  async function confirm(records: GoogleTaskDTO[]) {
    const prepared = await projection.prepareConfirmedWrites('account', 'list', records, {
      scanId: 'scan',
      observed: true,
    });
    await fixture.db.batch(prepared.writes);
    return prepared;
  }

  it('reports new tasks but not identical observations or scan bookkeeping', async () => {
    expect((await confirm([task])).changed).toBe(true);
    await fixture.db
      .prepare("UPDATE tasks_tasks SET priority='high',starred=1,last_seen_scan='other'")
      .run();
    expect((await confirm([task])).changed).toBe(false);
  });

  it.each([
    { title: 'changed' },
    { notes: 'changed' },
    { etag: 'v2' },
    { updated: '2026-11-05T12:01:00Z' },
    { position: '002' },
    { hidden: true },
    { status: 'completed' as const, completed: '2026-11-05T12:01:00Z' },
    { due: '2026-11-06T00:00:00Z' },
    { parent: 'missing-parent' },
    { assignmentInfo: { surfaceType: 'DOCUMENT' as const } },
  ])('reports changed provider fields: %j', async (patch) => {
    await confirm([task]);
    expect((await confirm([{ ...task, ...patch }])).changed).toBe(true);
  });

  it('reports disappearance and restoration while repeated deletion stays unchanged', async () => {
    await confirm([task]);
    const deleted = { ...task, deleted: true };
    expect((await confirm([deleted])).changed).toBe(true);
    expect((await confirm([deleted])).changed).toBe(false);
    expect((await confirm([task])).changed).toBe(true);
  });

  it('reports a missing-address recovery with an otherwise identical task', async () => {
    await confirm([task]);
    await fixture.db.prepare('UPDATE tasks_tasks SET provider_missing_at=?').bind(at).run();
    expect((await confirm([task])).changed).toBe(true);
  });

  it('reports a cleared retained time zone even if the provider day was already absent', async () => {
    await confirm([task]);
    await fixture.db.prepare("UPDATE tasks_tasks SET time_zone='UTC'").run();
    expect((await confirm([task])).changed).toBe(true);
    expect((await confirm([task])).changed).toBe(false);
  });

  it('reports a checklist repair outside the incoming page without invalidating healthy checklists', async () => {
    const child = { ...task, id: 'google-child', parent: task.id };
    await confirm([task, child]);
    expect((await confirm([task])).changed).toBe(false);
    await fixture.db
      .prepare('UPDATE tasks_tasks SET parent_id=NULL,unsupported_hierarchy=1 WHERE provider_id=?')
      .bind(child.id)
      .run();
    expect((await confirm([task])).changed).toBe(true);
    expect((await confirm([task])).changed).toBe(false);
  });

  it('reports nested-child capability repairs outside the incoming records', async () => {
    const child = { ...task, id: 'google-child', parent: task.id };
    const nested = { ...task, id: 'google-nested', parent: child.id };
    await confirm([task, child, nested]);
    await fixture.db
      .prepare('UPDATE tasks_tasks SET unsupported_hierarchy=0 WHERE provider_id=?')
      .bind(nested.id)
      .run();
    expect((await confirm([child])).changed).toBe(true);
    expect((await confirm([child])).changed).toBe(false);
  });

  it('ignores another account when checking for checklist repairs', async () => {
    await confirm([task]);
    await seedAccount(fixture.db, 'other-account', at);
    await fixture.db
      .prepare('INSERT INTO tasks_lists(id,account_id,provider_id,title) VALUES (?,?,?,?)')
      .bind('other-list', 'other-account', 'google-list', 'list')
      .run();
    const other = await projection.prepareConfirmedWrites('other-account', 'other-list', [
      task,
      { ...task, id: 'google-child', parent: task.id },
    ]);
    await fixture.db.batch(other.writes);
    await fixture.db
      .prepare(
        "UPDATE tasks_tasks SET parent_id=NULL,unsupported_hierarchy=1 WHERE account_id='other-account' AND provider_id='google-child'",
      )
      .run();
    expect((await confirm([task])).changed).toBe(false);
  });

  it('preserves missing provider fields without reporting a change', async () => {
    await confirm([task]);
    const prepared = await projection.prepareConfirmedWrites(
      'account',
      'list',
      [{ id: task.id, etag: task.etag, position: task.position }],
      { preserveMissingFields: true },
    );
    expect(prepared.changed).toBe(false);
  });
});
