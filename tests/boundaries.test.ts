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
  it('checks client-only module helpers even when the shell does not import them yet', () => {
    const result = check({
      'src/modules/tasks/client/moves.ts': "import {write} from '../server/commands';",
      'src/modules/tasks/server/commands.ts': 'export function write(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('does not let modules depend on shell implementations', () => {
    const result = check({
      'src/modules/tasks/model.ts': "import {select} from '../../web/selection';",
      'src/web/selection.ts': 'export function select(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('application shell');
  });
  it('keeps browser infrastructure independent from application owners', () => {
    const result = check({
      'src/client/http.ts': "import type {Task} from '../modules/tasks/contracts';",
      'src/modules/tasks/contracts.ts': 'export interface Task{}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser infrastructure');
  });
  it('rejects server imports of a client helper even when it contains no jsx', () => {
    const result = check({
      'src/modules/tasks/server/commands.ts': "import {queue} from '../client/moves';",
      'src/modules/tasks/client/moves.ts': 'export const queue=[];',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser presentation');
  });
  it.each(['lifecycle', 'maintenance', 'portability', 'provider-access'])(
    'recognizes flat account %s code as server-only',
    (name) => {
      const result = check({
        'src/web/main.ts': `import {value} from '../modules/accounts/${name}';`,
        [`src/modules/accounts/${name}.ts`]: 'export const value=1;',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('browser/server boundary');
    },
  );
  it('refuses cross-owner private server details regardless of their basename', () => {
    const result = check({
      'src/modules/boards/server/templates.ts':
        "import {capture} from '../../tasks/server/provider-command-state';",
      'src/modules/tasks/server/provider-command-state.ts': 'export function capture(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('explicit public operation/query');
  });
  it('permits the declared task template operation surface across owners', () => {
    const result = check({
      'src/modules/boards/server/templates.ts':
        "import {create} from '../../tasks/server/list-templates';",
      'src/modules/tasks/server/list-templates.ts': 'export function create(){}',
    });
    expect(result.status).toBe(0);
  });
  it('allows history to use query contracts and planning without gaining task mutations', () => {
    const result = check({
      'src/modules/history/query-contract.ts':
        "import type {Query} from '../tasks/query-contract';",
      'src/modules/tasks/query-contract.ts': 'export interface Query{}',
      'src/modules/history/client/HistoryPanel.ts':
        "import {today} from '../../tasks/client/usePlanningToday';",
      'src/modules/tasks/client/usePlanningToday.ts': 'export function today(){}',
    });
    expect(result.status).toBe(0);
    const mutation = check({
      'src/modules/history/client/HistoryPanel.ts':
        "import {move} from '../../tasks/client/save-task-move';",
      'src/modules/tasks/client/save-task-move.ts': 'export function move(){}',
    });
    expect(mutation.status).toBe(1);
    expect(mutation.stderr).toContain('cannot depend');
  });
  it('keeps shared contracts independent of browser infrastructure', () => {
    const result = check({
      'src/contracts/http.ts': "import {request} from '../client/http';",
      'src/client/http.ts': 'export function request(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('context independent');
  });
  it('keeps shared ui below browser infrastructure and the shell', () => {
    const result = check({
      'src/ui/Dialog.ts': "import {request} from '../client/http';",
      'src/client/http.ts': 'export function request(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('shared ui');
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
