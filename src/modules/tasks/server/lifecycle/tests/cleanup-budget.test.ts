import { expect, it } from 'vitest';
import { createOperationStore } from '../../../../../../tests/support/operation-store';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { TaskQueries } from '../../queries/tasks';
import { TasksLifecycle } from '../account';

it('budgets hierarchy generation updates when every selected child belongs to a different list', async () => {
  const f = testDatabase();
  try {
    await seedAccount(f.db, 'remove');
    f.sqlite.exec(`
      WITH RECURSIVE ids(n) AS(SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<99)
      INSERT INTO tasks_lists(id,account_id,provider_id,title)
      SELECT 'list-'||n,'remove','list-'||n,'list' FROM ids;
      INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title)
      SELECT 'parent-'||id,account_id,id,'parent-'||id,'parent' FROM tasks_lists;
      INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title)
      SELECT 'child-'||id,account_id,id,'parent-'||id,'child-'||id,'child' FROM tasks_lists;
      UPDATE accounts_connections SET state='disconnected',removal_requested_at=1 WHERE id='remove';
    `);
    const lifecycle = new TasksLifecycle(f.db, {
      operations: createOperationStore(f.db),
      commands: {
        advance: async () => {
          throw new Error('no provider work');
        },
      },
    });
    for (const remaining of [50, 0]) {
      const before = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      await lifecycle.remove('remove', 100);
      expect(
        (f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - before,
      ).toBeLessThanOrEqual(100);
      expect(
        await f.db
          .prepare('SELECT COUNT(*) AS n FROM tasks_tasks WHERE parent_id IS NOT NULL')
          .first('n'),
      ).toBe(remaining);
    }
  } finally {
    f.close();
  }
});

it.each([1, 100])(
  'bounds trigger writes while cleaning task labels, dependencies and tasks with record limit %i',
  async (limit) => {
    const f = testDatabase();
    const now = Date.parse('2026-11-10T15:00:00Z');
    try {
      await seedAccount(f.db, 'remove', now);
      await seedAccount(f.db, 'keep', now);
      for (const account of ['remove', 'keep'])
        await f.db
          .prepare(
            'INSERT INTO tasks_lists(id,account_id,provider_id,title,tasks_complete_at,completed_complete_at) VALUES(?,?,?,?,?,?)',
          )
          .bind(account, account, account, account, now, now)
          .run();
      const size = limit === 1 ? 4 : 120;
      await f.db
        .prepare(
          `WITH RECURSIVE ids(n) AS(SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<?)
           INSERT INTO tasks_tasks(id,account_id,list_id,parent_id,provider_id,title,provider_position)
           SELECT 'remove-'||n,'remove','remove',CASE WHEN n>0 THEN 'remove-0' END,'remove-'||n,'task',printf('%03d',n) FROM ids`,
        )
        .bind(size - 1)
        .run();
      await f.db
        .prepare(
          `INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES('label','remove','label','label','#123456')`,
        )
        .run();
      await f.db
        .prepare(
          "INSERT INTO tasks_task_labels(account_id,task_id,label_id) SELECT account_id,id,'label' FROM tasks_tasks WHERE account_id='remove'",
        )
        .run();
      await f.db
        .prepare(
          "INSERT INTO tasks_dependencies(account_id,task_id,blocker_id) SELECT account_id,id,'remove-0' FROM tasks_tasks WHERE account_id='remove' AND id<>'remove-0'",
        )
        .run();
      for (const id of ['one', 'two', 'three'])
        await f.db
          .prepare(
            'INSERT INTO tasks_tasks(id,account_id,list_id,provider_id,title,provider_position) VALUES(?,?,?,?,?,?)',
          )
          .bind(id, 'keep', 'keep', id, id, id)
          .run();
      const queries = new TaskQueries(f.db);
      const input = { listIds: ['keep'], limit: 2 };
      const context = { today: '2026-11-10', now };
      const first = await queries.listTasks('keep', input, context);
      const initialRevision = await f.db
        .prepare("SELECT query_revision FROM tasks_lists WHERE id='remove'")
        .first<number>('query_revision');
      await f.db
        .prepare(
          "UPDATE accounts_connections SET state='disconnected',removal_requested_at=? WHERE id='remove'",
        )
        .bind(now)
        .run();
      const lifecycle = new TasksLifecycle(f.db, {
        operations: createOperationStore(f.db),
        commands: {
          advance: async () => {
            throw new Error('no provider work');
          },
        },
        now: () => now,
      });
      const beforeHierarchy = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
      await lifecycle.remove('remove', limit);
      expect(
        (f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - beforeHierarchy,
      ).toBeLessThanOrEqual(100);
      expect(
        await f.db
          .prepare("SELECT query_revision FROM tasks_lists WHERE id='remove'")
          .first<number>('query_revision'),
      ).toBeGreaterThan(initialRevision!);
      const counts = () =>
        ['tasks_task_labels', 'tasks_dependencies', 'tasks_tasks'].map(
          (table) =>
            f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id='remove'`).get()
              ?.n as number,
        );
      const phases = new Set<number>();
      let invalidated = false;
      let done = false;
      for (let step = 0; step < 50; step++) {
        const beforeCounts = counts();
        const before = f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number;
        const result = await lifecycle.remove('remove', limit);
        const writes =
          (f.sqlite.prepare('SELECT total_changes() AS n').get()?.n as number) - before;
        expect(writes).toBeLessThanOrEqual(100);
        expect(result.deleted).toBeLessThanOrEqual(limit);
        counts().forEach((count, index) => {
          if (count < beforeCounts[index]!) phases.add(index);
        });
        const revision = await f.db
          .prepare("SELECT query_revision FROM tasks_lists WHERE id='remove'")
          .first<number>('query_revision');
        invalidated ||= revision !== null && revision > initialRevision!;
        if (result.done) {
          done = true;
          break;
        }
      }
      expect(done).toBe(true);
      expect([...phases].sort()).toEqual([0, 1, 2]);
      expect(invalidated).toBe(true);
      expect(counts()).toEqual([0, 0, 0]);
      const next = await queries.listTasks(
        'keep',
        { ...input, cursor: first.nextCursor! },
        context,
      );
      expect(next.items).toHaveLength(1);
      expect(next.nextCursor).toBeNull();
    } finally {
      f.close();
    }
  },
);
