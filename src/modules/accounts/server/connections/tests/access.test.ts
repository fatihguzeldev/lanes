import { afterEach, beforeEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/support/sqlite-d1';
import { localWritableAccountsSql, readConnectionState } from '../access';

let database: ReturnType<typeof testDatabase>;
beforeEach(() => {
  database = testDatabase();
});
afterEach(() => database.close());

it('reads only connection state for background work and preserves a missing account', async () => {
  await seedAccount(database.db, 'account');
  await database.db
    .prepare('UPDATE accounts_connections SET grant_ciphertext=? WHERE id=?')
    .bind('private-encrypted-grant', 'account')
    .run();
  expect(await readConnectionState(database.db, 'account')).toEqual({ state: 'connected' });
  expect(await readConnectionState(database.db, 'missing')).toBeNull();
});

it('selects local work during grant expiry but excludes disconnecting and fenced accounts', async () => {
  const states = [
    'connecting',
    'connected',
    'reconnect_required',
    'temporarily_unavailable',
    'disconnecting',
    'disconnected',
  ];
  for (const state of states) {
    await seedAccount(database.db, state);
    await database.db
      .prepare('UPDATE accounts_connections SET state=? WHERE id=?')
      .bind(state, state)
      .run();
  }
  await seedAccount(database.db, 'disconnect-requested');
  await database.db
    .prepare('UPDATE accounts_connections SET disconnect_requested_at=? WHERE id=?')
    .bind(Date.now(), 'disconnect-requested')
    .run();
  const rows = await database.db
    .prepare(`SELECT account.id FROM (${localWritableAccountsSql}) account ORDER BY account.id`)
    .all<{ id: string }>();
  expect(rows.results.map((row) => row.id)).toEqual([
    'connected',
    'connecting',
    'reconnect_required',
    'temporarily_unavailable',
  ]);
});
