import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareReportPreflight } from '../eval/report-preflight.ts';

test('workflow report CLI preserves failed producer gates and appends synthetic summary without inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-report-workflow-'));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Report preflight must never call a network service');
  };
  try {
    const saved = join(root, 'saved');
    await prepareReportPreflight(saved);
    const resultPath = join(saved, 'suite-results.json');
    const originalGate = await readFile(resultPath, 'utf8');
    const stepSummary = join(root, 'step-summary.md');
    await writeFile(stepSummary, 'Existing workflow summary\n');
    const output = join(saved, 'workflow-report');
    const child = spawnSync(
      process.execPath,
      ['apps/executor/tests/eval/report.ts', saved, output, '--step-summary'],
      {
        env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: stepSummary },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(resultPath, 'utf8'), originalGate);
    const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
    assert.equal(summary.synthetic, true);
    assert.equal(summary.recordedGate.requiredPairStatus, 'fail');
    assert.equal(summary.counts.pass, 1);
    assert.equal(summary.counts.fail, 1);
    assert.deepEqual(summary.attempts[0].failedCriteria, ['drive_version_preserved']);
    const markdown = await readFile(join(output, 'summary.md'), 'utf8');
    assert.match(markdown, /Synthetic/);
    assert.equal(await readFile(stepSummary, 'utf8'), 'Existing workflow summary\n' + markdown);

    const workflow = await readFile('.github/workflows/evaluate.yml', 'utf8');
    assert.match(workflow, /Summarize retained[\s\S]*?if: always\(\) && env.ACT == 'true'/);
    assert.ok(
      workflow.indexOf('apps/executor/tests/eval/campaign.ts') <
        workflow.indexOf('apps/executor/tests/eval/report.ts'),
    );
    assert.ok(
      workflow.indexOf('apps/executor/tests/eval/report.ts') <
        workflow.indexOf('Return local evidence ownership'),
    );
  } finally {
    globalThis.fetch = fetchBefore;
    await rm(root, { recursive: true, force: true });
  }
});

test('report CLI retains optional native Codex identity when execution stops before source evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-report-native-'));
  try {
    const saved = join(root, 'saved');
    await mkdir(saved);
    const output = join(root, 'report');
    const child = spawnSync(
      process.execPath,
      ['apps/executor/tests/eval/report.ts', saved, output],
      {
        env: {
          PATH: process.env.PATH,
          EVAL_PROFILE: 'gmail',
          EVAL_MODEL: 'gpt-6.1-sol',
          EVAL_RUNNER: 'codex',
          EVAL_REPEATS: '1',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
    assert.equal(report.counts.selected, 1);
    assert.equal(report.counts.unattempted, 1);
    const row = report.attempts[0];
    assert.equal(row.caseId, 'read-search');
    assert.equal(row.cellId, 'sol-native-codex');
    assert.equal(row.model, 'gpt-6.1-sol');
    assert.equal(row.runner, 'codex');
    assert.equal(row.role, 'probe');
    assert.equal(report.recordedGate.requiredPairStatus, 'unknown');
    assert.equal(row.requests.count, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
