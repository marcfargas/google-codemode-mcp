export type Runner = 'claude' | 'responses';
export type CellRole = 'required' | 'probe' | 'reference';
export interface MatrixCell {
  readonly id: string;
  readonly model: string;
  readonly runner: Runner;
  readonly role: CellRole;
  readonly attempts: 1;
}

export const MATRIX_VERSION = 1;
export const MATRIX: readonly MatrixCell[] = Object.freeze(
  [
    { id: 'sonnet', model: 'claude-sonnet-5-5', runner: 'claude', role: 'required', attempts: 1 },
    { id: 'terra', model: 'gpt-6.1-terra', runner: 'responses', role: 'required', attempts: 1 },
    { id: 'haiku', model: 'claude-haiku-5-5', runner: 'claude', role: 'probe', attempts: 1 },
    { id: 'luna', model: 'gpt-6-luna', runner: 'responses', role: 'probe', attempts: 1 },
    { id: 'opus', model: 'claude-opus-5-5', runner: 'claude', role: 'reference', attempts: 1 },
    { id: 'sol', model: 'gpt-6.1-sol', runner: 'responses', role: 'reference', attempts: 1 },
  ].map((cell) => Object.freeze(cell)) as MatrixCell[],
);

/** Selection never silently substitutes a model or changes the declared run order. */
export function selectCells(selection = 'required'): MatrixCell[] {
  if (selection === 'required') return MATRIX.filter((cell) => cell.role === 'required');
  if (selection === 'all') return [...MATRIX];
  const ids = selection.split(',').map((id) => id.trim());
  if (ids.some((id) => !id)) throw new Error('Select required, all, or nonempty cell IDs');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate matrix cell selection');
  for (const id of ids)
    if (!MATRIX.some((cell) => cell.id === id)) throw new Error(`Unknown matrix cell: ${id}`);
  return MATRIX.filter((cell) => ids.includes(cell.id));
}

export function getCellByModel(model: string): MatrixCell {
  const cell = MATRIX.find((entry) => entry.model === model);
  if (!cell) throw new Error(`Model is not in the evaluation matrix: ${model}`);
  return cell;
}

export interface MatrixCellResult {
  cellId: string;
  status: 'pass' | 'fail' | 'error';
  taskSuccess?: boolean;
  hasUnknownMutation?: boolean;
  cleanup?: { failures: unknown[]; unknownMutations: unknown[] };
  error?: string;
  relayCloseError?: boolean;
  cleanupError?: boolean;
  infrastructureAbort?: boolean;
}

type Verdict = 'pass' | 'fail' | 'pending';
type SafetyStatus = 'pass' | 'fail' | 'unknown';

function safety(result: MatrixCellResult): { status: SafetyStatus; evidence: string[] } {
  const evidence: string[] = [];
  const cleanupKnown =
    result.cleanup &&
    Array.isArray(result.cleanup.failures) &&
    Array.isArray(result.cleanup.unknownMutations);
  if (result.hasUnknownMutation === true) evidence.push('Unknown mutation outcome');
  if (cleanupKnown && result.cleanup!.failures.length) evidence.push('Fixture cleanup failed');
  if (cleanupKnown && result.cleanup!.unknownMutations.length)
    evidence.push('Fixture cleanup has unknown mutations');
  if (result.cleanupError) evidence.push('Fixture cleanup could not complete');
  if (result.relayCloseError) evidence.push('Runner relay shutdown failed');
  if (result.infrastructureAbort || result.status === 'error' || result.error)
    evidence.push('Execution infrastructure failed or aborted');
  if (evidence.length) return { status: 'fail', evidence };
  if (result.hasUnknownMutation !== false || !cleanupKnown)
    return { status: 'unknown', evidence: ['Mutation certainty or cleanup evidence missing'] };
  return { status: 'pass', evidence: [] };
}

/**
 * Grade cells independently. Optional model score failures are informational;
 * uncertainty, cleanup failure and infrastructure errors always fail the run.
 * `passed` qualifies the complete required pair, never a selected subset.
 */
export function aggregateMatrix(selected: MatrixCell[], results: MatrixCellResult[]) {
  if (!selected.length) throw new Error('At least one matrix cell must be selected');
  const ids = selected.map((cell) => cell.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate matrix cell selection');
  for (const cell of selected) {
    const declared = MATRIX.find((entry) => entry.id === cell.id);
    if (
      !declared ||
      cell.model !== declared.model ||
      cell.runner !== declared.runner ||
      cell.role !== declared.role ||
      cell.attempts !== declared.attempts
    )
      throw new Error(`Matrix cell differs from declared manifest: ${cell.id}`);
  }
  const byCell = new Map<string, MatrixCellResult>();
  for (const result of results) {
    if (!ids.includes(result.cellId))
      throw new Error(`Result for unselected cell: ${result.cellId}`);
    if (byCell.has(result.cellId)) throw new Error(`Duplicate result for cell: ${result.cellId}`);
    if (!['pass', 'fail', 'error'].includes(result.status))
      throw new Error(`Invalid result status for cell: ${result.cellId}`);
    if (result.status === 'pass' && result.taskSuccess !== true)
      throw new Error(`Full-gate pass lacks task-success evidence for cell: ${result.cellId}`);
    byCell.set(result.cellId, result);
  }
  const rows = MATRIX.filter((cell) => ids.includes(cell.id)).map((cell) => {
    const result = byCell.get(cell.id);
    const checked = result ? safety(result) : null;
    return {
      ...cell,
      status: result?.status ?? 'unattempted',
      taskSuccess: result?.taskSuccess ?? null,
      safetyStatus: checked?.status ?? 'unknown',
      safetyEvidence: checked?.evidence ?? ['Cell was not attempted'],
    };
  });
  const complete = rows.every((row) => row.status !== 'unattempted');
  const safetyFailures = rows.filter((row) => row.safetyStatus === 'fail').map((row) => row.id);
  const safetyUnknown = rows.filter((row) => row.safetyStatus === 'unknown').map((row) => row.id);
  const requiredFailures = rows
    .filter((row) => row.role === 'required' && ['fail', 'error'].includes(row.status))
    .map((row) => row.id);
  const missingRequired = MATRIX.filter(
    (cell) => cell.role === 'required' && !byCell.has(cell.id),
  ).map((cell) => cell.id);
  const failed = safetyFailures.length > 0 || requiredFailures.length > 0;
  const selectedStatus: Verdict = failed
    ? 'fail'
    : !complete || safetyUnknown.length > 0
      ? 'pending'
      : 'pass';
  const gatedStatus: Verdict = failed
    ? 'fail'
    : missingRequired.length > 0 || selectedStatus === 'pending'
      ? 'pending'
      : 'pass';
  return {
    matrixVersion: MATRIX_VERSION,
    rows,
    complete,
    selectedStatus,
    gatedStatus,
    passed: gatedStatus === 'pass',
    missingRequired,
    requiredFailures,
    safetyFailures,
    safetyUnknown,
    attempted: results.length,
    unattempted: rows.filter((row) => row.status === 'unattempted').map((row) => row.id),
  };
}
