import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const helperUrl = new URL('../eval/act.mjs', import.meta.url).href;
const { acquireLocalEvalLock, retainCandidateSource } = await import(helperUrl);

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
