import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '../../../modules/accounts/contracts/connection';
import { Workspace } from '../Workspace';

const account: ConnectionSummary = {
  id: 'account',
  email: 'owner@example.com',
  displayName: 'owner',
  pictureUrl: null,
  state: 'connected',
  permissions: { tasks: true, sheetsImport: false, sheetsExport: false },
  grantExpiresAt: null,
  planningZone: 'UTC',
  weekStart: 1,
  revision: 0,
};
const noop = () => {};

describe('workspace loading shell', () => {
  it('keeps the mounted workspace inert until its coherent initial reveal', () => {
    const html = renderToStaticMarkup(
      createElement(Workspace, {
        account,
        accounts: [account],
        clockOffset: 0,
        theme: 'light',
        onTheme: noop,
        onSelectAccount: noop,
        onAuthorize: noop,
        onAccountsChanged: noop,
        onSignOut: noop,
      }),
    );
    expect(html).toMatch(/^<div class="workspace workspace--loading" inert="" aria-busy="true">/);
    expect(html).toContain('workspace workspace-skeleton');
    expect(html).toContain('aria-label="loading workspace"');
    expect(html).toContain('aria-label="workspace navigation"');
    for (const label of [
      'today',
      'starred',
      'your boards',
      'search tasks',
      'add a task',
      'new list',
    ])
      expect(html).toContain(label);
    expect(html).not.toContain('<div hidden=');
  });
});
