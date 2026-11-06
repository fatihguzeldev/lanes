import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../../../modules/accounts/contracts/session';
import type { ConnectionSummary } from '../../../modules/accounts/contracts/connection';
import { App } from '../App';

const owner = vi.hoisted(() => ({
  session: null as SessionSnapshot | null,
  selected: undefined as ConnectionSummary | undefined,
  loadingInitial: null as string | null,
  error: '',
  authorizationError: '',
  pending: false,
  clockOffset: 0,
  load: async () => {},
  selectAccount() {},
  signOut() {},
  authorize: async () => {},
  loadMoreAccounts() {},
  dismissError() {},
}));
vi.mock('../../../modules/accounts/browser/session/useOwnerSession', () => ({
  useOwnerSession: () => owner,
}));
const account: ConnectionSummary = {
  id: 'account',
  email: 'owner@example.com',
  displayName: 'Fatih',
  pictureUrl: null,
  state: 'connected',
  permissions: { tasks: true, sheetsImport: false, sheetsExport: false },
  grantExpiresAt: null,
  planningZone: 'UTC',
  weekStart: 1,
  revision: 1,
};
const accounts = (items: ConnectionSummary[]) => ({
  items,
  nextCursor: null,
  coverage: { complete: true, lastSyncedAt: null, stale: false },
});
const render = () => renderToStaticMarkup(createElement(App));

describe('confirmed entry screen', () => {
  beforeEach(() => {
    owner.session = null;
    owner.selected = undefined;
    owner.loadingInitial = null;
  });
  it.each([false, true])(
    'opens sign-in without a connected account, authenticated=%s',
    (authenticated) => {
      owner.session = {
        configured: true,
        authenticated,
        serverTime: 0,
        ...(authenticated ? { accounts: accounts([]) } : {}),
      };
      const html = render();
      expect(html).toContain('continue with google');
      expect(html).not.toContain('workspace-skeleton');
      expect(html).not.toContain('aria-busy="true"');
    },
  );
  it('keeps the account initial in the authorized workspace fallback', () => {
    owner.session = {
      configured: true,
      authenticated: true,
      serverTime: 0,
      accounts: accounts([account]),
    };
    owner.selected = account;
    owner.loadingInitial = 'F';
    const html = render();
    expect(html).toContain('workspace-skeleton');
    expect(html).toContain('<span class="account-menu__avatar">F</span>');
    expect(html).not.toContain('entry-paper');
  });
});
