import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function check(files: Record<string, string>, aliases = false) {
  const directory = mkdtempSync(join(tmpdir(), 'lanes-boundaries-'));
  directories.push(directory);
  const input = { 'src/web/main.ts': 'export {};', ...files };
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        ...(aliases ? { baseUrl: '.', paths: { '@/*': ['src/*'] } } : {}),
      },
      include: ['src'],
    }),
  );
  for (const [path, text] of Object.entries(input)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return spawnSync(process.execPath, [resolve('scripts/check-boundaries.mjs'), directory], {
    encoding: 'utf8',
  });
}
describe('ownership gate against actual source graphs', () => {
  it('allows shared public task contracts without pulling server code into the browser', () => {
    const result = check({
      'src/web/main.ts': "import {x} from '../modules/tasks/contracts';",
      'src/modules/tasks/contracts.ts': 'export const x=1;',
    });
    expect(result.status).toBe(0);
  });
  it('finds a transitive server import through an apparently safe model', () => {
    const result = check({
      'src/web/main.ts': "import {x} from '../modules/tasks/model';",
      'src/modules/tasks/model.ts': "export {x} from '../accounts/crypto';",
      'src/modules/accounts/crypto.ts': 'export const x=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('resolves configured aliases rather than checking only relative import spelling', () => {
    const result = check(
      {
        'src/web/main.ts': "import {x} from '@/modules/accounts/server';",
        'src/modules/accounts/server.ts': 'export const x=1;',
      },
      true,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('accounts/server.ts');
  });
  it('checks worker entry URLs too', () => {
    const result = check({
      'src/web/main.ts':
        "new Worker(new URL('../modules/transfer/parser.worker.ts',import.meta.url));",
      'src/modules/transfer/parser.worker.ts': "import {x} from '../accounts/crypto';",
      'src/modules/accounts/crypto.ts': 'export const x=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('permits history read contracts but refuses task mutation dependencies', () => {
    expect(
      check({
        'src/modules/history/contracts.ts': "import type {Task} from '../tasks/contracts';",
        'src/modules/tasks/contracts.ts': 'export interface Task{}',
      }).status,
    ).toBe(0);
    const result = check({
      'src/modules/history/server.ts': "import {change} from '../tasks/server/commands';",
      'src/modules/tasks/server/commands.ts': 'export function change(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot depend');
  });
  it('refuses a server composition importing browser presentation', () => {
    const result = check({
      'src/worker/index.ts': "import {App} from '../web/App';",
      'src/web/App.tsx': 'export function App(){return null}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser presentation');
  });
});
