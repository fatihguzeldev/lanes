import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { ConnectionSummary } from '../../../modules/accounts/contracts/connection';

afterEach(() => vi.unstubAllGlobals());

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

describe('workspace startup', () => {
  it('starts an authorized document in its workspace shell on the first render', () => {
    const html = renderToStaticMarkup(
      createElement(App, {
        initialSession: {
          configured: true,
          authenticated: true,
          serverTime: Date.now(),
          accounts: accounts([account]),
        },
      }),
    );
    expect(html).toContain('workspace-skeleton');
    expect(html).toContain('account-menu__avatar">F</span>');
    expect(html).not.toContain('loading lanes');
  });
  it('keeps the shell while resolving a remembered account beyond the first page', () => {
    const storage = {
      getItem: (key: string) => (key === 'lanes.account' ? 'another-account' : null),
      setItem() {},
    };
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', storage);
    const html = renderToStaticMarkup(
      createElement(App, {
        initialSession: {
          configured: true,
          authenticated: true,
          serverTime: Date.now(),
          accounts: { ...accounts([account]), nextCursor: 'more' },
        },
      }),
    );
    expect(html).toContain('workspace-skeleton');
    expect(html).not.toContain('loading lanes');
    expect(html).not.toContain('your accounts');
  });

  it('shows sign-in from the document without another session gate', () => {
    const html = renderToStaticMarkup(
      createElement(App, {
        initialSession: { configured: true, authenticated: false, serverTime: Date.now() },
      }),
    );
    expect(html).toContain('continue with google');
    expect(html).not.toContain('loading lanes');
    expect(html).not.toContain('workspace-skeleton');
  });
  it('keeps a document error visible with a retry action', () => {
    const html = renderToStaticMarkup(createElement(App, { initialError: 'session unavailable' }));
    expect(html).toContain('session unavailable');
    expect(html).toContain('try again');
    expect(html).not.toContain('loading lanes');
  });

  it('waits for session authorization without guessing the destination screen', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="loading lanes"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('workspace-skeleton');
    expect(html).not.toContain('entry-paper');
    expect(html).not.toContain('continue with google');
    expect(html).not.toContain('opening your workspace');
  });

  it('ignores invalid stored identity data and keeps loading controls inert', () => {
    const storage = { getItem: () => 'remembered-private-account' };
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', storage);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain('remembered-private-account');
    const controls = html.match(/<(?:button|input|select)\b[^>]*>/g) ?? [];
    expect(controls).toHaveLength(0);
  });

  it('does not use a retained initial as proof of a current owner session', () => {
    const storage = {
      getItem: (key: string) =>
        key === 'lanes.account-initial'
          ? JSON.stringify({ accountId: 'private-account', initial: 'F' })
          : key === 'lanes.account'
            ? 'private-account'
            : null,
    };
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', storage);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain('account-menu__avatar');
    expect(html).not.toContain('workspace-skeleton');
    expect(html).not.toContain('private-account');
    expect(html).not.toContain('aria-label="workspace navigation"');
  });
});
