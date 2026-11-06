import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const options = process.argv.slice(2);
if (options.length > 1 || options.some((option) => option !== '--dry-run'))
  throw new Error('Use node deploy.mjs [--dry-run]');

const { WORKER_NAME: name, WORKER_DOMAIN: domain, WORKER_ROUTE: route } = process.env;
const bucket = process.env.ARTIFACTS_BUCKET;
const downloadOrigin = process.env.ARTIFACT_DOWNLOAD_ORIGIN;
const admission = Object.fromEntries(
  ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'ALLOWED_EMAILS']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
if (downloadOrigin !== undefined) {
  let parsed;
  try {
    parsed = new URL(downloadOrigin);
  } catch {
    /* Report a configuration error below. */
  }
  if (
    !parsed ||
    parsed.protocol !== 'https:' ||
    ![parsed.origin, parsed.origin + '/'].includes(downloadOrigin)
  )
    throw new Error(
      'ARTIFACT_DOWNLOAD_ORIGIN must be an HTTPS origin without credentials, path, query or fragment',
    );
}

if (bucket !== undefined && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
  throw new Error(
    'ARTIFACTS_BUCKET must name an existing private R2 bucket (3–63 lowercase letters, digits or hyphens)',
  );
const expectedName = process.env.WRANGLER_CI_OVERRIDE_NAME;
if (name && expectedName && name !== expectedName)
  throw new Error('WORKER_NAME must match the Worker selected by Workers Builds');
const selectedName = name || expectedName;
if (selectedName && !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(selectedName))
  throw new Error(
    'WORKER_NAME must use letters, digits, underscores, or hyphens and not start with a hyphen',
  );
if (domain && route) throw new Error('Set only one of WORKER_DOMAIN or WORKER_ROUTE');
if (
  domain &&
  (domain.length > 253 ||
    !domain.includes('.') ||
    !domain
      .split('.')
      .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
)
  throw new Error('WORKER_DOMAIN must be a hostname without a scheme, port, wildcard, or path');
if (route && (!route.includes('/') || /\s/.test(route) || route.startsWith('-')))
  throw new Error('WORKER_ROUTE must be a route pattern such as example.com/mcp*');

const args = ['deploy'];
const configFile = resolve(
  existsSync('wrangler.jsonc') ? 'wrangler.jsonc' : 'apps/executor/wrangler.jsonc',
);
// A caller-provided working directory may own its own config (including dry-run fixtures).
if (!existsSync('wrangler.jsonc') && existsSync(configFile)) args.push('--config', configFile);
if (selectedName) args.push('--name', selectedName);
if (domain) args.push('--domain', domain);
if (route) args.push('--route', route);
if (options.includes('--dry-run')) args.push('--dry-run', '--outdir', resolve('dist'));

let temporary;
try {
  if (bucket || downloadOrigin || Object.keys(admission).length) {
    const { experimental_readRawConfig } = await import('wrangler');
    const { rawConfig } = experimental_readRawConfig({ config: configFile });
    if (bucket && rawConfig.r2_buckets?.some((entry) => entry.binding === 'ARTIFACTS'))
      throw new Error('Configure ARTIFACTS through ARTIFACTS_BUCKET or the base config, not both');
    if (
      downloadOrigin &&
      !bucket &&
      !rawConfig.r2_buckets?.some((entry) => entry.binding === 'ARTIFACTS')
    )
      throw new Error(
        'ARTIFACT_DOWNLOAD_ORIGIN requires ARTIFACTS_BUCKET or a configured ARTIFACTS binding',
      );
    await mkdir('.wrangler', { recursive: true });
    temporary = await mkdtemp(resolve('.wrangler/artifacts-'));
    const config = {
      ...rawConfig,
      vars: { ...rawConfig.vars, ...admission },
      main: resolve(dirname(configFile), rawConfig.main),
      ...(rawConfig.tsconfig ? { tsconfig: resolve(dirname(configFile), rawConfig.tsconfig) } : {}),
      ...(bucket
        ? {
            r2_buckets: [
              ...(rawConfig.r2_buckets ?? []),
              { binding: 'ARTIFACTS', bucket_name: bucket },
            ],
          }
        : {}),
      ...(downloadOrigin
        ? {
            vars: {
              ...rawConfig.vars,
              ...admission,
              ARTIFACT_DOWNLOAD_ORIGIN: new URL(downloadOrigin).origin,
            },
          }
        : {}),
    };
    delete config.$schema;
    await writeFile(join(temporary, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
    const configIndex = args.indexOf('--config');
    if (configIndex !== -1) args.splice(configIndex, 2);
    args.push('--config', join(temporary, 'wrangler.json'));
  }
  const result = spawnSync('node_modules/.bin/wrangler', args, {
    stdio: 'inherit',
    // Preserve Wrangler's native auth and Workers Builds identity safeguards.
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error) throw new Error('Cannot start pinned Wrangler; run npm ci --ignore-scripts');
  process.exitCode = result.status ?? 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
