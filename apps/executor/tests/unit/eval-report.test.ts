import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { MATRIX } from '../eval/matrix.ts';
import {
  renderRunReport,
  retainedRunPassed,
  summarizeSavedRun,
  writeRetainedReport,
} from '../eval/report.ts';

const secret =
  'private-test@example.invalid https://private-proxy.invalid /private/home token=SECRET fixture-id-private';
const hash = 'b'.repeat(64);
const sonnet = MATRIX.find((item) => item.id === 'sonnet')!;
const sol = MATRIX.find((item) => item.id === 'sol')!;
const goal = { id: 'conditional-update-unsupported', version: 2 };
const json = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
async function workspace(exercise: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'eval-report-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Report must never access network');
  }) as typeof fetch;
  try {
    await exercise(directory);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}
function usage(claude = true) {
  return {
    totalsSource: claude ? 'terminal_native_result' : 'terminal_responses_usage',
    totals: {
      inputTokens: claude ? 12 : 100,
      outputTokens: 10,
      cacheReadInputTokens: claude ? 60 : 80,
      cacheCreationInputTokens: claude ? 8 : null,
      reasoningOutputTokens: claude ? null : 0,
    },
    turns: [{ inputTokens: 9999999 }], // Separate partial stream observations must not be added.
    nativeResults: claude
      ? [{ cliEstimatedCostUsd: 0.05, sessionId: secret, modelUsage: secret }]
      : [],
    providerBilledCostUsd: null,
  };
}
function result(claude = true) {
  return {
    repetition: 1,
    status: claude ? 'fail' : 'pass',
    taskSuccess: !claude,
    caseVersion: 2,
    gradingVersion: 3,
    startedAt: '2026-11-05T00:00:00Z',
    finishedAt: '2026-11-05T00:00:05Z',
    criteria: [
      { id: 'drive_version_preserved', status: claude ? 'fail' : 'pass', evidence: secret },
      { id: secret, status: 'fail' },
    ],
    hasUnknownMutation: false,
    cleanup: { failures: [], unknownMutations: [] },
    usage: usage(claude),
    error: secret,
  };
}
async function savedCell(directory: string, claude = true, patch: Record<string, unknown> = {}) {
  const cell = claude ? sonnet : sol;
  await json(join(directory, 'source.json'), {
    ...cell,
    cellId: cell.id,
    requestedModel: cell.model,
    repeats: 1,
    caseId: goal.id,
    caseVersion: 2,
    gradingVersion: 3,
    revision: 'a'.repeat(40),
    backend: { kind: 'local', bundleSha256: hash, proxy: secret },
    runnerVersion: claude ? '2.1.318' : 'responses-loop-3',
    accountingVersion: claude ? null : 2,
    limits: { wallMs: 300000, modelRequests: 18, retries: 0 },
    private: secret,
  });
  const data = { ...result(claude), ...patch };
  await json(join(directory, 'trial-1/result.json'), data);
  await json(join(directory, 'results.json'), [data]);
  await json(join(directory, 'attempts.json'), { requested: 1, attempted: 1, unattempted: 0 });
  await json(join(directory, 'trial-1/expected.json'), { version: '2', fileId: secret });
  await json(join(directory, 'trial-1/observation.json'), { file: { version: '3', id: secret } });
  await json(join(directory, 'trial-1/fixture-manifest.json'), {
    fileIds: [secret],
    readiness: [
      { version: '1', elapsedMs: 1, status: 'waiting', fileId: secret },
      { version: '2', elapsedMs: 3000, status: 'waiting' },
      { version: '2', elapsedMs: 6000, status: 'ready' },
    ],
  });
}
async function receipts(directory: string, rows: Record<string, unknown>[]) {
  await mkdir(join(directory, 'trial-1'), { recursive: true });
  await writeFile(
    join(directory, 'trial-1/model-receipts.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
}
function receipt(index: number, model = sol.model) {
  return {
    request: index,
    requestedModel: model,
    servedModels: [model],
    complete: true,
    systemHash: hash,
    toolsHash: hash,
    usagePublishedRateEstimateUsd: index / 10,
    totalCommittedEstimateUsd: index === 1 ? 0.5 : 0.8,
    usageEvents: [{ input_tokens: 9999999 }, { input_tokens: 9999999 }],
    payload: secret,
  };
}
async function fingerprints(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await fingerprints(path));
    else
      files[path] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
  return files;
}

test('offline acceptance consumes complete recorded gates while preserving reports and optional roles', async () => {
  await workspace(async (root) => {
    const saved = join(root, 'saved');
    await savedCell(saved, false, {
      criteria: [{ id: 'drive_file', status: 'pass' }],
      usage: undefined,
    });
    await receipts(saved, [receipt(1)]);
    const before = await fingerprints(saved);
    const original = await readFile(join(saved, 'trial-1/result.json'), 'utf8');
    const run = (name: string) =>
      spawnSync(
        process.execPath,
        ['apps/executor/tests/eval/report.ts', saved, join(root, name), '--require-pass'],
        { env: { PATH: process.env.PATH }, encoding: 'utf8' },
      );
    const accepted = run('accepted');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(await fingerprints(saved), before);
    const report = await summarizeSavedRun(saved);
    assert.equal(
      report.attempts[0].tokens.inputTokens,
      null,
      'unknown usage does not fail acceptance',
    );
    assert.equal(
      report.recordedGate.requiredPairStatus,
      'unknown',
      'single model does not qualify the pair',
    );

    // The aggregate still says pass: contradictory or missing trial evidence must refuse.
    for (const [name, patch] of Object.entries({
      failed: { status: 'fail', taskSuccess: false },
      wrongCase: { caseId: 'rename-file' },
      wrongVersion: { caseVersion: 999 },
      unknown: { criteria: [{ id: 'drive_file', status: 'unknown' }] },
      unsafe: { hasUnknownMutation: true },
      cleanup: { cleanup: { failures: ['residual'], unknownMutations: [] } },
    })) {
      await json(join(saved, 'trial-1/result.json'), { ...JSON.parse(original), ...patch });
      assert.equal(run(name).status, 1, name);
      assert.equal(
        JSON.parse(await readFile(join(root, name, 'summary.json'), 'utf8')).recordedGate
          .selectedStatus,
        'pass',
      );
    }
    await rm(join(saved, 'trial-1/result.json'));
    assert.equal(run('missing').status, 1);
    await writeFile(join(saved, 'trial-1/result.json'), original);
    await json(join(saved, 'report-preflight.json'), {
      synthetic: true,
      inference: false,
      google: false,
    });
    assert.equal(run('synthetic').status, 1);

    const optional = structuredClone(report);
    Object.assign(optional.attempts[0], { role: 'probe', status: 'fail', taskSuccess: false });
    assert.equal(retainedRunPassed(optional), true, 'optional score failures remain informational');
    optional.attempts[0].cleanup.unknownMutations = 1;
    assert.equal(retainedRunPassed(optional), false, 'optional safety failures still block');

    const matrix = join(root, 'matrix');
    const cellPath = join(matrix, 'sol');
    await json(join(matrix, 'matrix-source.json'), {
      caseId: goal.id,
      caseVersion: goal.version,
      cells: [sol],
    });
    await json(join(matrix, 'matrix-results.json'), {
      selectedStatus: 'pass',
      results: [],
      rows: [],
    });
    await savedCell(cellPath, false);
    await receipts(cellPath, [receipt(1)]);
    const source = JSON.parse(await readFile(join(cellPath, 'source.json'), 'utf8'));
    await json(join(cellPath, 'source.json'), { ...source, role: 'reference' });
    const mismatch = await summarizeSavedRun(matrix);
    assert.ok(mismatch.attempts[0].issues.includes('cell_source_mismatch'));
    assert.equal(
      retainedRunPassed(mismatch),
      false,
      'a required row cannot demote itself through its child receipt',
    );
  });
});

test('offline report preserves original gates, separates cache bases and is deterministic and public-safe', async () => {
  await workspace(async (root) => {
    const saved = join(root, 'saved');
    await json(join(saved, 'suite-source.json'), { cases: [goal], cells: [sonnet, sol] });
    await json(join(saved, 'suite-results.json'), {
      selectedStatus: 'fail',
      requiredPairStatus: 'fail',
      unattempted: [],
      results: [],
      error: secret,
    });
    const matrix = join(saved, goal.id);
    await json(join(matrix, 'matrix-results.json'), { results: [], rows: [], unattempted: [] });
    await savedCell(join(matrix, 'sonnet'));
    await savedCell(join(matrix, 'sol'), false);
    await receipts(join(matrix, 'sonnet'), [receipt(1, sonnet.model)]);
    await receipts(join(matrix, 'sol'), [receipt(1), receipt(2)]);
    const before = await fingerprints(saved);
    const report = await writeRetainedReport(saved, join(root, 'report-one'));
    await writeRetainedReport(saved, join(root, 'report-two'));
    assert.deepEqual(await fingerprints(saved), before);
    assert.equal(
      await readFile(join(root, 'report-one/summary.json'), 'utf8'),
      await readFile(join(root, 'report-two/summary.json'), 'utf8'),
    );
    assert.equal(
      await readFile(join(root, 'report-one/summary.md'), 'utf8'),
      await readFile(join(root, 'report-two/summary.md'), 'utf8'),
    );
    assert.deepEqual(report.counts, {
      selected: 2,
      attempted: 2,
      attemptedUnknown: 0,
      pass: 1,
      fail: 1,
      error: 0,
      unattempted: 0,
      missingResult: 0,
    });
    assert.equal(report.recordedGate.requiredPairStatus, 'fail');
    const [claude, gpt] = report.attempts;
    assert.equal(claude.tokens.inputTokens, 12);
    assert.equal(claude.costs.nativeCliEstimateUsd, 0.05);
    assert.equal(claude.tokenBasis, 'claude_separate_cache');
    assert.equal(claude.cacheReadFraction, 0.75);
    assert.equal(gpt.uncachedInputTokens, 20);
    assert.equal(gpt.cacheReadFraction, 0.8);
    assert.equal(gpt.tokens.cacheCreationInputTokens, null);
    assert.equal(gpt.tokens.reasoningOutputTokens, 0);
    assert.equal(gpt.costs.publishedRateEstimateUsd.value, 0.1 + 0.2);
    assert.equal(gpt.costs.committedEstimateUsd, 0.8, 'latest cumulative value, not sum');
    assert.equal(gpt.requests.count, 2);
    assert.equal(gpt.requests.systemPrefixStable, true);
    assert.equal(gpt.requests.identityMatches, 2);
    assert.deepEqual(claude.failedCriteria, ['drive_version_preserved']);
    assert.equal(claude.omittedCriteria, 1);
    assert.deepEqual(
      claude.versionEvidence.readiness.map((entry) => entry.version),
      ['1', '2', '2'],
    );
    assert.equal(claude.identity.revision, 'a'.repeat(40));
    assert.equal(
      claude.identity.sourceReceiptSha256,
      createHash('sha256')
        .update(await readFile(join(matrix, 'sonnet/source.json')))
        .digest('hex'),
    );
    assert.equal(claude.limits.wallMs, 300000);
    const output = JSON.stringify(report) + renderRunReport(report);
    assert.match(
      renderRunReport(report),
      /1@1ms\(waiting\) → 2@3000ms\(waiting\) → 2@6000ms\(ready\)/,
    );
    assert.match(renderRunReport(report), /backend local/);
    for (const value of secret.split(' ')) assert.ok(!output.includes(value), value);
    await assert.rejects(writeRetainedReport(saved, join(root, 'report-one')), { code: 'EEXIST' });
    await assert.rejects(writeRetainedReport(saved, saved), /new directory/);
    await assert.rejects(
      writeRetainedReport(saved, join(root, 'invalid-step-target'), {
        stepSummary: join(saved, 'suite-results.json'),
      }),
      /outside retained/,
    );
    // Workflow retains a new child under its mounted evidence root without replacing source files.
    await writeRetainedReport(saved, join(saved, 'workflow-report'));
    for (const [path, digest] of Object.entries(before))
      assert.equal(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
        digest,
      );
  });
});

test('partial and missing telemetry stay unknown with coverage; actor fallback is counted once', async () => {
  await workspace(async (root) => {
    await savedCell(root, false, { usage: undefined });
    await json(join(root, 'trial-1/actor-result.json'), { usage: usage(false) });
    await receipts(root, [
      { ...receipt(1), toolsHash: undefined },
      {
        ...receipt(2),
        usagePublishedRateEstimateUsd: undefined,
        totalCommittedEstimateUsd: undefined,
      },
    ]);
    const report = await summarizeSavedRun(root);
    const row = report.attempts[0];
    assert.equal(row.tokens.inputTokens, 100);
    const sourcePath = join(root, 'source.json');
    const source = JSON.parse(await readFile(sourcePath, 'utf8'));
    await json(sourcePath, {
      ...source,
      files: { 'apps/executor/tests/eval/run.ts': 'c'.repeat(64) },
    });
    const changedSource = (await summarizeSavedRun(root)).attempts[0].identity;
    assert.equal(changedSource.revision, row.identity.revision);
    assert.equal(changedSource.bundleDigest, row.identity.bundleDigest);
    assert.notEqual(changedSource.sourceReceiptSha256, row.identity.sourceReceiptSha256);
    assert.equal(row.costs.publishedRateEstimateUsd.value, null);
    assert.equal(row.costs.publishedRateEstimateUsd.observedSubtotal, 0.1);
    assert.equal(row.costs.publishedRateEstimateUsd.covered, 1);
    assert.equal(row.costs.publishedRateEstimateUsd.expected, 2);
    assert.equal(row.costs.committedEstimateUsd, null, 'earlier commitment is not a final total');
    assert.equal(row.costs.providerBilledCostUsd, null);
    assert.equal(row.requests.toolsPrefixStable, null);
    assert.equal(report.models[0].costs.publishedRateEstimateUsd.observedSubtotal, 0.1);
    assert.equal(report.models[0].costs.publishedRateEstimateUsd.value, null);
    await writeFile(join(root, 'trial-1/model-receipts.jsonl'), '{malformed');
    const broken = (await summarizeSavedRun(root)).attempts[0];
    assert.equal(broken.requests.count, null);
    assert.ok(broken.issues.includes('malformed_artifact'));
    await receipts(root, [receipt(1), receipt(1)]);
    assert.equal(
      (await summarizeSavedRun(root)).attempts[0].costs.publishedRateEstimateUsd.value,
      null,
    );
  });
});

test('suite safety stops retain every declared unattempted case/model and do not double-count matrix results', async () => {
  await workspace(async (root) => {
    const cases = [{ id: 'read-file', version: 1 }, goal];
    await json(join(root, 'suite-source.json'), { cases, cells: [sonnet, sol] });
    await json(join(root, 'suite-results.json'), {
      selectedStatus: 'fail',
      requiredPairStatus: 'fail',
      unattempted: [goal.id],
      results: [{ caseId: 'read-file', selectedStatus: 'fail' }],
    });
    await json(join(root, 'read-file/matrix-results.json'), {
      results: [{ cellId: 'sonnet', status: 'error', error: secret }],
      unattempted: ['sol'],
    });
    const report = await summarizeSavedRun(root);
    assert.equal(report.counts.selected, 4);
    assert.equal(report.counts.attempted, 1);
    assert.equal(report.counts.error, 1);
    assert.equal(report.counts.unattempted, 3);
    assert.equal(report.attempts[0].tokens.inputTokens, null);
    assert.equal(report.attempts[0].requests.count, null);
    assert.equal(report.attempts[0].cleanup.failures, null);
  });
});

test('matrix report preserves historical roles and reports missing selected results as unknown', async () => {
  await workspace(async (root) => {
    const terra = { ...MATRIX.find((item) => item.id === 'terra')!, role: 'required' };
    const oldSol = { ...sol, role: 'reference' };
    await json(join(root, 'matrix-source.json'), {
      caseId: 'read-file',
      caseVersion: 1,
      cells: [terra, oldSol],
    });
    const report = await summarizeSavedRun(root);
    assert.equal(report.counts.selected, 2);
    assert.equal(report.counts.attemptedUnknown, 2);
    assert.equal(report.counts.missingResult, 2);
    assert.deepEqual(
      report.attempts.map((row) => row.role),
      ['required', 'reference'],
    );
    assert.equal(report.recordedGate.selectedStatus, 'unknown');
    assert.equal(report.models[0].requests.value, null);
  });
});

test('single repeats and allowlisted early-failure declarations preserve denominators without fabricating usage', async () => {
  await workspace(async (root) => {
    const declaration = { profile: 'drive', model: sol.model, repeats: '2' };
    const early = await summarizeSavedRun(root, declaration);
    assert.equal(early.counts.selected, 2);
    assert.equal(early.counts.unattempted, 2);
    assert.equal(early.counts.pass, 0);
    assert.equal(early.recordedGate.selectedStatus, 'unknown');
    assert.equal(early.attempts[0].tokens.inputTokens, null);
    const emptyInputs = await summarizeSavedRun(root, {
      profile: 'drive',
      cases: '',
      caseId: '',
      selection: 'required',
      model: '',
    });
    assert.equal(emptyInputs.counts.selected, 2);
    assert.equal(emptyInputs.counts.unattempted, 2);
    for (const invalid of [
      { cases: 'read-file,not-a-case', selection: 'required' },
      { selection: 'sonnet,not-a-model' },
      { selection: 'sonnet,sonnet' },
      { cases: 'read-search', selection: 'required' },
    ]) {
      const rejected = await summarizeSavedRun(root, { profile: 'drive', ...invalid });
      assert.equal(rejected.counts.selected, null);
      assert.ok(rejected.issues.includes('invalid_fallback_declaration'));
    }
    await savedCell(root, false);
    const source = JSON.parse(await readFile(join(root, 'source.json'), 'utf8'));
    await json(join(root, 'source.json'), { ...source, repeats: 2 });
    await json(join(root, 'attempts.json'), { requested: 2, attempted: 1, unattempted: 1 });
    const single = await summarizeSavedRun(root);
    assert.equal(single.counts.selected, 2);
    assert.equal(single.counts.attempted, 1);
    assert.equal(single.counts.unattempted, 1);
    assert.equal(single.recordedGate.selectedStatus, 'unknown');
    assert.equal(
      (await summarizeSavedRun(join(root, 'absent'), { profile: secret, selection: secret })).counts
        .selected,
      null,
    );
  });
});

test('synthetic marker and step summary identify fixture results explicitly', async () => {
  await workspace(async (root) => {
    await savedCell(root);
    await json(join(root, 'report-preflight.json'), {
      synthetic: true,
      inference: false,
      google: false,
    });
    const step = join(root, '..', `${root.split('/').at(-1)}-step-summary`);
    try {
      await writeFile(step, 'Prior step\n');
      const report = await writeRetainedReport(root, join(root, 'workflow-report'), {
        stepSummary: step,
      });
      assert.equal(report.synthetic, true);
      const markdown = await readFile(step, 'utf8');
      assert.match(markdown, /^Prior step\n/);
      assert.match(markdown, /Synthetic reporting preflight/);
      assert.match(markdown, /not real actor results/);
    } finally {
      await rm(step, { force: true });
    }
  });
});
