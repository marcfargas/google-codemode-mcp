import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

function run(program, args) {
  const result = spawnSync(program, args, {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error) throw new Error(`Cannot start ${program}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function build() {
  run(process.execPath, ['apps/executor/deploy.mjs', '--dry-run']);
  if (existsSync('apps/gateway/wrangler.jsonc'))
    run(process.execPath, ['apps/gateway/deploy.mjs', '--dry-run']);
}
const target = process.argv[2] ?? 'check';
if (target === 'build') build();
else if (target === 'check') {
  run('node_modules/.bin/tsc', ['--noEmit']);
  build();
  const tests = [
    'apps/executor/tests/unit',
    'apps/executor/tests/integration',
    'apps/executor/tests/preflight',
    'apps/gateway/tests',
    'tests/integration',
  ]
    .filter(existsSync)
    .flatMap((directory) =>
      readdirSync(directory, { recursive: true })
        .filter((name) => name.endsWith('.test.ts'))
        .sort()
        .map((name) => `${directory}/${name}`),
    );
  if (!tests.length) throw new Error('No credential-free tests found');
  run(process.execPath, ['--experimental-strip-types', '--test', ...tests]);
  run('node_modules/.bin/prettier', ['--check', '.']);
} else if (['live', 'live-drive', 'live-media'].includes(target)) {
  for (const name of [
    'GOOGLE_TEST_USER',
    'GOOGLE_OAUTH_CLIENT_JSON',
    'GOOGLE_TEST_REFRESH_TOKEN',
  ]) {
    if (!process.env[name])
      throw new Error(`Missing ${name}; run just oauth and configure test credentials`);
  }
  build();
  run(process.execPath, [
    '--experimental-strip-types',
    '--test',
    '--test-concurrency=1',
    target === 'live'
      ? 'apps/executor/tests/live/live-gmail.test.ts'
      : `apps/executor/tests/live/${target}.test.ts`,
  ]);
} else throw new Error('Use check, build, live, live-drive, or live-media');
