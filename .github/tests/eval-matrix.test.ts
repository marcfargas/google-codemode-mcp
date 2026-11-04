import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMatrix,
  getCellByModel,
  MATRIX,
  selectCells,
  type MatrixCellResult,
} from '../eval/matrix.ts';

const result = (cellId: string, status: MatrixCellResult['status'] = 'pass'): MatrixCellResult => ({
  cellId,
  status,
  taskSuccess: status === 'pass',
  hasUnknownMutation: false,
  cleanup: { failures: [], unknownMutations: [] },
});

test('matrix selects exact declared models in a stable order without fallbacks', () => {
  assert.deepEqual(
    selectCells().map((cell) => cell.id),
    ['sonnet', 'terra'],
  );
  assert.deepEqual(
    selectCells('terra,sonnet,sol').map((cell) => cell.id),
    ['sonnet', 'terra', 'sol'],
  );
  assert.equal(selectCells('all').length, 6);
  assert.equal(getCellByModel('gpt-6.1-terra').runner, 'responses');
  assert.equal(getCellByModel('claude-haiku-5-5').role, 'probe');
  assert.ok(MATRIX.every((cell) => cell.attempts === 1));
  for (const selection of ['', 'sonnet,', ',terra', 'sonnet,sonnet', 'fallback', 'required,sol'])
    assert.throws(() => selectCells(selection));
  assert.throws(() => getCellByModel('gpt-6.1-terra-latest'), /not in/);
});

test('required full-gate passes qualify despite optional model score failures', () => {
  const summary = aggregateMatrix(
    selectCells('all'),
    MATRIX.map((cell) => result(cell.id, cell.role === 'required' ? 'pass' : 'fail')),
  );
  assert.equal(summary.gatedStatus, 'pass');
  assert.equal(summary.passed, true);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.safetyFailures, []);
  assert.equal(summary.rows.find((row) => row.id === 'haiku')?.status, 'fail');
});

test('task success or reference success cannot substitute for a required full-gate failure', () => {
  const terra = { ...result('terra', 'fail'), taskSuccess: true };
  const summary = aggregateMatrix(selectCells('sonnet,terra,sol'), [
    result('sonnet'),
    terra,
    result('sol'),
  ]);
  assert.equal(summary.gatedStatus, 'fail');
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.requiredFailures, ['terra']);
  assert.equal(summary.rows.find((row) => row.id === 'terra')?.taskSuccess, true);
});

test('partial selections cannot qualify the missing required model', () => {
  const summary = aggregateMatrix(selectCells('sonnet'), [result('sonnet')]);
  assert.equal(summary.complete, true);
  assert.equal(summary.selectedStatus, 'pass');
  assert.equal(summary.gatedStatus, 'pending');
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.missingRequired, ['terra']);
});

test('unattempted selected cells stay explicit even when required models passed', () => {
  const summary = aggregateMatrix(selectCells('all'), [result('sonnet'), result('terra')]);
  assert.equal(summary.complete, false);
  assert.equal(summary.gatedStatus, 'pending');
  assert.deepEqual(summary.unattempted, ['haiku', 'luna', 'opus', 'sol']);
  assert.equal(summary.rows.find((row) => row.id === 'luna')?.status, 'unattempted');
});

test('optional cells cannot hide unknown mutations, cleanup failures or infrastructure errors', () => {
  for (const patch of [
    { hasUnknownMutation: true },
    { cleanup: { failures: ['label'], unknownMutations: [] } },
    { cleanup: { failures: [], unknownMutations: ['send'] } },
    { cleanupError: true },
    { relayCloseError: true },
    { infrastructureAbort: true },
    { status: 'error' as const },
  ]) {
    const summary = aggregateMatrix(selectCells('sonnet,terra,haiku'), [
      result('sonnet'),
      result('terra'),
      { ...result('haiku', 'fail'), ...patch },
    ]);
    assert.equal(summary.gatedStatus, 'fail');
    assert.deepEqual(summary.safetyFailures, ['haiku']);
  }
  const unknown = aggregateMatrix(selectCells('required'), [
    { ...result('sonnet'), hasUnknownMutation: undefined },
    result('terra'),
  ]);
  assert.equal(unknown.gatedStatus, 'pending');
  assert.deepEqual(unknown.safetyUnknown, ['sonnet']);
});

test('aggregation refuses duplicate, unselected and altered manifest evidence', () => {
  assert.throws(
    () => aggregateMatrix(selectCells('required'), [result('sonnet'), result('sonnet')]),
    /Duplicate result/,
  );
  assert.throws(() => aggregateMatrix(selectCells('required'), [result('haiku')]), /unselected/);
  assert.throws(() => aggregateMatrix([], []), /At least one/);
  assert.throws(
    () => aggregateMatrix([{ ...selectCells('sonnet')[0], role: 'reference' }], [result('sonnet')]),
    /differs/,
  );
  assert.throws(
    () => aggregateMatrix(selectCells('required'), [{ ...result('sonnet'), taskSuccess: false }]),
    /lacks task-success/,
  );
  assert.throws(
    () =>
      aggregateMatrix(selectCells('required'), [
        { ...result('sonnet'), status: 'invalid' } as never,
      ]),
    /Invalid result/,
  );
  const malformedCleanup = aggregateMatrix(selectCells('required'), [
    { ...result('sonnet'), cleanup: {} as never },
    result('terra'),
  ]);
  assert.equal(malformedCleanup.gatedStatus, 'pending');
});
