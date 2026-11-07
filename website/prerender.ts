import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, type Plugin } from 'vite';

export function prerenderDocument(template: string, markup: string): string {
  const root = '<div id="root"></div>';
  if (template.split(root).length !== 2 || !markup.trim())
    throw new Error('website prerender needs one empty root and nonempty markup.');
  return template.replace(root, () => `<div id="root">${markup}</div>`);
}

export function prerenderWebsite(): Plugin {
  let root: string;
  let document: string;
  return {
    name: 'lanes-website-prerender',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      document = resolve(root, config.build.outDir, 'index.html');
    },
    async closeBundle() {
      if (this.environment.name !== 'client') return;
      const cache = resolve(root, '../node_modules/.cache');
      await mkdir(cache, { recursive: true });
      const outDir = await mkdtemp(resolve(cache, 'lanes-website-prerender-'));
      try {
        await build({
          configFile: false,
          root,
          publicDir: false,
          plugins: [react()],
          logLevel: 'error',
          build: {
            ssr: resolve(root, 'prerender/entry.tsx'),
            outDir,
            emptyOutDir: true,
            copyPublicDir: false,
            minify: false,
            sourcemap: false,
            rolldownOptions: { output: { entryFileNames: 'entry.mjs' } },
          },
        });
        const renderer = (await import(pathToFileURL(resolve(outDir, 'entry.mjs')).href)) as {
          renderWebsite(): string;
        };
        const template = await readFile(document, 'utf8');
        await writeFile(document, prerenderDocument(template, renderer.renderWebsite()));
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
  };
}
