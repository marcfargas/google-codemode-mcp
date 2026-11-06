import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dry-run') || args.length > 1)
  throw new Error('Use just deploy-gateway [--dry-run]');
const dry = args.includes('--dry-run');
const { rawConfig } = experimental_readRawConfig({
  config: resolve('apps/gateway/wrangler.jsonc'),
});
const vars = { ...rawConfig.vars };
for (const key of [
  'GATEWAY_ORIGIN',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'ALLOWED_EMAILS',
  'ENVIRONMENT',
  'GOOGLE_OAUTH_CLIENT_ID',
  'REQUIRE_ACCESS_ON_MCP',
]) {
  if (process.env[key] !== undefined) vars[key] = process.env[key];
}
const origin = new URL(vars.GATEWAY_ORIGIN);
if (origin.protocol !== 'https:' || origin.origin !== vars.GATEWAY_ORIGIN)
  throw new Error('GATEWAY_ORIGIN must be a canonical HTTPS origin');
const namespace = process.env.OAUTH_KV_NAMESPACE_ID;
const bucket = process.env.ARTIFACTS_BUCKET;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (
  !dry &&
  (!namespace ||
    !bucket ||
    !account ||
    !vars.CF_ACCESS_TEAM_DOMAIN ||
    !vars.CF_ACCESS_AUD ||
    !vars.ALLOWED_EMAILS ||
    !vars.GOOGLE_OAUTH_CLIENT_ID)
)
  throw new Error(
    'Configure CLOUDFLARE_ACCOUNT_ID, OAUTH_KV_NAMESPACE_ID, ARTIFACTS_BUCKET, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, ALLOWED_EMAILS and GOOGLE_OAUTH_CLIENT_ID before deployment',
  );
if (namespace && !/^[a-f0-9]{32}$/.test(namespace))
  throw new Error('Invalid OAUTH_KV_NAMESPACE_ID');
if (bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
  throw new Error('Invalid ARTIFACTS_BUCKET');
if (account && !/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID');
if (bucket) Object.assign(vars, { R2_BUCKET: bucket, R2_ACCOUNT_ID: account });
const name = process.env.GATEWAY_WORKER_NAME ?? rawConfig.name;
const executor = process.env.EXECUTOR_WORKER_NAME ?? 'google-codemode-mcp';
for (const value of [name, executor])
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(value)) throw new Error('Invalid Worker name');
if (process.env.WRANGLER_CI_OVERRIDE_NAME && process.env.WRANGLER_CI_OVERRIDE_NAME !== name)
  throw new Error('GATEWAY_WORKER_NAME must match Workers Builds');
await mkdir('.wrangler', { recursive: true });
const directory = await mkdtemp(resolve('.wrangler/gateway-'));
try {
  const config = {
    ...rawConfig,
    name,
    main: resolve('apps/gateway', rawConfig.main),
    vars,
    kv_namespaces: [{ binding: 'OAUTH_KV', id: namespace ?? '0'.repeat(32) }],
    services: [{ binding: 'EXECUTOR', service: executor, entrypoint: 'Executor' }],
    ...(bucket ? { r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: bucket }] } : {}),
    ...(process.env.GATEWAY_DOMAIN
      ? { routes: [{ pattern: process.env.GATEWAY_DOMAIN, custom_domain: true }] }
      : {}),
  };
  delete config.$schema;
  const path = join(directory, 'wrangler.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const result = spawnSync(
    'node_modules/.bin/wrangler',
    [
      'deploy',
      '--config',
      path,
      ...(dry ? ['--dry-run', '--outdir', resolve('dist/gateway')] : []),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  if (result.error) throw new Error('Cannot start pinned Wrangler');
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
