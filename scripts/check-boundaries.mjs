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
              !/^src\/modules\/tasks\/(contracts|model|planning|planning-contract)\.ts$/.test(
                relative(resolved),
              ))
          )
            issues.push(`${relative(file)} cannot depend on ${relative(resolved)}`);
          if (/\/(repository|persistence|provider)\.[cm]?[jt]s$/.test(resolved))
            issues.push(
              `${relative(file)} must use an explicit public operation/query rather than ${relative(resolved)}`,
            );
        }
        if (relative(file).startsWith('src/ui/') && toOwner)
          issues.push(`${relative(file)} is shared ui and cannot import ${relative(resolved)}`);
        if (
          relative(file).startsWith('src/contracts/') &&
          /src\/(modules|web|worker|ui)\//.test(relative(resolved))
        )
          issues.push(`${relative(file)} must remain context independent`);
        if (
          (relative(file).startsWith('src/worker/') || /\/server(?:\/|\.[jt]s$)/.test(file)) &&
          (/\.(tsx|css)$/.test(resolved) || /^src\/(web|ui|styles)\//.test(relative(resolved)))
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
  /src\/worker\//.test(relative(value)) ||
  /\/server(?:\/|\.[jt]s$)/.test(value) ||
  /\/(crypto|google|access|provider|repository|persistence)\.[jt]s$/.test(value);
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
const browserEntries = files.filter(
  (file) => relative(file).startsWith('src/web/') || file.endsWith('.tsx'),
);
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
