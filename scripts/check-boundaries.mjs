import ts from 'typescript';
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
      getNewLine: () => String.fromCharCode(10),
    }),
  );
  process.exit(1);
}
const sourceRoot = path.join(root, 'src') + path.sep;
const files = config.fileNames.filter(
  (file) =>
    file.startsWith(sourceRoot) &&
    /\.[cm]?[jt]sx?$/.test(file) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file),
);
const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/');
const owner = (file) => /^src\/modules\/([^/]+)\//.exec(relative(file))?.[1];
const allowed = {
  accounts: [],
  tasks: ['accounts', 'history'],
  boards: ['accounts', 'tasks', 'history'],
  history: ['tasks'],
  transfer: ['accounts', 'tasks', 'boards', 'history'],
};
// Explicit operations and query capabilities used by another owner. Their helpers stay private.
const publicServerFiles = {
  accounts: ['access.ts', 'lifecycle.ts', 'portability.ts'],
  tasks: [
    'server/queries/lists.ts',
    'server/list-templates.ts',
    'server/operations.ts',
    'server/commands/provider-commands.ts',
    'server/commands/provider-copy-contract.ts',
    'server/metadata.ts',
    'server/template-documents.ts',
    'server/queries/snapshot-reader.ts',
    'server/queries/tasks.ts',
  ],
  boards: ['server.ts', 'server/templates.ts', 'server/template-schedules.ts'],
  history: ['server.ts'],
};
const isServerFile = (file) => {
  const name = relative(file);
  return (
    name.startsWith('src/worker/') ||
    /\/server(?:\/|\.[cm]?[jt]s$)/.test(name) ||
    /\/(crypto|google|access|provider|repository|persistence)\.[cm]?[jt]s$/.test(name) ||
    /^src\/modules\/accounts\/(access|crypto|google|lifecycle|maintenance|portability|provider-access)\.ts$/.test(
      name,
    ) ||
    name === 'src/modules/boards/projection.ts'
  );
};
const isBrowserFile = (file) =>
  /^(?:src\/(?:web|client|ui)\/|src\/modules\/[^/]+\/(?:client|components)\/)/.test(
    relative(file),
  ) || file.endsWith('.tsx');
const edges = new Map();
const issues = [];
for (const file of files) {
  const ast = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
  const dependencies = [];
  const visit = (node) => {
    let target;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      target = node.moduleSpecifier.text;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      target = node.arguments[0].text;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      target = node.arguments[0].text;
    if (target) {
      const asset = target.startsWith('.') ? path.resolve(path.dirname(file), target) : undefined;
      const resolved =
        ts.resolveModuleName(target, file, config.options, ts.sys).resolvedModule
          ?.resolvedFileName ?? (asset && ts.sys.fileExists(asset) ? asset : undefined);
      if (
        target.startsWith('node:') ||
        target.startsWith('cloudflare:') ||
        target === '@cloudflare/workers-types'
      )
        dependencies.push(target);
      if (resolved?.startsWith(sourceRoot)) {
        dependencies.push(resolved);
        const fromOwner = owner(file),
          toOwner = owner(resolved);
        if (fromOwner && toOwner && fromOwner !== toOwner) {
          if (
            !allowed[fromOwner]?.includes(toOwner) ||
            (fromOwner === 'history' &&
              !/^src\/modules\/tasks\/(?:contracts|model|planning|planning-contract|query-contract|client\/usePlanningToday)\.ts$/.test(
                relative(resolved),
              ))
          )
            issues.push(`${relative(file)} cannot depend on ${relative(resolved)}`);
          if (
            isServerFile(resolved) &&
            !publicServerFiles[toOwner]?.includes(
              relative(resolved).slice(`src/modules/${toOwner}/`.length),
            )
          )
            issues.push(
              `${relative(file)} must use an explicit public operation/query rather than ${relative(resolved)}`,
            );
        }
        if (fromOwner && relative(resolved).startsWith('src/web/'))
          issues.push(
            `${relative(file)} cannot depend on the application shell ${relative(resolved)}`,
          );
        if (
          relative(file).startsWith('src/client/') &&
          (toOwner || relative(resolved).startsWith('src/web/'))
        )
          issues.push(
            `${relative(file)} is browser infrastructure and cannot import ${relative(resolved)}`,
          );
        if (
          relative(file).startsWith('src/ui/') &&
          (toOwner || /^src\/(web|client|worker)\//.test(relative(resolved)))
        )
          issues.push(`${relative(file)} is shared ui and cannot import ${relative(resolved)}`);
        if (
          relative(file).startsWith('src/contracts/') &&
          /src\/(modules|web|client|worker|ui)\//.test(relative(resolved))
        )
          issues.push(`${relative(file)} must remain context independent`);
        if (
          isServerFile(file) &&
          (isBrowserFile(resolved) ||
            /\.css$/.test(resolved) ||
            relative(resolved).startsWith('src/styles/'))
        )
          issues.push(
            `${relative(file)} cannot depend on browser presentation ${relative(resolved)}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  edges.set(file, dependencies);
}
const isServer = (value) =>
  value.startsWith('node:') ||
  value.startsWith('cloudflare:') ||
  value === '@cloudflare/workers-types' ||
  isServerFile(value);
const seen = new Set();
function walk(file, chain) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const next of edges.get(file) ?? []) {
    if (isServer(next))
      issues.push(
        `browser/server boundary: ${[...chain, relative(file), next.startsWith(sourceRoot) ? relative(next) : next].join(' -> ')}`,
      );
    else walk(next, [...chain, relative(file)]);
  }
}
const browserEntries = files.filter(isBrowserFile);
if (!files.length || !browserEntries.length)
  issues.push(
    'no browser source entry points were checked; update the boundary configuration for the actual source layout',
  );
for (const file of browserEntries) walk(file, []);
if (issues.length) {
  process.stderr.write([...new Set(issues)].join('\n') + '\n');
  process.exitCode = 1;
} else
  process.stdout.write(
    `checked ${files.length} source files; ownership and browser/server boundaries passed\n`,
  );
