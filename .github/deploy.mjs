import { spawnSync } from 'node:child_process';

const options = process.argv.slice(2);
if (options.length > 1 || options.some((option) => option !== '--dry-run'))
  throw new Error('Use node .github/deploy.mjs [--dry-run]');

const { WORKER_NAME: name, WORKER_DOMAIN: domain, WORKER_ROUTE: route } = process.env;
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
if (selectedName) args.push('--name', selectedName);
if (domain) args.push('--domain', domain);
if (route) args.push('--route', route);
if (options.includes('--dry-run')) args.push('--dry-run', '--outdir', 'dist');

const result = spawnSync('node_modules/.bin/wrangler', args, {
  stdio: 'inherit',
  // Preserve Wrangler's native auth and Workers Builds identity safeguards.
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
if (result.error) throw new Error('Cannot start pinned Wrangler; run npm ci --ignore-scripts');
process.exitCode = result.status ?? 1;
