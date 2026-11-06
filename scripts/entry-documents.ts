import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, type Plugin } from 'vite';

export const documentKinds = ['signin', 'setup', 'workspace', 'error'] as const;
export type EntryDocumentKind = (typeof documentKinds)[number];

export function entryDocumentKind(pathname: string): EntryDocumentKind | null {
  return documentKinds.find((kind) => pathname === `/_entry/${kind}.html`) ?? null;
}

export function entryDocument(template: string, markup: string): string {
  const root = '<div id="root"></div>';
  if (template.split(root).length !== 2 || template.split('</body>').length !== 2)
    throw new Error('the entry document needs one empty application root and body.');
  return template
    .replace(root, () => `<div id="root">${markup}</div>`)
    .replace('</body>', '<!--lanes-session-->\n</body>');
}

async function renderDocuments(root: string): Promise<{
  documents: Record<EntryDocumentKind, string>;
  styles: string;
}> {
  const cache = resolve(root, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const outDir = await mkdtemp(resolve(cache, 'lanes-entry-'));
  try {
    await build({
      configFile: false,
      root,
      publicDir: false,
      plugins: [react()],
      logLevel: 'error',
      build: {
        ssr: resolve(root, 'scripts/prerender/entry.tsx'),
        outDir,
        emptyOutDir: true,
        copyPublicDir: false,
        minify: false,
        sourcemap: false,
        emitAssets: true,
        cssCodeSplit: false,
        rolldownOptions: { output: { entryFileNames: 'entry.mjs' } },
      },
    });
    const renderer = (await import(pathToFileURL(resolve(outDir, 'entry.mjs')).href)) as {
      renderEntry(kind: EntryDocumentKind): string;
    };
    const documents = Object.fromEntries(
      documentKinds.map((kind) => [kind, renderer.renderEntry(kind)]),
    ) as Record<EntryDocumentKind, string>;
    const assets = await readdir(outDir, { recursive: true });
    const styles = (
      await Promise.all(
        assets
          .filter((file) => file.endsWith('.css'))
          .map((file) => readFile(resolve(outDir, file), 'utf8')),
      )
    ).join('\n');
    return { documents, styles };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

export function entryDocuments(): Plugin {
  let root: string;
  let stopDev: (() => void) | undefined;
  return {
    name: 'lanes-entry-documents',
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      if (this.environment.mode !== 'build') {
        stopDev?.();
        return;
      }
      if (this.environment.name !== 'client') return;
      const directory = resolve(root, this.environment.config.build.outDir);
      const template = await readFile(resolve(directory, 'index.html'), 'utf8');
      const { documents } = await renderDocuments(root);
      const destination = resolve(directory, '_entry');
      await mkdir(destination, { recursive: true });
      await Promise.all(
        documentKinds.map((kind) =>
          writeFile(resolve(destination, `${kind}.html`), entryDocument(template, documents[kind])),
        ),
      );
    },
    configureServer(server) {
      stopDev?.();
      let rendered: ReturnType<typeof renderDocuments> | null = null;
      const source = resolve(root, 'src') + sep;
      const entries = new Set([
        resolve(root, 'scripts/prerender/entry.tsx'),
        resolve(root, 'scripts/entry-documents.ts'),
      ]);
      const invalidate = (_event: string, filename: string) => {
        const file = resolve(root, filename);
        if (file.startsWith(source) || entries.has(file)) rendered = null;
      };
      const render = () => {
        if (!rendered) {
          const pending = renderDocuments(root);
          rendered = pending;
          void pending.catch(() => {
            if (rendered === pending) rendered = null;
          });
        }
        return rendered;
      };
      const stop = () => {
        server.watcher.off('all', invalidate);
        server.httpServer?.off('close', stop);
        rendered = null;
      };
      stopDev = stop;
      server.watcher.on('all', invalidate);
      server.httpServer?.once('close', stop);
      server.middlewares.use(async (request, response, next) => {
        const kind = entryDocumentKind(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (!kind || !['GET', 'HEAD'].includes(request.method ?? 'GET')) return next();
        try {
          const source = await readFile(resolve(root, 'index.html'), 'utf8');
          const template = await server.transformIndexHtml('/index.html', source);
          const { documents, styles } = await render();
          const styled = template.replace(
            '</head>',
            () => `<style data-lanes-entry-styles>${styles}</style></head>`,
          );
          response.statusCode = 200;
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.setHeader('cache-control', 'no-store');
          response.end(
            request.method === 'HEAD' ? undefined : entryDocument(styled, documents[kind]),
          );
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
