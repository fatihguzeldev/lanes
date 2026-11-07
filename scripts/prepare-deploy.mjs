import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const privatePath = 'wrangler.deploy.jsonc';
const existing = existsSync(privatePath);
const supplied = process.env.LANES_DEPLOY_CONFIG !== undefined;
if (!existing && !supplied)
  throw new Error('private deployment configuration or LANES_DEPLOY_CONFIG is required.');

let config;
try {
  if (supplied) config = JSON.parse(process.env.LANES_DEPLOY_CONFIG);
  else {
    const parsed = ts.parseConfigFileTextToJson(privatePath, readFileSync(privatePath, 'utf8'));
    if (parsed.error) throw new Error();
    config = parsed.config;
  }
} catch {
  throw new Error('private deployment configuration must contain valid JSON.');
}

const database = Array.isArray(config?.d1_databases)
  ? config.d1_databases.find((value) => value?.binding === 'DB')
  : undefined;
const values = [
  config?.account_id,
  config?.name,
  database?.database_id,
  config?.vars?.APP_ORIGIN,
  config?.vars?.OWNER_EMAIL,
];
if (
  values.some((value) => typeof value !== 'string' || !value.trim()) ||
  database.database_id === '00000000-0000-0000-0000-000000000000'
)
  throw new Error('private deployment configuration needs its installation values.');

const allowedVars = new Set(['APP_ORIGIN', 'OWNER_EMAIL', 'TOKEN_KEY_ID']);
if (
  Object.entries(config.vars).some(
    ([key, value]) => !allowedVars.has(key) || typeof value !== 'string' || !value.trim(),
  )
)
  throw new Error(
    'private deployment configuration allows only application origin, owner and token key id vars.',
  );

if (
  config.assets !== undefined &&
  (!config.assets || typeof config.assets !== 'object' || Array.isArray(config.assets))
)
  throw new Error('private deployment assets configuration must be an object.');
const routes = config.assets?.run_worker_first;
if (
  routes !== undefined &&
  typeof routes !== 'boolean' &&
  (!Array.isArray(routes) || routes.some((route) => typeof route !== 'string'))
)
  throw new Error('private deployment worker routes must be a boolean or string array.');
const requiredRoutes = ['/', '/index.html', '/api/*', '/auth/*'];
const configuredRoutes = Array.isArray(routes) ? routes : [];
const covers = (pattern, route) =>
  pattern === route || (pattern.endsWith('*') && route.startsWith(pattern.slice(0, -1)));
if (
  configuredRoutes.some(
    (route) =>
      route.startsWith('!') &&
      requiredRoutes.some(
        (required) => covers(route.slice(1), required) || covers(required, route.slice(1)),
      ),
  )
)
  throw new Error(
    'private deployment exclusions must not bypass document, api or auth worker routes.',
  );
const combined = [...new Set([...configuredRoutes, ...requiredRoutes])];
config.assets = {
  ...config.assets,
  run_worker_first:
    routes === true
      ? true
      : combined.filter(
          (route) =>
            route.startsWith('!') ||
            !combined.some(
              (other) => other !== route && !other.startsWith('!') && covers(other, route),
            ),
        ),
};

writeFileSync(privatePath, JSON.stringify(config, null, 2) + '\n', {
  mode: 0o600,
  flag: existing ? 'w' : 'wx',
});
