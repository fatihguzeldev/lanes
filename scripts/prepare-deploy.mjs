import { writeFileSync } from 'node:fs';

if (!process.env.LANES_DEPLOY_CONFIG) throw new Error('LANES_DEPLOY_CONFIG is required.');

let config;
try {
  config = JSON.parse(process.env.LANES_DEPLOY_CONFIG);
} catch {
  throw new Error('LANES_DEPLOY_CONFIG must contain valid JSON.');
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

writeFileSync('wrangler.deploy.jsonc', JSON.stringify(config, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
