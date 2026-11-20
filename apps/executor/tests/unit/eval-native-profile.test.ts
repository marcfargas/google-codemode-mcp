import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCell } from '../eval/run.ts';

test('native capability mode cannot replace matrix performers or expand its case/budget before effects', async () => {
  const original = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'native-profile-refusal-'));
  const output = join(root, 'must-not-exist');
  try {
    for (const patch of [
      { EVAL_SELECTION: 'required' },
      { EVAL_MODEL: 'gpt-6.2-sol' },
      { EVAL_PROFILE: 'drive' },
      { EVAL_CASE: 'attachment' },
      { EVAL_REPEATS: '2' },
      { EVAL_CASES: 'read-search' },
    ]) {
      process.env = {
        ...original,
        ACT: 'true',
        EVAL_RUNNER: 'codex',
        EVAL_PROFILE: 'gmail',
        EVAL_MODEL: 'gpt-6.1-sol',
        EVAL_CASE: 'read-search',
        EVAL_REPEATS: '1',
        EVAL_SELECTION: '',
        EVAL_CASES: '',
        EVAL_OUTPUT: output,
        ...patch,
      };
      await assert.rejects(runCell(), /one optional Gmail read-search probe with gpt-6\.1-sol/);
      await assert.rejects(access(output));
    }
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
});
