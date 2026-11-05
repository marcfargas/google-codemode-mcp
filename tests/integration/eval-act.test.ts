import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const helperUrl = new URL('../eval/act.mjs', import.meta.url).href;
const { acquireLocalEvalLock, retainCandidateSource } = await import(helperUrl);

test('eval launcher forwards only explicit ACT_NODE_OPTIONS and retains it without inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-node-options-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'act'),
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, 'flock'),
      '#!/usr/bin/env node\nprocess.stdout.write("locked\\n");process.stdin.resume();\n',
      { mode: 0o700 },
    );
    for (const [index, options] of [
      undefined,
      '',
      '--stack-trace-limit=37 --no-deprecation',
    ].entries()) {
      const output = join(root, String(index));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        profile: 'drive',
        selection: 'required',
        cases: 'all',
        proxy_url: 'http://127.0.0.1:1',
        output,
        preflight_only: 'true',
        NODE_OPTIONS: '--no-deprecation',
      };
      delete env.ACT_NODE_OPTIONS;
      delete env.model;
      if (options !== undefined) env.ACT_NODE_OPTIONS = options;
      const child = spawnSync(process.execPath, [fileURLToPath(helperUrl)], {
        env,
        encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      const args: string[] = JSON.parse(child.stdout);
      const forwarded = args
        .flatMap((value, i) => (value === '--env' ? [args[i + 1]] : []))
        .filter((value) => value.startsWith('NODE_OPTIONS='));
      assert.deepEqual(forwarded, options === undefined ? [] : [`NODE_OPTIONS=${options}`]);
      const retained = JSON.parse(await readFile(join(output, 'container-profile.json'), 'utf8'));
      assert.equal(retained.nodeOptions, options ?? null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local exclusive evaluation lock rejects contention and releases without stale ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-act-lock-'));
  const lock = join(root, 'exclusive.lock');
  let release;
  try {
    release = await acquireLocalEvalLock(lock);
    await assert.rejects(acquireLocalEvalLock(lock), /Another local agent evaluation/);
    await release();
    release = await acquireLocalEvalLock(lock);
    await release();
    await release();
  } finally {
    if (release) await release();
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate source retains untracked evaluation implementation with exact hashes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-candidate-'));
  try {
    const manifest = await retainCandidateSource(output);
    assert.match(manifest['tests/eval/act.mjs'], /^[0-9a-f]{64}$/);
    assert.match(manifest['tests/eval/regrade.ts'], /^[0-9a-f]{64}$/);
    assert.equal(
      await readFile(join(output, 'candidate-source', 'tests/eval/regrade.ts'), 'utf8'),
      await readFile('tests/eval/regrade.ts', 'utf8'),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(output, 'candidate-source.json'), 'utf8')),
      manifest,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
