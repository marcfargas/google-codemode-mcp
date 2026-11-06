import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCells, aggregateMatrix, MATRIX_VERSION, type MatrixCellResult } from './matrix.ts';
import { runCell } from './run.ts';
import { verifyModels } from './catalog.ts';
import { getCase, selectCases } from './cases.ts';
import { GRADING_VERSION } from './mechanisms.ts';

const json = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

async function runMatrix(
  dependencies: { runCell: typeof runCell; verifyModels: typeof verifyModels },
  configuration?: { output: string; caseId: string },
) {
  if (!process.env.EVAL_SELECTION) {
    const result = await dependencies.runCell();
    return {
      selectedStatus: result.passed ? 'pass' : 'fail',
      safetyFailures: [],
      safetyUnknown: [],
    };
  }
  const cells = selectCells(process.env.EVAL_SELECTION);
  if (process.env.EVAL_MODEL) throw new Error('Select a matrix or one model, not both');
  const profile = process.env.EVAL_PROFILE;
  if (!['gmail', 'drive', 'media', 'artifacts'].includes(profile!))
    throw new Error('Selected service has no implemented coverage');
  if ((process.env.EVAL_REPEATS ?? '1') !== '1')
    throw new Error('Matrix uses one declared attempt per cell');
  const output = resolve(configuration?.output ?? process.env.EVAL_OUTPUT!);
  const selectedCase = getCase(profile!, configuration?.caseId ?? process.env.EVAL_CASE);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const catalogue = await dependencies.verifyModels(
    process.env.EVAL_PROXY_URL!,
    process.env.CPA_CLIENT_API_KEY!,
    cells.map((cell) => cell.model),
  );
  await json(join(output, 'matrix-source.json'), {
    matrixVersion: MATRIX_VERSION,
    gradingVersion: GRADING_VERSION,
    caseId: selectedCase.id,
    caseVersion: selectedCase.version,
    cells,
    profile: profile!,
    catalogue,
    attemptsPerCell: 1,
    estimatedUsdCeilingPerCell: 1,
    estimatedUsdCeilingTotal: cells.length,
    providerBilledCostUsd: null,
    createdAt: new Date().toISOString(),
    hostQualification: false,
  });
  const results: MatrixCellResult[] = [];
  let stopReason: string | null = null;
  for (const cell of cells) {
    try {
      const result = await dependencies.runCell({
        profile: profile!,
        model: cell.model,
        output: join(output, cell.id),
        repeats: 1,
        caseId: selectedCase.id,
      });
      results.push({ ...result.results[0], cellId: cell.id });
    } catch {
      results.push({
        cellId: cell.id,
        status: 'error',
        error: 'Cell infrastructure failed; inspect retained evidence',
        infrastructureAbort: true,
      });
    }
    const aggregation = aggregateMatrix(cells, results);
    await json(join(output, 'matrix-results.json'), { ...aggregation, results });
    const last = aggregation.rows.find((row) => row.id === cell.id)!;
    if (last.safetyStatus !== 'pass') {
      stopReason = `Stopped after ${cell.id}: ${last.safetyEvidence.join('; ')}`;
      break;
    }
  }
  const result = { ...aggregateMatrix(cells, results), results, stopReason };
  await json(join(output, 'matrix-results.json'), result);
  const report = [
    `# ${profile} agent model matrix`,
    '',
    `Required-pair gate: ${result.gatedStatus.toUpperCase()}. Selected run: ${result.selectedStatus.toUpperCase()}.`,
    '',
    '| Cell | Model | Runner | Role | Task | Full cell gate | Safety |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...result.rows.map(
      (row) =>
        `| ${row.id} | ${row.model} | ${row.runner} | ${row.role} | ${row.taskSuccess === null ? 'unknown' : row.taskSuccess ? 'pass' : 'fail'} | ${row.status} | ${row.safetyStatus} |`,
    ),
    '',
    stopReason ?? 'Each selected cell was attempted once, with fresh fixtures and sessions.',
    '',
    'Required cells must each pass the complete gate. Probe/reference score failures do not substitute for required results. Unknown mutations, missing cleanup evidence and infrastructure failures stop later cells.',
    '',
    'Reports and raw usage: CELL/trial-1/result.json, actor-result.json and model-receipts.jsonl. Estimates are not proxy billing. Cache reads are provider-reported observations. Different runners do not isolate model-only effects or qualify Claude/ChatGPT/OpenClaw hosts.',
    '',
    'Gmail, Drive and their media-composition profiles exist. Sheets, Docs and Calendar remain pending.',
    '',
  ].join('\n');
  await writeFile(join(output, 'report.md'), report, { mode: 0o600 });
  console.log(
    `${profile} matrix required-pair ${result.gatedStatus}; report ${join(output, 'report.md')}`,
  );
  return result;
}

/** One fresh case/model attempt each; score failures do not trigger retries. */
export async function runCampaign(dependencies = { runCell, verifyModels }) {
  if (!process.env.EVAL_CASES) return (await runMatrix(dependencies)).selectedStatus === 'pass';
  if (!process.env.EVAL_SELECTION || process.env.EVAL_MODEL)
    throw new Error('A case suite requires an explicit model selection');
  const cases = selectCases(process.env.EVAL_PROFILE!, process.env.EVAL_CASES);
  const cells = selectCells(process.env.EVAL_SELECTION);
  const output = resolve(process.env.EVAL_OUTPUT!);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const source = {
    suiteVersion: 1,
    gradingVersion: GRADING_VERSION,
    cases,
    cells,
    attemptsPerCaseModel: 1,
    estimatedUsdCeilingTotal: cases.length * cells.length,
    providerBilledCostUsd: null,
  };
  await json(join(output, 'suite-source.json'), source);
  const results: {
    caseId: string;
    selectedStatus: string;
    gatedStatus?: string;
    safetyFailures: string[];
    safetyUnknown: string[];
  }[] = [];
  let stopReason: string | null = null;
  for (const selectedCase of cases) {
    try {
      const result = await runMatrix(dependencies, {
        output: join(output, selectedCase.id),
        caseId: selectedCase.id,
      });
      results.push({ caseId: selectedCase.id, ...result });
      if (result.safetyFailures.length || result.safetyUnknown.length) {
        stopReason = `Safety or infrastructure evidence incomplete after ${selectedCase.id}`;
        break;
      }
    } catch {
      results.push({
        caseId: selectedCase.id,
        selectedStatus: 'error',
        safetyFailures: ['infrastructure'],
        safetyUnknown: [],
      });
      stopReason = `Case infrastructure failed at ${selectedCase.id}; inspect retained evidence`;
      break;
    } finally {
      await json(join(output, 'suite-results.json'), {
        ...source,
        results,
        stopReason,
        unattempted: cases
          .filter((item) => !results.some((row) => row.caseId === item.id))
          .map((item) => item.id),
      });
    }
  }
  const passed =
    results.length === cases.length && results.every((row) => row.selectedStatus === 'pass');
  const requiredPairStatus =
    results.length === cases.length && results.every((row) => row.gatedStatus === 'pass')
      ? 'pass'
      : results.some((row) => row.gatedStatus === 'fail')
        ? 'fail'
        : 'pending';
  await json(join(output, 'suite-results.json'), {
    ...source,
    results,
    stopReason,
    selectedStatus: passed ? 'pass' : 'fail',
    requiredPairStatus,
    unattempted: cases
      .filter((item) => !results.some((row) => row.caseId === item.id))
      .map((item) => item.id),
  });
  await writeFile(
    join(output, 'report.md'),
    [
      `# ${process.env.EVAL_PROFILE} independent case suite`,
      '',
      `Selected suite: ${passed ? 'PASS' : 'FAIL'}. One fresh attempt per case/model; grading version ${GRADING_VERSION}.`,
      '',
      `Required-pair gate across all selected cases: ${requiredPairStatus.toUpperCase()}.`,
      '',
      '| Case | Selected gate |',
      '| --- | --- |',
      ...cases.map(
        (item) =>
          `| ${item.id} | ${results.find((row) => row.caseId === item.id)?.selectedStatus ?? 'unattempted'} |`,
      ),
      '',
      stopReason ?? 'All selected case/model attempts completed.',
      '',
      `Maximum estimate: $${source.estimatedUsdCeilingTotal}; provider billing remains unknown. Per-attempt caps and safety stops are unchanged.`,
      '',
      "Per-case matrix reports retain required-pair qualification, model identity, cache usage, task/mechanism criteria and cleanup. Historical failures remain unchanged. Each cell's source.json records the tested backend and candidate identity; results do not qualify other deployments or target hosts.",
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return passed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCampaign()
    .then((passed) => {
      if (!passed) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Agent matrix infrastructure failed; inspect retained private evidence');
      process.exitCode = 1;
    });
}
