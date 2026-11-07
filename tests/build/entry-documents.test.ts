import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { build } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vite', async (original) => {
  const vite = await original<typeof import('vite')>();
  return { ...vite, build: vi.fn(vite.build) };
});
import { entryDocument, entryDocumentKind } from '../../scripts/entry-documents';

const template = `<!doctype html><html><head><script id="theme-init">theme()</script><script type="module" src="/assets/index-abcd.js"></script><link rel="stylesheet" href="/assets/index-abcd.css"></head><body><div id="root"></div></body></html>`;

describe('initial entry documents', () => {
  it('retains the built asset tags and theme setup around the pre-rendered application', () => {
    const html = entryDocument(template, '<main>continue with google $&</main>');
    expect(html).toContain('<div id="root"><main>continue with google $&</main></div>');
    expect(html).toContain('src="/assets/index-abcd.js"');
    expect(html).toContain('href="/assets/index-abcd.css"');
    expect(html).toContain('<script id="theme-init">theme()</script>');
    expect(html).toContain('<!--lanes-session-->\n</body>');
    expect(html.split('<!--lanes-session-->')).toHaveLength(2);
  });

  it('fails the build when the application root is missing or duplicated', () => {
    expect(() => entryDocument(template.replace('<div id="root"></div>', ''), 'app')).toThrow();
    expect(() =>
      entryDocument(template.replace('</body>', '<div id="root"></div></body>'), 'app'),
    ).toThrow();
  });

  it('recognizes only the internal document variants', () => {
    expect(entryDocumentKind('/_entry/workspace.html')).toBe('workspace');
    expect(entryDocumentKind('/_entry/signin.html')).toBe('signin');
    expect(entryDocumentKind('/_entry/setup.html')).toBe('setup');
    expect(entryDocumentKind('/_entry/error.html')).toBe('error');
    expect(entryDocumentKind('/_entry/anything.html')).toBeNull();
    expect(entryDocumentKind('/assets/index.js')).toBeNull();
  });
});

async function developmentServer() {
  const { entryDocuments } = await import('../../scripts/entry-documents');
  const plugin = entryDocuments();
  if (typeof plugin.configResolved !== 'function' || typeof plugin.configureServer !== 'function')
    throw new Error('entry document hooks are missing');
  plugin.configResolved.call({} as never, { root: process.cwd() } as import('vite').ResolvedConfig);
  let middleware!: import('vite').Connect.NextHandleFunction;
  const watcher = new EventEmitter();
  const httpServer = new EventEmitter();
  await plugin.configureServer.call(
    {} as never,
    {
      watcher,
      httpServer,
      middlewares: {
        use(handler: import('vite').Connect.NextHandleFunction) {
          middleware = handler;
        },
      },
      async transformIndexHtml(_path: string, html: string) {
        return html;
      },
    } as unknown as import('vite').ViteDevServer,
  );
  return {
    watcher,
    httpServer,
    read(kind = 'signin') {
      return new Promise<string>((resolve, reject) => {
        middleware(
          { url: `/_entry/${kind}.html`, method: 'GET' } as import('node:http').IncomingMessage,
          {
            setHeader() {},
            end(body: string) {
              resolve(body);
            },
          } as unknown as import('node:http').ServerResponse,
          reject,
        );
      });
    },
  };
}

describe('development entry document', () => {
  beforeEach(() => vi.mocked(build).mockClear());
  it('includes the current rendered view and its source-derived styles before client scripts run', async () => {
    const server = await developmentServer();
    const html = await server.read();
    expect(html).toContain('your things, in one place.');
    expect(html).not.toContain('loading workspace');
    expect(html).toContain('<style data-lanes-entry-styles>');
    expect(html).toContain('--canvas:');
    expect(html).toContain('.entry-paper');
    expect(html.indexOf('data-lanes-entry-styles')).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain('<!--lanes-session-->');
    expect(html).toContain('src="/src/app/entry/main.tsx"');
    expect(html).toContain('class="entry-primary" disabled=""');
    server.httpServer.emit('close');
  });

  it('coalesces requests and rebuilds only when source entries change', async () => {
    const server = await developmentServer();
    await Promise.all([server.read(), server.read('setup')]);
    expect(build).toHaveBeenCalledTimes(1);
    server.watcher.emit('all', 'add', resolve('node_modules/.cache/lanes-entry-temp/entry.mjs'));
    await server.read();
    expect(build).toHaveBeenCalledTimes(1);
    for (const file of [
      'src/app/entry/App.tsx',
      'scripts/prerender/entry.tsx',
      'scripts/entry-documents.ts',
    ]) {
      server.watcher.emit('all', 'change', resolve(file));
      await Promise.all([server.read(), server.read('error')]);
    }
    expect(build).toHaveBeenCalledTimes(4);
    server.httpServer.emit('close');
  });

  it('retries rejected renders and removes its invalidation listener when the server closes', async () => {
    const server = await developmentServer();
    vi.mocked(build).mockRejectedValueOnce(new Error('compile failed'));
    await expect(server.read()).rejects.toThrow('compile failed');
    expect(await server.read()).toContain('your things, in one place.');
    expect(build).toHaveBeenCalledTimes(2);
    expect(server.watcher.listenerCount('all')).toBe(1);
    server.httpServer.emit('close');
    expect(server.watcher.listenerCount('all')).toBe(0);
  });
});
