import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

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

  it('shows no remembered account data or usable controls before session authorization', () => {
    const storage = { getItem: () => 'remembered-private-account' };
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', storage);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain('remembered-private-account');
    expect(html).not.toMatch(/<(?:button|input|select)\b/);
  });
});
