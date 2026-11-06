import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync('index.html', 'utf8');
const headers = readFileSync('public/_headers', 'utf8');

function bootstrap() {
  const match = /<script id="theme-init">([\s\S]*?)<\/script>/.exec(html);
  expect(match, 'theme selection must run synchronously in the document head').not.toBeNull();
  return match![1]!;
}

function initialTheme(preference: string | null, systemDark: boolean, storageAvailable = true) {
  const dataset: Record<string, string> = {};
  runInNewContext(bootstrap(), {
    document: { documentElement: { dataset } },
    window: { matchMedia: () => ({ matches: systemDark }) },
    localStorage: {
      getItem() {
        if (!storageAvailable) throw new Error('storage unavailable');
        return preference;
      },
    },
  });
  return dataset.theme;
}

describe('initial document theme', () => {
  it.each([false, true])('uses the system appearance on a fresh visit (dark: %s)', (dark) => {
    expect(initialTheme(null, dark)).toBe(dark ? 'dark' : 'light');
  });

  it.each([
    ['light', true],
    ['dark', false],
  ] as const)('applies saved %s before the opposite system appearance can paint', (saved, dark) => {
    expect(initialTheme(saved, dark)).toBe(saved);
  });

  it.each(['system', 'invalid', null])('falls back to the OS for %s', (saved) => {
    expect(initialTheme(saved, true)).toBe('dark');
    expect(initialTheme(saved, false)).toBe('light');
  });

  it('does not need storage access to apply the system appearance', () => {
    expect(initialTheme(null, true, false)).toBe('dark');
    expect(initialTheme(null, false, false)).toBe('light');
  });

  it('resolves the theme before stylesheets, the application, or body content', () => {
    const end = html.indexOf('</script>', html.indexOf('<script id="theme-init">'));
    bootstrap();
    expect(end).toBeLessThan(html.indexOf('<style>'));
    expect(end).toBeLessThan(html.indexOf('<body>'));
    expect(end).toBeLessThan(html.indexOf('type="module"'));
  });

  it('permits only the exact bootstrap through the script policy', () => {
    const hash = createHash('sha256').update(bootstrap()).digest('base64');
    const scriptPolicy = /script-src ([^;]+)/.exec(headers)![1]!;
    expect(scriptPolicy).toContain(`'sha256-${hash}'`);
    expect(scriptPolicy).not.toContain('unsafe-inline');
  });
});
