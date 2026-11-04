import { afterEach, expect, it } from 'vitest';
import { seedAccount, testDatabase } from '../../../../../../tests/sqlite-d1';
import { AccountsPortability } from '../portability';
const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
it('joins only validated preference fields to a revision-fenced owner transaction', async () => {
  const database = testDatabase();
  databases.push(database);
  await seedAccount(database.db, 'a');
  const owner = new AccountsPortability(database.db);
  expect(await owner.identity('a')).toMatchObject({
    googleSubject: 'subject-a',
    email: 'a@example.com',
  });
  await database.db.batch(
    await owner.preparePreferencesRestore('a', {
      revision: 0,
      planningZone: 'Europe/Istanbul',
      weekStart: 7,
    }),
  );
  expect(await owner.identity('a')).toMatchObject({
    planningZone: 'Europe/Istanbul',
    weekStart: 7,
  });
  await expect(
    database.db.batch(await owner.preparePreferencesRestore('a', { revision: 0, weekStart: 1 })),
  ).rejects.toThrow();
  await expect(
    owner.preparePreferencesRestore('a', { revision: 1, accessToken: 'secret' }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await database.db.prepare("UPDATE accounts_connections SET state='disconnected'").run();
  await expect(
    database.db.batch(await owner.preparePreferencesRestore('a', { revision: 1, weekStart: 1 })),
  ).rejects.toThrow();
});
