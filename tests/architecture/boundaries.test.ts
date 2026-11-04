import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function check(files: Record<string, string>, aliases = false) {
  const directory = mkdtempSync(join(tmpdir(), 'lanes-boundaries-'));
  directories.push(directory);
  const input = { 'src/app/entry/main.ts': 'export {};', ...files };
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

describe('source ownership and runtime boundaries', () => {
  it('allows browser-safe feature contracts', () => {
    expect(
      check({
        'src/app/entry/main.ts': "import {Task} from '../../modules/tasks/contracts/task';",
        'src/modules/tasks/contracts/task.ts': 'export const Task=1;',
      }).status,
    ).toBe(0);
  });
  it('finds a transitive server dependency through a model', () => {
    const result = check({
      'src/app/entry/main.ts': "import {x} from '../../modules/tasks/model/task';",
      'src/modules/tasks/model/task.ts': "export {x} from '../server/metadata/tasks';",
      'src/modules/tasks/server/metadata/tasks.ts': 'export const x=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('resolves aliases before enforcing the browser boundary', () => {
    const result = check(
      {
        'src/app/entry/main.ts': "import {x} from '@/modules/accounts/server/session/sessions';",
        'src/modules/accounts/server/session/sessions.ts': 'export const x=1;',
      },
      true,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('accounts/server/session/sessions.ts');
  });
  it('checks dynamic imports and parsing worker urls', () => {
    const result = check({
      'src/app/entry/main.ts':
        "new Worker(new URL('../../modules/transfer/browser/parsing/parser.worker.ts',import.meta.url));",
      'src/modules/transfer/browser/parsing/parser.worker.ts':
        "void import('../../../accounts/server/credentials/crypto');",
      'src/modules/accounts/server/credentials/crypto.ts': 'export const value=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('checks unreferenced browser helpers too', () => {
    const result = check({
      'src/modules/tasks/browser/movement/queue.ts':
        "import {write} from '../../server/commands/service';",
      'src/modules/tasks/server/commands/service.ts': 'export function write(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it.each(['accounts', 'tasks', 'boards', 'history', 'transfer', 'operations'])(
    'recognizes the %s server boundary without naming individual implementation files',
    (owner) => {
      const result = check({
        'src/app/entry/main.ts': `import {value} from '../../modules/${owner}/server/custom/new-capability';`,
        [`src/modules/${owner}/server/custom/new-capability.ts`]: 'export const value=1;',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('browser/server boundary');
    },
  );
  it('prevents feature code from importing the application shell', () => {
    const result = check({
      'src/modules/tasks/model/task.ts': "import {x} from '../../../app/workspace/navigation';",
      'src/app/workspace/navigation.ts': 'export const x=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('application shell');
  });
  it('keeps shared browser infrastructure independent of feature owners', () => {
    const result = check({
      'src/shared/browser/http/http.ts':
        "import type {Task} from '../../../modules/tasks/contracts/task';",
      'src/modules/tasks/contracts/task.ts': 'export interface Task{}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser infrastructure');
  });
  it('prevents server code from importing a browser helper without jsx', () => {
    const result = check({
      'src/modules/tasks/server/commands/service.ts':
        "import {queue} from '../../browser/movement/queue';",
      'src/modules/tasks/browser/movement/queue.ts': 'export const queue=[];',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser presentation');
  });
  it('keeps shared ui below request infrastructure', () => {
    const result = check({
      'src/shared/ui/dialog/Dialog.ts': "import {request} from '../../browser/http/http';",
      'src/shared/browser/http/http.ts': 'export function request(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('shared ui');
  });
  it('keeps shared contracts independent of application code', () => {
    const result = check({
      'src/shared/contracts/http.ts': "import {request} from '../browser/http/http';",
      'src/shared/browser/http/http.ts': 'export function request(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('context independent');
  });
  it('keeps feature contracts portable even when the app does not import them', () => {
    const result = check({
      'src/modules/tasks/contracts/task.ts': "import {create} from '../browser/creation/create';",
      'src/modules/tasks/browser/creation/create.ts': 'export function create(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('portable');
  });
  it('refuses cross-owner private persistence records', () => {
    const result = check({
      'src/modules/boards/server/templates/definitions.ts':
        "import type {TaskRow} from '../../../tasks/server/metadata/records';",
      'src/modules/tasks/server/metadata/records.ts': 'export interface TaskRow{}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('explicit public operation/query');
  });
  it('permits public server command context without exposing private database rows', () => {
    expect(
      check({
        'src/modules/boards/server/templates/definitions.ts':
          "import type {MetadataContext} from '../../../tasks/server/metadata/context';",
        'src/modules/tasks/server/metadata/context.ts': 'export interface MetadataContext{}',
      }).status,
    ).toBe(0);
  });
  it('permits the declared template operation capability', () => {
    expect(
      check({
        'src/modules/boards/server/templates/definitions.ts':
          "import {create} from '../../../tasks/server/templates/definitions';",
        'src/modules/tasks/server/templates/definitions.ts': 'export function create(){}',
      }).status,
    ).toBe(0);
  });
  it('allows history task reads while refusing task mutations', () => {
    expect(
      check({
        'src/modules/history/browser/activity/HistoryDialog.ts':
          "import {readTask} from '../../../tasks/browser/queries/references';",
        'src/modules/tasks/browser/queries/references.ts': 'export function readTask(){}',
      }).status,
    ).toBe(0);
    const result = check({
      'src/modules/history/browser/activity/HistoryDialog.ts':
        "import {move} from '../../../tasks/browser/movement/save-task-move';",
      'src/modules/tasks/browser/movement/save-task-move.ts': 'export function move(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot depend');
  });
  it('refuses feature server access to the worker composition root', () => {
    const result = check({
      'src/modules/tasks/server/commands/service.ts':
        "import {createServices} from '../../../../worker/composition/services';",
      'src/worker/composition/services.ts': 'export function createServices(){}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('composition');
  });
  it('groups source tests under their owning tests directory', () => {
    const result = check({ 'src/modules/tasks/model/task.test.ts': 'export {};' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tests directory');
  });
  it('refuses mixed implementation files at an owner root', () => {
    const result = check({ 'src/modules/accounts/credentials.ts': 'export const value=1;' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('responsibility');
  });
  it('refuses runtime import cycles', () => {
    const result = check({
      'src/modules/tasks/model/a.ts': "import {b} from './b'; export const a=()=>b;",
      'src/modules/tasks/model/b.ts': "import {a} from './a'; export const b=()=>a;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime import cycle');
  });
  it('rejects production imports through a test-only bridge', () => {
    const result = check({
      'src/app/entry/main.ts':
        "import {bridge} from '../../modules/tasks/model/tests/bridge.test';",
      'src/modules/tasks/model/tests/bridge.test.ts':
        "export {value as bridge} from '../../server/private';",
      'src/modules/tasks/server/private.ts': 'export const value=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('test-only');
  });
  it('rejects production imports of shared test infrastructure outside src', () => {
    const result = check({
      'src/app/entry/main.ts': "import {database} from '../../../tests/support/database';",
      'tests/support/database.ts': 'export const database={};',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('test-only');
  });
  it('permits type-only cycles that do not create a runtime dependency', () => {
    expect(
      check({
        'src/modules/tasks/contracts/a.ts': "import type {B} from './b'; export interface A{b:B}",
        'src/modules/tasks/contracts/b.ts': "import type {A} from './a'; export interface B{a:A}",
      }).status,
    ).toBe(0);
  });
  it.each(['dynamic import', 'worker url'])('checks static template literals in a %s', (kind) => {
    const load =
      kind === 'dynamic import'
        ? 'void import(`../../modules/tasks/server/private`);'
        : 'new Worker(new URL(`../../modules/tasks/server/private.ts`,import.meta.url));';
    const result = check({
      'src/app/entry/main.ts': load,
      'src/modules/tasks/server/private.ts': 'export const value=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('permits inline type-only re-export cycles', () => {
    expect(
      check({
        'src/modules/tasks/contracts/a.ts': "export {type B} from './b'; export interface A{}",
        'src/modules/tasks/contracts/b.ts': "export {type A} from './a'; export interface B{}",
      }).status,
    ).toBe(0);
  });
  it('counts empty imports as runtime side effects', () => {
    const result = check({
      'src/modules/tasks/model/a.ts': "import {} from './b'; export const a=1;",
      'src/modules/tasks/model/b.ts': "import {} from './a'; export const b=1;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime import cycle');
  });
  it('prevents transitive server dependencies on presentation', () => {
    const result = check({
      'src/modules/tasks/server/private.ts':
        "import {value} from '../../../shared/helpers/bridge';",
      'src/shared/helpers/bridge.ts': "export {value} from '../ui/icon/Icon';",
      'src/shared/ui/icon/Icon.tsx': 'export const value=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server/browser boundary');
  });
  it('allows local test fixtures without treating them as production browser code', () => {
    expect(
      check({
        'src/modules/tasks/browser/editor/tests/fixture.ts':
          "import {DatabaseSync} from 'node:sqlite'; export const database=DatabaseSync;",
      }).status,
    ).toBe(0);
  });
  it.each(['src/helpers/bridge.ts', 'src/shared/misc/bridge.ts', 'src/shared/styles/bridge.ts'])(
    'rejects private feature access through %s',
    (bridge) => {
      const caller =
        bridge === 'src/helpers/bridge.ts'
          ? '../../../helpers/bridge'
          : '../../../shared/' + bridge.split('/').slice(2).join('/').replace(/\.ts$/, '');
      const target =
        bridge === 'src/helpers/bridge.ts'
          ? '../modules/boards/browser/private'
          : '../../modules/boards/browser/private';
      const result = check({
        'src/modules/tasks/browser/view.ts': `import {value} from '${caller}';`,
        [bridge]: `export {value} from '${target}';`,
        'src/modules/boards/browser/private.ts': 'export const value=1;',
      });
      expect(result.status).toBe(1);
    },
  );
  it('rejects executable repository imports outside declared source roots', () => {
    const result = check({
      'src/app/entry/main.ts': "import {value} from '../../../helpers/bridge';",
      'helpers/bridge.ts': "export {value} from '../src/modules/accounts/server/private';",
      'src/modules/accounts/server/private.ts': 'export const value=1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source root');
  });
  it.each(['fs', 'fs/promises'])('rejects the bare node builtin %s in browser code', (name) => {
    const result = check({ 'src/app/entry/main.ts': `import fs from '${name}';` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/server boundary');
  });
  it('checks type-query imports before exposing private persistence rows', () => {
    const result = check({
      'src/modules/boards/contracts/board.ts':
        "export type Row = import('../../tasks/server/metadata/records').TaskRow;",
      'src/modules/tasks/server/metadata/records.ts': 'export interface TaskRow{}',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('explicit public operation/query');
  });
});
