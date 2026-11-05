import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

afterEach(() => vi.unstubAllGlobals());

describe('workspace startup', () => {
  it('keeps the workspace layout while the owner session is being checked', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('workspace__sidebar');
    expect(html).toContain('workspace__topbar');
    expect(html).toContain('board-column--skeleton');
    expect(html).toContain('aria-busy="true"');
    for (const label of [
      'today',
      'starred',
      'your boards',
      'search tasks',
      'add a task',
      'new list',
    ])
      expect(html).toContain(label);
    expect(html).not.toContain('entry-paper');
    expect(html).not.toContain('opening your workspace');
  });

  it('ignores invalid stored identity data and keeps loading controls inert', () => {
    const storage = { getItem: () => 'remembered-private-account' };
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', storage);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain('remembered-private-account');
    expect(html).toContain('class="workspace__sidebar" aria-hidden="true" inert=""');
    expect(html).toContain('class="workspace__main" aria-hidden="true" inert=""');
    const controls = html.match(/<(?:button|input|select)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => /tabindex="-1"|disabled=""/.test(control))).toBe(true);
  });

  it('retains only the avatar initial while session authorization is pending', () => {
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
    expect(html).toContain('<span class="account-menu__avatar">F</span>');
    expect(html).not.toContain('private-account');
    expect(html).not.toContain('aria-label="workspace navigation"');
  });
});
