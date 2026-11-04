import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTheme, useTheme } from './theme';

afterEach(() => vi.unstubAllGlobals());

describe('theme preference', () => {
  it('follows OS changes while the preference is system', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
  });

  it('retains a manual selection when the OS preference changes', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('starts from the persisted manual preference before rendering the toggle', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'dark' });
    function Probe() {
      const [preference, , resolved] = useTheme();
      return `${preference}:${resolved}`;
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('dark:dark');
  });

  it('keeps the system default when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('storage unavailable');
      },
    });
    function Probe() {
      return useTheme()[0];
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('system');
  });
});
