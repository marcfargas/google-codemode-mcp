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
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const event=JSON.parse(fs.readFileSync(args[args.indexOf('--eventpath')+1],'utf8'));
if(!process.env.EVAL_TEST_SKIP_REPORT){
  const directory=path.join(process.env.output,'workflow-report');fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,'summary.json'),'{}');
}
process.stdout.write(JSON.stringify({args,event}));
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, 'flock'),
      '#!/usr/bin/env node\nprocess.stdout.write("locked\\n");process.stdin.resume();\n',
      { mode: 0o700 },
    );
    for (const [index, { options, skipReport }] of [
      { options: undefined, skipReport: false },
      { options: '', skipReport: false },
      { options: '--stack-trace-limit=37 --no-deprecation', skipReport: false },
      { options: undefined, skipReport: true },
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
      if (skipReport) env.EVAL_TEST_SKIP_REPORT = 'true';
      const child = spawnSync(process.execPath, [fileURLToPath(helperUrl)], {
        env,
        encoding: 'utf8',
      });
      if (skipReport) {
        assert.notEqual(child.status, 0);
        assert.match(child.stderr, /workflow produced no report/);
        continue;
      }
      assert.equal(child.status, 0, child.stderr);
      const {
        args,
        event,
      }: {
        args: string[];
        event: { ref: string; inputs: Record<string, string> };
      } = JSON.parse(child.stdout);
      assert.equal(event.ref, 'refs/heads/main');
      assert.deepEqual(event.inputs, {
        backend: 'local',
        profile: 'drive',
        selection: 'required',
        cases: 'all',
        proxy_url: 'http://127.0.0.1:1',
        output: '/eval-evidence',
        repeats: '1',
        preflight_only: 'true',
        native_codex_probe: 'false',
      });
      assert.ok(!args.includes('--input'));
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
