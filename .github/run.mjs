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
  run('node_modules/.bin/wrangler', ['deploy', '--dry-run', '--outdir', 'dist']);
}
const target = process.argv[2] ?? 'check';
if (target === 'build') build();
else if (target === 'check') {
  if (existsSync('scripts') || existsSync('tests'))
    throw new Error('Keep verification under .github/');
  run('node_modules/.bin/tsc', ['--noEmit']);
  build();
  const tests = readdirSync('.github/tests').filter(
    (name) => name.endsWith('.test.ts') && name !== 'live-gmail.test.ts',
  );
  if (!tests.length) throw new Error('No credential-free tests found');
  run(process.execPath, [
    '--experimental-strip-types',
    '--test',
    ...tests.map((name) => `.github/tests/${name}`),
  ]);
  run('node_modules/.bin/prettier', ['--check', '.']);
} else if (target === 'live') {
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
    '.github/tests/live-gmail.test.ts',
  ]);
} else throw new Error('Use check, build, or live');
