import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../../../tests/support/sqlite-d1';
import { databaseUsage } from '../database-usage';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => open.splice(0).forEach((fixture) => fixture.close()));
function fixture() {
  const value = testDatabase();
  open.push(value);
  return value.db;
}

describe('invocation database usage', () => {
  it('counts bound reads and writes when executed, without counting preparation', async () => {
    const usage = databaseUsage(fixture());
    const statement = usage.db.prepare('SELECT ? AS value').bind('bound');
    expect(usage.used).toBe(0);
    expect(await statement.first('value')).toBe('bound');
    expect(usage.used).toBe(1);
    expect((await statement.all()).results).toEqual([{ value: 'bound' }]);
    expect(usage.used).toBe(2);
    await usage.db.prepare('CREATE TABLE usage_probe (id TEXT)').run();
    expect(usage.used).toBe(3);
  });

  it('counts a batch as one invocation query regardless of its statement count', async () => {
    const usage = databaseUsage(fixture());
    const results = await usage.db.batch([
      usage.db.prepare('SELECT 1 AS value'),
      usage.db.prepare('SELECT 2 AS value'),
    ]);
    expect(results.map((result) => result.results)).toEqual([[{ value: 1 }], [{ value: 2 }]]);
    expect(usage.used).toBe(1);
  });

  it('includes failed attempts and queries through a database session in the same count', async () => {
    const database = fixture();
    const source = Object.assign({}, database, {
      withSession: () => ({
        prepare: database.prepare.bind(database),
        batch: database.batch.bind(database),
        getBookmark: () => 'bookmark',
      }),
    }) as D1Database;
    const usage = databaseUsage(source);
    await expect(usage.db.prepare('SELECT * FROM no_such_table').all()).rejects.toThrow();
    const session = usage.db.withSession();
    expect(await session.prepare('SELECT 3 AS value').first('value')).toBe(3);
    expect(session.getBookmark()).toBe('bookmark');
    expect(usage.used).toBe(2);
  });
});
