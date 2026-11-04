import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCells, aggregateMatrix, MATRIX_VERSION, type MatrixCellResult } from './matrix.ts';
import { runCell } from './run.ts';
import { verifyModels } from './catalog.ts';

const json = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function runCampaign(dependencies = { runCell, verifyModels }) {
  if (!process.env.EVAL_SELECTION) {
    const result = await dependencies.runCell();
    return result.passed;
  }
  const cells = selectCells(process.env.EVAL_SELECTION);
  if (process.env.EVAL_MODEL) throw new Error('Select a matrix or one model, not both');
  if (process.env.EVAL_PROFILE !== 'gmail') throw new Error('Only Gmail has implemented coverage');
  if ((process.env.EVAL_REPEATS ?? '1') !== '1')
    throw new Error('Matrix uses one declared attempt per cell');
  const output = resolve(process.env.EVAL_OUTPUT!);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const catalogue = await dependencies.verifyModels(
    process.env.EVAL_PROXY_URL!,
    process.env.CPA_CLIENT_API_KEY!,
    cells.map((cell) => cell.model),
  );
  await json(join(output, 'matrix-source.json'), {
    matrixVersion: MATRIX_VERSION,
    cells,
    profile: 'gmail',
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
        profile: 'gmail',
        model: cell.model,
        output: join(output, cell.id),
        repeats: 1,
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
    '# Gmail agent model matrix',
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
    'Only Gmail coverage exists. Drive, Sheets, Docs and Calendar remain pending.',
    '',
  ].join('\n');
  await writeFile(join(output, 'report.md'), report, { mode: 0o600 });
  console.log(
    `Gmail matrix required-pair ${result.gatedStatus}; report ${join(output, 'report.md')}`,
  );
  return result.selectedStatus === 'pass';
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
