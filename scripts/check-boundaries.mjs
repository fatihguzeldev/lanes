import ts from 'typescript';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
if (config.errors.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(config.errors, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (value) => value,
      getNewLine: () => '\n',
    }),
  );
  process.exit(1);
}
const sourceRoot = path.join(root, 'src') + path.sep;
const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/');
const owner = (file) => /^src\/modules\/([^/]+)\//.exec(relative(file))?.[1];
const role = (file) => /^src\/modules\/[^/]+\/([^/]+)\//.exec(relative(file))?.[1];
const sourceFiles = config.fileNames.filter(
  (file) => file.startsWith(sourceRoot) && /\.[cm]?[jt]sx?$/.test(file),
);
const files = sourceFiles.filter(
  (file) => !relative(file).includes('/tests/') && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file),
);
const allowed = {
  accounts: ['operations'],
  operations: ['accounts'],
  tasks: ['accounts', 'history', 'operations'],
  boards: ['accounts', 'tasks', 'history', 'operations'],
  history: ['tasks'],
  transfer: ['accounts', 'tasks', 'boards', 'history', 'operations'],
};
// Cross-owner capabilities are deliberately named; persistence rows and implementation helpers stay private.
const publicServerFiles = {
  accounts: [
    'server/connections/access.ts',
    'server/connections/portability.ts',
    'server/lifecycle/context.ts',
    'server/lifecycle/link-fence.ts',
    'server/lifecycle/write-guards.ts',
  ],
  operations: [
    'server/journal/store.ts',
    'server/journal/context.ts',
    'server/journal/resources.ts',
    'server/lifecycle/account-removal.ts',
    'server/queries/receipts.ts',
  ],
  tasks: [
    'server/commands/service.ts',
    'server/commands/copy-contract.ts',
    'server/metadata/context.ts',
    'server/metadata/tasks.ts',
    'server/queries/lists.ts',
    'server/queries/tasks.ts',
    'server/queries/labels.ts',
    'server/queries/snapshot-reader.ts',
    'server/templates/context.ts',
    'server/templates/definitions.ts',
    'server/templates/materialize.ts',
    'server/templates/snapshots.ts',
    'server/templates/documents.ts',
  ],
  boards: [
    'server/boards/context.ts',
    'server/boards/queries.ts',
    'server/boards/service.ts',
    'server/templates/definitions.ts',
    'server/templates/schedules.ts',
  ],
  history: ['server/events/event-store.ts'],
};
const publicBrowserFiles = {
  operations: [
    'browser/status/change-status.ts',
    'browser/submission/Confirmation.tsx',
    'browser/submission/PromptDialog.tsx',
    'browser/submission/operation-identity.ts',
    'browser/submission/useCommands.ts',
  ],
  tasks: [
    'browser/creation/InlineTaskCreate.tsx',
    'browser/items/TaskCard.tsx',
    'browser/movement/task-move-model.ts',
    'browser/movement/useTaskMoveQueue.ts',
    'browser/planning/usePlanningToday.ts',
    'browser/queries/references.ts',
    'browser/queries/useTaskQuery.ts',
  ],
};
const isServerFile = (file) => relative(file).startsWith('src/worker/') || role(file) === 'server';
const isBrowserFile = (file) =>
  /^src\/(app|shared\/(browser|ui))\//.test(relative(file)) || role(file) === 'browser';
const isPortableFile = (file) =>
  relative(file).startsWith('src/shared/contracts/') ||
  ['contracts', 'model', 'formats'].includes(role(file));
const isServer = (file) =>
  isBuiltin(file) ||
  file.startsWith('node:') ||
  file.startsWith('cloudflare:') ||
  file === '@cloudflare/workers-types' ||
  isServerFile(file);
const edges = new Map(),
  runtimeEdges = new Map(),
  issues = [];
for (const file of sourceFiles) {
  const name = relative(file);
  if (!/^src\/(app|shared|modules|worker)\//.test(name))
    issues.push(`${name} is outside a declared source root`);
  if (name.startsWith('src/shared/') && !/^src\/shared\/(browser|contracts|ui|styles)\//.test(name))
    issues.push(`${name} has no declared shared responsibility`);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) && !name.includes('/tests/'))
    issues.push(`${name} belongs in its responsibility's tests directory`);
  if (/^src\/modules\/[^/]+\/[^/]+\.[cm]?[jt]sx?$/.test(name))
    issues.push(
      `${name} must name its responsibility under contracts, model, formats, browser, or server`,
    );
  if (/^src\/(web|client|ui|styles|contracts)\//.test(name))
    issues.push(
      `${name} uses an obsolete source root; choose app, shared, or its feature responsibility`,
    );
  if (owner(file) && !['contracts', 'model', 'formats', 'browser', 'server'].includes(role(file)))
    issues.push(`${name} has no declared source responsibility`);
}
for (const file of files) {
  const ast = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
  const dependencies = [],
    runtimeDependencies = [];
  const visit = (node) => {
    let target,
      runtime = true;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      target = node.moduleSpecifier.text;
      runtime = !node.isTypeOnly;
      if (ts.isImportDeclaration(node) && node.importClause) {
        const clause = node.importClause;
        runtime =
          !clause.isTypeOnly &&
          (!clause.namedBindings ||
            !ts.isNamedImports(clause.namedBindings) ||
            !!clause.name ||
            clause.namedBindings.elements.length === 0 ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly));
      }
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
        runtime =
          !node.isTypeOnly &&
          (node.exportClause.elements.length === 0 ||
            node.exportClause.elements.some((element) => !element.isTypeOnly));
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      target = node.arguments[0].text;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      target = node.arguments[0].text;
    if (target) {
      const asset = target.startsWith('.') ? path.resolve(path.dirname(file), target) : undefined;
      const resolved =
        ts.resolveModuleName(target, file, config.options, ts.sys).resolvedModule
          ?.resolvedFileName ?? (asset && ts.sys.fileExists(asset) ? asset : undefined);
      if (
        isBuiltin(target) ||
        target.startsWith('node:') ||
        target.startsWith('cloudflare:') ||
        target === '@cloudflare/workers-types'
      )
        dependencies.push(target);
      if (target.startsWith('.') && !resolved)
        issues.push(`${relative(file)} has an unresolved source or asset import ${target}`);
      if (
        resolved &&
        resolved.startsWith(root + path.sep) &&
        (/(?:^|\/)tests\//.test(relative(resolved)) ||
          /\.(test|spec)\.[cm]?[jt]sx?$/.test(resolved))
      )
        issues.push(`${relative(file)} cannot import test-only source ${relative(resolved)}`);
      if (
        resolved?.startsWith(root + path.sep) &&
        !resolved.startsWith(sourceRoot) &&
        !relative(resolved).startsWith('node_modules/') &&
        /\.[cm]?[jt]sx?$/.test(resolved)
      )
        issues.push(
          `${relative(file)} imports executable code outside a declared source root: ${relative(resolved)}`,
        );
      if (resolved?.startsWith(sourceRoot)) {
        dependencies.push(resolved);
        if (runtime) runtimeDependencies.push(resolved);
        const fromOwner = owner(file),
          toOwner = owner(resolved),
          destination = relative(resolved);
        if (
          relative(file).startsWith('src/shared/') &&
          (toOwner || /^src\/(app|worker)\//.test(destination))
        )
          issues.push(`${relative(file)} is shared code and cannot import ${destination}`);
        if (fromOwner && toOwner && fromOwner !== toOwner) {
          const historyRead =
            /^src\/modules\/tasks\/(contracts\/|model\/(task|planning)\.ts$|browser\/(planning\/usePlanningToday|queries\/references)\.ts$)/.test(
              destination,
            );
          if (!allowed[fromOwner]?.includes(toOwner) || (fromOwner === 'history' && !historyRead))
            issues.push(`${relative(file)} cannot depend on ${destination}`);
          const local = destination.slice(`src/modules/${toOwner}/`.length);
          if (isServerFile(resolved) && !publicServerFiles[toOwner]?.includes(local))
            issues.push(
              `${relative(file)} must use an explicit public operation/query rather than ${destination}`,
            );
          if (role(resolved) === 'browser' && !publicBrowserFiles[toOwner]?.includes(local))
            issues.push(
              `${relative(file)} must use an explicit public browser capability rather than ${destination}`,
            );
        }
        if (fromOwner && destination.startsWith('src/app/'))
          issues.push(`${relative(file)} cannot depend on the application shell ${destination}`);
        if (fromOwner && destination.startsWith('src/worker/'))
          issues.push(`${relative(file)} cannot depend on the worker composition ${destination}`);
        if (
          relative(file).startsWith('src/shared/browser/') &&
          (toOwner || /^src\/(app|worker)\//.test(destination))
        )
          issues.push(
            `${relative(file)} is browser infrastructure and cannot import ${destination}`,
          );
        if (
          relative(file).startsWith('src/shared/ui/') &&
          (toOwner || /^src\/(app|worker|shared\/browser)\//.test(destination))
        )
          issues.push(`${relative(file)} is shared ui and cannot import ${destination}`);
        if (
          relative(file).startsWith('src/shared/contracts/') &&
          (toOwner || /^src\/(app|worker|shared\/(browser|ui))\//.test(destination))
        )
          issues.push(`${relative(file)} must remain context independent`);
        if (
          isPortableFile(file) &&
          (isBrowserFile(resolved) || isServerFile(resolved) || /\.css$/.test(resolved))
        )
          issues.push(`${relative(file)} must remain portable and cannot import ${destination}`);
        if (
          isServerFile(file) &&
          (isBrowserFile(resolved) ||
            /\.css$/.test(resolved) ||
            destination.startsWith('src/shared/styles/'))
        )
          issues.push(`${relative(file)} cannot depend on browser presentation ${destination}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  edges.set(file, dependencies);
  runtimeEdges.set(file, runtimeDependencies);
}
function checkClosure(entries, forbidden, label) {
  const seen = new Set();
  function walk(file, chain) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of edges.get(file) ?? []) {
      if (forbidden(next))
        issues.push(
          `${label}: ${[...chain, relative(file), next.startsWith(sourceRoot) ? relative(next) : next].join(' -> ')}`,
        );
      else walk(next, [...chain, relative(file)]);
    }
  }
  for (const file of entries) walk(file, []);
}
const browserEntries = files.filter(isBrowserFile);
if (!files.length || !browserEntries.length)
  issues.push(
    'no browser source entry points were checked; update the boundary configuration for the actual source layout',
  );
checkClosure(browserEntries, isServer, 'browser/server boundary');
checkClosure(
  files.filter(isServerFile),
  (file) =>
    isBrowserFile(file) || /\.css$/.test(file) || relative(file).startsWith('src/shared/styles/'),
  'server/browser boundary',
);
checkClosure(
  files.filter(isPortableFile),
  (file) => isServer(file) || isBrowserFile(file) || /\.css$/.test(file),
  'portable source boundary',
);
const visited = new Set(),
  active = new Set();
function cycle(file, chain) {
  if (active.has(file)) {
    issues.push(`runtime import cycle: ${[...chain, file].map(relative).join(' -> ')}`);
    return;
  }
  if (visited.has(file)) return;
  active.add(file);
  for (const next of runtimeEdges.get(file) ?? []) cycle(next, [...chain, file]);
  active.delete(file);
  visited.add(file);
}
for (const file of files) cycle(file, []);
if (issues.length) {
  process.stderr.write([...new Set(issues)].join('\n') + '\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    `checked ${files.length} source files; ownership and browser/server boundaries passed\n`,
  );
