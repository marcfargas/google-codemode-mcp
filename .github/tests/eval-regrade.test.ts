import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gradeSavedEvidence, regradeTrial } from '../eval/regrade.ts';

const native = [{ type: 'result', subtype: 'success', is_error: false }];
const actor = {
  native,
  exitCode: 0,
  timedOut: false,
  files: {},
  transcript: { valid: true },
  usage: { evidence: 'retained usage' },
};
const source = { revision: 'original-execution', requestedModel: 'selected-model' };
const original = {
  status: 'error',
  error: 'original execution error',
  relayCloseError: true,
  cleanupError: true,
  hasUnknownMutation: true,
  cleanup: {
    failures: ['preserved cleanup failure'],
    unknownMutations: [{ operation: 'unknown original mutation' }],
  },
};

test('offline grading preserves original errors, cleanup and unknown mutations', () => {
  const result = gradeSavedEvidence({
    expected: null,
    observation: null,
    files: {},
    actor,
    audit: [],
    receipts: [{ requestedModel: 'selected-model', servedModels: ['other-model'], complete: true }],
    source,
    original,
    evidenceErrors: [],
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.originalResult, original);
  assert.deepEqual(result.executionSource, source);
  assert.equal(result.liveSystemQualified, false);
  assert.deepEqual(result.originalUsage, actor.usage);
  assert.equal(result.usage?.totals.outputTokens, null);
  const criteria = Object.fromEntries(
    result.criteria.map((criterion) => [criterion.id, criterion.status]),
  );
  assert.equal(criteria.model_identity, 'fail');
  assert.equal(criteria.saved_cleanup, 'fail');
  assert.equal(criteria.mutation_certainty, 'unknown');
  assert.equal(criteria.saved_execution_errors, 'fail');
  assert.equal(criteria.native_execution, 'pass');
});

test('offline command copies original source/result, records current grader and retains missing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-regrade-'));
  const saved = join(root, 'trial-1');
  const output = join(root, 'regraded');
  try {
    await mkdir(saved);
    const sourceText = JSON.stringify(source, null, 4) + '\n';
    const originalText = JSON.stringify(original, null, 4) + '\n';
    await writeFile(join(root, 'source.json'), sourceText);
    await writeFile(join(saved, 'result.json'), originalText);
    await writeFile(join(saved, 'actor-result.json'), JSON.stringify(actor));
    await writeFile(join(saved, 'files.json'), '{}');
    await writeFile(join(saved, 'observation.json'), 'null');
    await writeFile(join(saved, 'mcp.jsonl'), 'malformed saved receipt\n');
    await writeFile(join(saved, 'model-receipts.jsonl'), '');
    const result = await regradeTrial(saved, output);
    assert.equal(result.status, 'error');
    assert.equal(await readFile(join(output, 'source.json'), 'utf8'), sourceText);
    assert.equal(await readFile(join(output, 'result.json'), 'utf8'), originalText);
    assert.equal(await readFile(join(saved, 'result.json'), 'utf8'), originalText);
    assert.ok(result.inputs['source.json'].sha256);
    assert.ok(result.gradingIdentity.files['regrade.ts']);
    const completeness = result.criteria.find(
      (criterion) => criterion.id === 'evidence_completeness',
    );
    assert.equal(completeness?.status, 'unknown');
    assert.match(completeness!.evidence, /expected.json/);
    assert.match(completeness!.evidence, /mcp.jsonl/);
    await assert.rejects(regradeTrial(saved, output), /EEXIST/);
    await assert.rejects(regradeTrial(saved, join(saved, 'nested-output')), /outside saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
