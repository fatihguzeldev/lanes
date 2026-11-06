import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

afterEach(() => vi.unstubAllGlobals());

describe('workspace startup', () => {
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
