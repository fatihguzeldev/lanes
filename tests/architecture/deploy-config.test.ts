import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/prepare-deploy.mjs');
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
const config = {
  account_id: 'account',
  name: 'lanes-owner',
  d1_databases: [{ binding: 'DB', database_id: 'database' }],
  vars: { APP_ORIGIN: 'https://lanes.example', OWNER_EMAIL: 'owner@example.com' },
  assets: {
    binding: 'ASSETS',
    directory: './dist/client',
    run_worker_first: ['/custom/*', '/api/*'],
  },
  compatibility_date: '2026-11-02',
};
function run(input?: unknown, existing?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'lanes-deploy-config-'));
  directories.push(directory);
  const target = join(directory, 'wrangler.deploy.jsonc');
  if (existing !== undefined) writeFileSync(target, existing);
  const env = { ...process.env };
  delete env.LANES_DEPLOY_CONFIG;
  if (input !== undefined) env.LANES_DEPLOY_CONFIG = JSON.stringify(input);
  const invoke = () =>
    execFileSync(process.execPath, [script], { cwd: directory, env, stdio: 'pipe' });
  return { invoke, target, read: () => JSON.parse(readFileSync(target, 'utf8')) };
}

describe('deployment document routing', () => {
  it('adds document entry routes to env configuration while preserving installation fields and custom patterns', () => {
    const f = run(config);
    f.invoke();
    const saved = f.read();
    expect(saved).toMatchObject({
      ...config,
      assets: {
        ...config.assets,
        run_worker_first: expect.arrayContaining([
          '/',
          '/index.html',
          '/api/*',
          '/auth/*',
          '/custom/*',
        ]),
      },
    });
    expect(saved.assets.run_worker_first).toHaveLength(new Set(saved.assets.run_worker_first).size);
  });
  it('normalizes an existing JSONC file without env input and stays idempotent', () => {
    const source = JSON.stringify({ ...config, name: 'existing-owner' }, null, 2)
      .replace('"name":', '// private installation\n  "name":')
      .replace(/\n}$/, ',\n}');
    const f = run(undefined, source);
    f.invoke();
    const saved = f.read();
    expect(saved.name).toBe('existing-owner');
    expect(saved.assets.run_worker_first).toEqual([
      '/custom/*',
      '/api/*',
      '/',
      '/index.html',
      '/auth/*',
    ]);
    f.invoke();
    expect(f.read()).toEqual(saved);
  });
  it('uses an explicitly supplied build configuration rather than stale local installation values', () => {
    const f = run(config, JSON.stringify({ ...config, name: 'stale-owner' }));
    f.invoke();
    expect(f.read().name).toBe('lanes-owner');
    expect(f.read().assets.run_worker_first).toContain('/index.html');
  });
  it('keeps an existing all-worker routing policy and replaces false with required routes', () => {
    for (const policy of [true, false]) {
      const f = run({ ...config, assets: { ...config.assets, run_worker_first: policy } });
      f.invoke();
      expect(f.read().assets.run_worker_first).toEqual(
        policy ? true : ['/', '/index.html', '/api/*', '/auth/*'],
      );
    }
  });
  it('preserves broad positive routing without adding redundant patterns or unrelated exclusions', () => {
    const f = run({
      ...config,
      assets: { ...config.assets, run_worker_first: ['/*', '!/fonts/*'] },
    });
    f.invoke();
    expect(f.read().assets.run_worker_first).toEqual(['/*', '!/fonts/*']);
  });
  it.each(['!/', '!/index.html', '!/*', '!/api/accounts/*', '!/auth/google/*'])(
    'rejects an exclusion that bypasses a required worker route: %s',
    (exclusion) => {
      const f = run({
        ...config,
        assets: { ...config.assets, run_worker_first: ['/custom/*', exclusion] },
      });
      expect(f.invoke).toThrow('exclusions must not bypass');
    },
  );
  it('rejects invalid routing shapes and credential vars without writing their values', () => {
    for (const input of [
      { ...config, assets: { run_worker_first: 2 } },
      { ...config, vars: { ...config.vars, GOOGLE_CLIENT_SECRET: 'private-value' } },
    ]) {
      const f = run(input);
      let failure = '';
      try {
        f.invoke();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain('Error');
      expect(failure).not.toContain('private-value');
    }
  });
});
