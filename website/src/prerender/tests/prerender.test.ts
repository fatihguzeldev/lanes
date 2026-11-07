import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { prerenderDocument } from '../../../prerender';
import { renderWebsite } from '../../../prerender/entry';

const template =
  '<!doctype html><html><head><title>lanes</title><link rel="stylesheet" href="/assets/site.css"><script type="module" src="/assets/site.js"></script></head><body><div id="root"></div></body></html>';

describe('website prerender', () => {
  it('retains blocking assets and metadata while inserting literal React markup into the root', () => {
    const markup = '<main>setup $&</main>';
    const html = prerenderDocument(template, markup);

    expect(html).toContain(`<div id="root">${markup}</div>`);
    expect(html).toContain('<title>lanes</title>');
    expect(html).toContain('<link rel="stylesheet" href="/assets/site.css">');
    expect(html).toContain('<script type="module" src="/assets/site.js"></script>');
  });

  it('rejects missing, duplicated, or already populated roots instead of silently shipping an empty page', () => {
    expect(() => prerenderDocument(template.replace('<div id="root"></div>', ''), 'app')).toThrow();
    expect(() =>
      prerenderDocument(template.replace('</body>', '<div id="root"></div></body>'), 'app'),
    ).toThrow();
    expect(() =>
      prerenderDocument(template.replace('id="root">', 'id="root">app'), 'app'),
    ).toThrow();
    expect(() => prerenderDocument(template, '')).toThrow();
  });

  it('renders the real page without browser globals and keeps useId references stable', () => {
    const markup = renderWebsite();

    expect(markup).toContain('google tasks.');
    expect(markup).toContain('a little more room.');
    expect(markup).toContain('a task is rarely just a title.');
    expect(markup).toContain('each account in its own lane.');
    expect(markup).toContain('host your own lanes');
    expect(markup).toContain('href="#self-host"');
    expect(markup).toContain(
      'href="https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md"',
    );
    expect(markup).toContain('aria-controls=');
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of markup.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g))
      for (const id of reference[1]!.split(' ')) expect(ids).toContain(id);
    expect(renderWebsite()).toBe(markup);
  });

  it('builds the full page with all preview styles in a blocking head stylesheet', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'lanes-website-test-'));
    try {
      await build({
        configFile: fileURLToPath(new URL('../../../vite.config.ts', import.meta.url)),
        logLevel: 'silent',
        build: { outDir, copyPublicDir: false },
      });
      const html = await readFile(join(outDir, 'index.html'), 'utf8');
      expect(html).not.toContain('<div id="root"></div>');
      expect(html).toContain('a little more room.');
      expect(html).toContain('a task is rarely just a title.');
      expect(html).toContain('each account in its own lane.');
      expect(html).toContain('id="self-host"');
      const head = html.split('</head>')[0]!;
      const stylesheets = [...head.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)];
      expect(stylesheets).toHaveLength(1);
      const css = await readFile(join(outDir, stylesheets[0]![1]!.replace(/^\//, '')), 'utf8');
      for (const selector of [
        '.workspace-demo',
        '.task-story',
        '.account-story',
        '.self-host',
        '.workbench-picker',
      ])
        expect(css).toContain(selector);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
