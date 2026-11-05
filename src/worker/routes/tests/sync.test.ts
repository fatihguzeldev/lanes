import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAccount, testDatabase } from '../../../../tests/support/sqlite-d1';
import type { ConnectionSummary } from '../../../modules/accounts/contracts/connection';
import type { Services } from '../../composition/services';
import { syncRoute } from '../sync';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => open.splice(0).forEach((database) => database.close()));

describe('foreground sync HTTP responses', () => {
  it.each(['sync', 'sync/advance'])(
    'includes scheduling status in an opted-in %s response without another read',
    async (path) => {
      const database = testDatabase();
      open.push(database);
      await seedAccount(database.db);
      const progress = { accountId: 'account-a', phase: 'tasks', continued: true };
      const status = {
        initialized: true,
        pending: true,
        nextAttemptAt: 1234,
        phase: 'tasks',
        errorCode: null,
      };
      const getStatus = vi.fn().mockResolvedValue(status);
      const markWorkspaceInitialized = vi.fn();
      const services = {
        sync: {
          requestRefresh: vi.fn(),
          advance: vi.fn().mockResolvedValue(progress),
          getStatus,
        },
        boards: { ensureMainBoard: vi.fn() },
        access: { markWorkspaceInitialized },
      } as unknown as Pick<Services, 'sync' | 'boards' | 'access'>;
      const url = new URL(`https://lanes.example/api/accounts/account-a/${path}?status=1`);
      const response = await syncRoute(
        {
          url,
          route: url.pathname.split('/').filter(Boolean),
          request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(path === 'sync' ? { reason: 'entry' } : {}),
          }),
          account: { id: 'account-a', state: 'connected' } as ConnectionSummary,
          ownerSubject: 'owner',
        },
        services,
        database.db,
      );
      expect(await response!.json()).toEqual({ ...progress, status });
      expect(getStatus).toHaveBeenCalledExactlyOnceWith('account-a');
      expect(markWorkspaceInitialized).toHaveBeenCalledExactlyOnceWith('account-a');
    },
  );

  it('keeps the existing advance response for clients that do not request status', async () => {
    const database = testDatabase();
    open.push(database);
    const progress = { accountId: 'account-a', phase: 'idle', continued: false };
    const services = {
      sync: {
        advance: vi.fn().mockResolvedValue(progress),
        getStatus: vi.fn().mockResolvedValue({ initialized: false }),
      },
      access: { markWorkspaceInitialized: vi.fn() },
    } as unknown as Pick<Services, 'sync' | 'boards' | 'access'>;
    const url = new URL('https://lanes.example/api/accounts/account-a/sync/advance');
    const response = await syncRoute(
      {
        url,
        route: url.pathname.split('/').filter(Boolean),
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        account: { id: 'account-a' } as ConnectionSummary,
        ownerSubject: 'owner',
      },
      services,
      database.db,
    );
    expect(await response!.json()).toEqual(progress);
  });
});
