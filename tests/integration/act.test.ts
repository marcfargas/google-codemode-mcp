import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';

test('local check forwards only explicit ACT_NODE_OPTIONS as one act environment argument', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'google-codemode-fake-act-'));
  try {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'act'),
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o700 },
    );
    for (const options of [undefined, '', '--stack-trace-limit=37 --no-deprecation']) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_OPTIONS: '--no-deprecation',
      };
      delete env.ACT_NODE_OPTIONS;
      if (options !== undefined) env.ACT_NODE_OPTIONS = options;
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../act.mjs', import.meta.url)), 'check'],
        // No credential files exist in this working directory.
        { cwd: directory, env, encoding: 'utf8' },
      );
      assert.equal(child.status, 0, child.stderr);
      const args: string[] = JSON.parse(child.stdout);
      assert.equal(args[0], 'push');
      assert.equal(args[args.indexOf('-W') + 1], '.github/workflows/check.yml');
      const forwarded = args.flatMap((value, index) =>
        value === '--env' ? [args[index + 1]] : [],
      );
      assert.deepEqual(forwarded, options === undefined ? [] : [`NODE_OPTIONS=${options}`]);
      assert.ok(!forwarded.includes('NODE_OPTIONS=--no-deprecation'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local live launcher retains exact allowlisted candidate identity before invoking act', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'google-codemode-act-source-'));
  const git = (...args: string[]) => {
    const child = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  };
  try {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'tests'));
    await writeFile(join(directory, 'src/example.ts'), 'baseline\n');
    git('init', '--initial-branch=main');
    git('add', 'src/example.ts');
    git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Synthetic fixture',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '-m',
      'Synthetic baseline',
    );
    const head = git('rev-parse', 'HEAD');
    await writeFile(join(directory, 'src/example.ts'), 'dirty\n');
    await writeFile(join(directory, 'tests/untracked.ts'), 'untracked candidate\n');
    // Only synthetic local files are read; the fake lock and act never touch
    // the shared account lock, Docker, a provider or an actual Google service.
    await writeFile(join(directory, '.test.env'), 'GOOGLE_TEST_USER=synthetic@example.invalid\n');
    await writeFile(
      join(directory, 'client.json'),
      JSON.stringify({
        installed: { client_id: 'synthetic-client', client_secret: 'synthetic-client-secret' },
      }),
    );
    await writeFile(
      join(directory, 'grant.json'),
      JSON.stringify({
        user: 'synthetic@example.invalid',
        clientId: 'synthetic-client',
        refreshToken: 'synthetic-refresh-token',
      }),
    );
    await writeFile(
      join(bin, 'flock'),
      '#!/usr/bin/env node\nprocess.stdout.write("locked\\n");process.stdin.resume();\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, 'act'),
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),artifacts=args[args.indexOf('--artifact-server-path')+1];
const candidate=fs.readdirSync(artifacts).find(name=>name.startsWith('candidate-'));
if(!candidate||!fs.existsSync(path.join(artifacts,candidate,'source.json')))process.exit(42);
`,
      { mode: 0o700 },
    );
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../act.mjs', import.meta.url)), 'live-drive'],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GOOGLE_OAUTH_CLIENT_FILE: join(directory, 'client.json'),
          GOOGLE_TEST_TOKEN_FILE: join(directory, 'grant.json'),
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const artifacts = join(directory, 'dist/act-artifacts');
    const candidates = await readdir(artifacts);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0], /^candidate-[0-9a-f-]{36}$/);
    const candidate = join(artifacts, candidates[0]);
    const identity = JSON.parse(await readFile(join(candidate, 'source.json'), 'utf8'));
    const manifestBytes = await readFile(join(candidate, 'candidate-source.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const patch = await readFile(join(candidate, 'source.patch'));
    assert.equal(identity.head, head);
    assert.equal(identity.diffSha256, createHash('sha256').update(patch).digest('hex'));
    assert.equal(
      identity.sourceManifestSha256,
      createHash('sha256').update(manifestBytes).digest('hex'),
    );
    assert.match(patch.toString('utf8'), /-baseline\n\+dirty/);
    assert.deepEqual(Object.keys(manifest).sort(), ['src/example.ts', 'tests/untracked.ts']);
    for (const [file, expected] of [
      ['src/example.ts', 'dirty\n'],
      ['tests/untracked.ts', 'untracked candidate\n'],
    ]) {
      assert.equal(await readFile(join(candidate, 'candidate-source', file), 'utf8'), expected);
      assert.equal(manifest[file], createHash('sha256').update(expected).digest('hex'));
    }
    assert.ok(!child.stdout.includes('synthetic-client-secret'));
    assert.ok(!child.stdout.includes('synthetic-refresh-token'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('maintained workflows retain one unconditional native checkout without an explicit ref', async () => {
  // Source audit of pinned checkout 11bd719: its input helper defaults the
  // workflow repository to context.ref AND context.sha, and fetch targets that
  // commit. Omitting ref preserves remote event identity and act's local copy.
  const checkout = '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
  for (const name of ['check', 'live', 'live-drive', 'evaluate']) {
    const source = await readFile(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    );
    const steps = source.match(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gm) ?? [];
    const checkouts = steps.filter((step) => /uses: actions\/checkout@/.test(step));
    assert.equal(checkouts.length, 1, name);
    assert.equal(checkouts[0].trimEnd(), checkout, name);
  }
});
