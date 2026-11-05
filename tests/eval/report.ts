import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MATRIX, getCellByModel, selectCells } from './matrix.ts';
import { GMAIL_CASES, getCase, selectCases } from './cases.ts';
import { DRIVE_CASES } from './drive.ts';
import { MEDIA_CASES } from './media.ts';

export interface ReportDeclaration {
  profile?: string;
  cases?: string;
  caseId?: string;
  selection?: string;
  model?: string;
  repeats?: string;
  runner?: string;
}
type ObjectValue = Record<string, any>;
type Gate = 'pass' | 'fail' | 'pending' | 'unknown';
type Status = 'pass' | 'fail' | 'error' | 'unattempted' | 'missing_result';
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null =>
  number(value) !== null && Number.isSafeInteger(value) ? (value as number) : null;
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T | null =>
  choices.includes(value as T) ? (value as T) : null;
const gate = (value: unknown): Gate => oneOf(value, ['pass', 'fail', 'pending']) ?? 'unknown';
const digest = (value: unknown, length = 64): string | null =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null;
const version = (value: unknown): string | null =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
const caseIds = [
  'combined',
  ...GMAIL_CASES.map((item) => item.id),
  ...DRIVE_CASES.map((item) => item.id),
  ...MEDIA_CASES.map((item) => item.id),
];
const models = MATRIX.map((cell) => cell.model);
const cellIds = [...MATRIX.map((cell) => cell.id), 'sol-native-codex'];
const criteria = new Set([
  'attachment_file',
  'only_requested_file',
  'original_label',
  'one_reply',
  'reply_thread',
  'reply_headers',
  'reply_body',
  'no_extra_effects',
  'read_answer',
  'search_and_read',
  'safe_failure_answer',
  'observed_not_found',
  'complete_page_answer',
  'actual_pagination',
  'drive_readback',
  'drive_metadata',
  'drive_write_target',
  'drive_content_preserved',
  'drive_file',
  'drive_files_only',
  'drive_no_mutations',
  'drive_page_answer',
  'drive_pagination_chain',
  'drive_page_ids',
  'drive_pagination_preserved',
  'drive_conditional_answer',
  'drive_conditional_read',
  'drive_version_preserved',
  'drive_outbound_reads_only',
  'required_method_discovery',
  'root_discovery',
  'method_discovery',
  'skill_resource',
  'send_ledger',
  'actor_mutation_surface',
  'model_identity',
  'mutation_certainty',
  'native_execution',
  'required_resource',
  'media_mutation_ledger',
  'media_created_identity',
  'media_source_read',
  'media_files_only',
  'media_readback',
  'media_source_preserved',
  'media_transfer',
  'media_answer',
]);
interface Artifact {
  state: 'present' | 'missing' | 'malformed';
  value: any;
  sha256?: string;
}
async function artifact(directory: string, name: string, lines = false): Promise<Artifact> {
  try {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile()) return { state: 'malformed', value: null };
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    return {
      state: 'present',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      value: lines
        ? text
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        : JSON.parse(text),
    };
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'malformed',
      value: null,
    };
  }
}
export interface CoverageMetric {
  value: number | null;
  observedSubtotal: number | null;
  covered: number;
  expected: number;
}
function coverage(values: (number | null)[]): CoverageMetric {
  const observed = values.filter((value): value is number => value !== null);
  const subtotal = observed.length ? observed.reduce((sum, value) => sum + value, 0) : null;
  return {
    value: observed.length === values.length ? subtotal : null,
    observedSubtotal: subtotal,
    covered: observed.length,
    expected: values.length,
  };
}
const tokenFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
] as const;
type TokenField = (typeof tokenFields)[number];
interface AttemptPlan {
  directory: string;
  caseId: string | null;
  caseVersion: number | null;
  cellId: string | null;
  model: string | null;
  runner: string | null;
  role: string | null;
  repetition: number;
  fallback: ObjectValue;
  unattempted: boolean;
}
export interface AttemptReport {
  caseId: string | null;
  caseVersion: number | null;
  cellId: string | null;
  model: string | null;
  runner: string | null;
  role: string | null;
  repetition: number;
  status: Status;
  attempted: boolean | null;
  resultEvidence: Artifact['state'];
  taskSuccess: boolean | null;
  criteria: { id: string; status: string }[];
  omittedCriteria: number;
  failedCriteria: string[];
  unknownCriteria: string[];
  cleanup: { failures: number | null; unknownMutations: number | null };
  unknownEffects: boolean | null;
  identity: {
    sourceReceiptSha256: string | null;
    revision: string | null;
    backend: string | null;
    bundleDigest: string | null;
    workerVersion: string | null;
    runnerVersion: string | null;
    accountingVersion: number | null;
    gradingVersion: number | null;
  };
  limits: { wallMs: number | null; modelRequests: number | null; retries: number | null };
  durationMs: number | null;
  tokens: Record<TokenField, number | null>;
  tokenBasis:
    'claude_separate_cache' | 'responses_cache_included' | 'codex_cache_included' | 'unknown';
  tokenSource: string;
  uncachedInputTokens: number | null;
  cacheReadFraction: number | null;
  requests: {
    count: number | null;
    complete: number | null;
    identityMatches: number | null;
    systemPrefixStable: boolean | null;
    toolsPrefixStable: boolean | null;
  };
  costs: {
    nativeCliEstimateUsd: number | null;
    publishedRateEstimateUsd: CoverageMetric;
    committedEstimateUsd: number | null;
    providerBilledCostUsd: number | null;
  };
  versionEvidence: {
    baseline: string | null;
    final: string | null;
    readinessObservations: number | null;
    readinessVersion: string | null;
    readiness: { version: string | null; status: string | null; elapsedMs: number | null }[];
  };
  issues: string[];
}
export interface RunReport {
  reportVersion: 1;
  synthetic: boolean;
  mode: 'suite' | 'matrix' | 'single' | 'declaration' | 'unknown';
  recordedGate: { selectedStatus: Gate; requiredPairStatus: Gate };
  counts: {
    selected: number | null;
    attempted: number;
    attemptedUnknown: number;
    pass: number;
    fail: number;
    error: number;
    unattempted: number;
    missingResult: number;
  };
  attempts: AttemptReport[];
  models: {
    model: string | null;
    runner: string | null;
    tokenBasis: AttemptReport['tokenBasis'];
    attempts: number;
    tokens: Record<TokenField, CoverageMetric>;
    requests: CoverageMetric;
    costs: {
      nativeCliEstimateUsd: CoverageMetric;
      publishedRateEstimateUsd: CoverageMetric;
      committedEstimateUsd: CoverageMetric;
      providerBilledCostUsd: CoverageMetric;
    };
  }[];
  issues: string[];
}
function cell(value: unknown) {
  const item = object(value);
  const declared = MATRIX.find((entry) => entry.id === item.id);
  const nativeProbe =
    item.id === 'sol-native-codex' &&
    item.model === 'gpt-6.1-sol' &&
    item.runner === 'codex' &&
    item.role === 'probe';
  return {
    cellId: oneOf(item.id, cellIds),
    model: oneOf(item.model, models),
    runner: oneOf(item.runner, ['claude', 'responses', 'codex']),
    role: oneOf(item.role, ['required', 'probe', 'reference']),
    valid:
      nativeProbe ||
      (!!declared &&
        item.model === declared.model &&
        item.runner === declared.runner &&
        oneOf(item.role, ['required', 'probe', 'reference']) !== null),
  };
}
function declarationSource(declaration: ReportDeclaration) {
  try {
    const profile = oneOf(declaration.profile, ['gmail', 'drive', 'media']);
    const nativeProbe = declaration.runner === 'codex';
    if (
      !profile ||
      (declaration.runner && !nativeProbe) ||
      (declaration.selection && declaration.model) ||
      (declaration.cases && !declaration.selection) ||
      !['1', '2'].includes(declaration.repeats || '1') ||
      (declaration.selection && declaration.repeats === '2')
    )
      throw new Error('Invalid declaration');
    if (
      nativeProbe &&
      (profile !== 'gmail' ||
        declaration.model !== 'gpt-6.1-sol' ||
        (declaration.caseId || 'read-search') !== 'read-search' ||
        declaration.repeats === '2' ||
        declaration.selection ||
        declaration.cases)
    )
      throw new Error('Invalid native probe');
    const cases = declaration.cases
      ? selectCases(profile, declaration.cases)
      : [getCase(profile, declaration.caseId || (nativeProbe ? 'read-search' : undefined))];
    const cells = nativeProbe
      ? [{ id: 'sol-native-codex', model: 'gpt-6.1-sol', runner: 'codex', role: 'probe' }]
      : declaration.selection
        ? selectCells(declaration.selection)
        : [getCellByModel(declaration.model ?? '')];
    return { valid: true, cases: cases.map(({ id }) => ({ id, version: null })), cells };
  } catch {
    return { valid: false, cases: [], cells: [] };
  }
}

async function attempt(plan: AttemptPlan): Promise<AttemptReport> {
  const trial = join(plan.directory, `trial-${plan.repetition}`);
  const [
    sourceFile,
    resultFile,
    actorFile,
    receiptFile,
    fixtureFile,
    expectedFile,
    observationFile,
  ] = await Promise.all([
    artifact(plan.directory, 'source.json'),
    artifact(trial, 'result.json'),
    artifact(trial, 'actor-result.json'),
    artifact(trial, 'model-receipts.jsonl', true),
    artifact(trial, 'fixture-manifest.json'),
    artifact(trial, 'expected.json'),
    artifact(trial, 'observation.json'),
  ]);
  const source = object(sourceFile.value);
  const result = resultFile.state === 'present' ? object(resultFile.value) : plan.fallback;
  const usage = object(result.usage ?? object(actorFile.value).usage);
  const totals = object(usage.totals);
  const runner = oneOf(source.runner, ['claude', 'responses', 'codex']) ?? plan.runner;
  const model = oneOf(source.requestedModel, models) ?? plan.model;
  const receiptData =
    receiptFile.state === 'missing' && Array.isArray(result.llmReceipts)
      ? result.llmReceipts
      : receiptFile.value;
  const receipts =
    Array.isArray(receiptData) &&
    receiptData.every((value) => value && typeof value === 'object' && !Array.isArray(value))
      ? receiptData
      : null;
  const requestIds = receipts?.map((receipt) => count(receipt.request));
  const duplicateRequests = !!requestIds && requestIds.some((id, index) => id !== index + 1);
  const validReceipts = duplicateRequests ? null : receipts;
  const tokenSource =
    oneOf(usage.totalsSource, [
      'terminal_native_result',
      'terminal_responses_usage',
      'terminal_native_codex_turn',
    ]) ?? 'unknown';
  const tokens = Object.fromEntries(
    tokenFields.map((field) => [field, tokenSource === 'unknown' ? null : count(totals[field])]),
  ) as AttemptReport['tokens'];
  const basis =
    runner === 'claude'
      ? 'claude_separate_cache'
      : runner === 'responses'
        ? 'responses_cache_included'
        : runner === 'codex'
          ? 'codex_cache_included'
          : 'unknown';
  const {
    inputTokens: input,
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: created,
  } = tokens;
  const denominator =
    basis === 'claude_separate_cache'
      ? input !== null && cached !== null && created !== null
        ? input + cached + created
        : null
      : input;
  const prefixStable = (key: string) =>
    validReceipts?.length && validReceipts.every((receipt) => digest(receipt[key]))
      ? new Set(validReceipts.map((receipt) => receipt[key])).size === 1
      : null;
  const native = array(usage.nativeResults);
  const knownCriteria = array(result.criteria)
    .filter((criterion) => criteria.has(criterion?.id))
    .map((criterion) => ({
      id: criterion.id as string,
      status: oneOf(criterion.status, ['pass', 'fail', 'unknown']) ?? 'unknown',
    }));
  const status = oneOf(result.status, ['pass', 'fail', 'error']);
  const hasEvidence = [
    resultFile,
    actorFile,
    receiptFile,
    fixtureFile,
    expectedFile,
    observationFile,
  ].some((file) => file.state !== 'missing');
  const attempted = status || hasEvidence ? true : plan.unattempted ? false : null;
  const cleanup = object(result.cleanup);
  const readiness = object(fixtureFile.value).readiness;
  const started = Date.parse(result.startedAt),
    finished = Date.parse(result.finishedAt);
  const costs = validReceipts
    ? coverage(validReceipts.map((receipt) => number(receipt.usagePublishedRateEstimateUsd)))
    : coverage([null]);
  return {
    caseId: oneOf(source.caseId, caseIds) ?? plan.caseId,
    caseVersion: count(result.caseVersion) ?? count(source.caseVersion) ?? plan.caseVersion,
    cellId: oneOf(source.cellId, cellIds) ?? plan.cellId,
    model,
    runner,
    role: oneOf(source.role, ['required', 'probe', 'reference']) ?? plan.role,
    repetition: plan.repetition,
    status: status ?? (attempted === false ? 'unattempted' : 'missing_result'),
    attempted,
    resultEvidence: resultFile.state,
    taskSuccess: typeof result.taskSuccess === 'boolean' ? result.taskSuccess : null,
    criteria: knownCriteria,
    omittedCriteria: array(result.criteria).length - knownCriteria.length,
    failedCriteria: knownCriteria
      .filter((criterion) => criterion.status === 'fail')
      .map((criterion) => criterion.id),
    unknownCriteria: knownCriteria
      .filter((criterion) => criterion.status === 'unknown')
      .map((criterion) => criterion.id),
    cleanup: {
      failures: Array.isArray(cleanup.failures) ? cleanup.failures.length : null,
      unknownMutations: Array.isArray(cleanup.unknownMutations)
        ? cleanup.unknownMutations.length
        : null,
    },
    unknownEffects:
      typeof result.hasUnknownMutation === 'boolean' ? result.hasUnknownMutation : null,
    identity: {
      sourceReceiptSha256: sourceFile.state === 'present' ? (sourceFile.sha256 ?? null) : null,
      revision: digest(source.revision, 40),
      backend: oneOf(object(source.backend).kind, ['local', 'hosted']),
      bundleDigest: digest(
        object(source.backend).bundleSha256 ?? object(source.backend).candidateDigest,
      ),
      workerVersion:
        typeof object(source.backend).workerVersion === 'string' &&
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(object(source.backend).workerVersion)
          ? object(source.backend).workerVersion
          : null,
      runnerVersion:
        typeof source.runnerVersion === 'string' &&
        /^(?:[0-9]+\.[0-9]+\.[0-9]+|responses-loop-[0-9]+)$/.test(source.runnerVersion)
          ? source.runnerVersion
          : null,
      accountingVersion: count(source.accountingVersion),
      gradingVersion: count(result.gradingVersion) ?? count(source.gradingVersion),
    },
    limits: {
      wallMs: count(object(source.limits).wallMs),
      modelRequests: count(object(source.limits).modelRequests),
      retries: count(object(source.limits).retries),
    },
    durationMs:
      Number.isFinite(started) && Number.isFinite(finished) && finished >= started
        ? finished - started
        : null,
    tokens,
    tokenBasis: basis,
    tokenSource,
    uncachedInputTokens:
      basis === 'claude_separate_cache'
        ? input
        : input !== null && cached !== null && cached <= input
          ? input - cached
          : null,
    cacheReadFraction:
      cached !== null && denominator !== null && denominator > 0 && cached <= denominator
        ? cached / denominator
        : null,
    requests: {
      count: validReceipts?.length ?? null,
      complete: validReceipts
        ? validReceipts.filter((receipt) => receipt.complete === true).length
        : null,
      identityMatches: validReceipts
        ? validReceipts.filter(
            (receipt) =>
              receipt.complete === true &&
              model !== null &&
              receipt.requestedModel === model &&
              Array.isArray(receipt.servedModels) &&
              receipt.servedModels.length > 0 &&
              receipt.servedModels.every((served: unknown) => served === model),
          ).length
        : null,
      systemPrefixStable: prefixStable('systemHash'),
      toolsPrefixStable: prefixStable('toolsHash'),
    },
    costs: {
      nativeCliEstimateUsd: native.length === 1 ? number(native[0]?.cliEstimatedCostUsd) : null,
      publishedRateEstimateUsd: costs,
      committedEstimateUsd: validReceipts?.length
        ? number(validReceipts.at(-1).totalCommittedEstimateUsd)
        : null,
      providerBilledCostUsd: number(usage.providerBilledCostUsd),
    },
    versionEvidence: {
      baseline: version(object(expectedFile.value).version),
      final: version(object(object(observationFile.value).file).version),
      readinessObservations: Array.isArray(readiness) ? readiness.length : null,
      readinessVersion: Array.isArray(readiness) ? version(readiness.at(-1)?.version) : null,
      readiness: array(readiness)
        .slice(0, 12)
        .map((entry) => ({
          version: version(entry?.version),
          status: oneOf(entry?.status, ['waiting', 'ready', 'failed']),
          elapsedMs: count(entry?.elapsedMs),
        })),
    },
    issues: [
      ...([
        sourceFile,
        resultFile,
        actorFile,
        receiptFile,
        fixtureFile,
        expectedFile,
        observationFile,
      ].some((file) => file.state === 'malformed')
        ? ['malformed_artifact']
        : []),
      ...(duplicateRequests ? ['invalid_request_sequence'] : []),
      ...(sourceFile.state === 'missing' ? ['missing_cell_source'] : []),
      ...(resultFile.state !== 'present' ? ['missing_or_invalid_trial_result'] : []),
      ...(tokenSource === 'unknown' ? ['missing_native_usage'] : []),
    ],
  };
}

/** Read saved evidence only. No fixtures, provider requests, regrading or gate changes. */
export async function summarizeSavedRun(
  saved: string,
  declaration?: ReportDeclaration,
): Promise<RunReport> {
  const [suiteFile, matrixFile, cellFile] = await Promise.all(
    ['suite-source.json', 'matrix-source.json', 'source.json'].map((name) => artifact(saved, name)),
  );
  const marker = object((await artifact(saved, 'report-preflight.json')).value);
  const synthetic =
    marker.synthetic === true && marker.inference === false && marker.google === false;
  const mode =
    suiteFile.state !== 'missing'
      ? 'suite'
      : matrixFile.state !== 'missing'
        ? 'matrix'
        : cellFile.state !== 'missing'
          ? 'single'
          : declaration
            ? 'declaration'
            : 'unknown';
  const source = object(
    (mode === 'suite' ? suiteFile : mode === 'matrix' ? matrixFile : cellFile).value,
  );
  const fallback = declarationSource(declaration ?? {});
  const plans: AttemptPlan[] = [];
  const issues: string[] = [];
  let selectedStatus: Gate = 'unknown',
    requiredPairStatus: Gate = 'unknown';
  if (mode === 'suite' || mode === 'matrix' || mode === 'declaration') {
    const resultFile = await artifact(
      saved,
      mode === 'suite' ? 'suite-results.json' : 'matrix-results.json',
    );
    const result = object(resultFile.value);
    selectedStatus = gate(result.selectedStatus);
    requiredPairStatus = gate(mode === 'suite' ? result.requiredPairStatus : result.gatedStatus);
    const cases =
      mode === 'suite'
        ? array(source.cases)
        : mode === 'declaration'
          ? fallback.cases
          : [{ id: source.caseId, version: source.caseVersion }];
    const cells = mode === 'declaration' ? fallback.cells : array(source.cells);
    if (!cases.length) issues.push('invalid_case_declaration');
    if (!cells.length) issues.push('invalid_cell_declaration');
    for (const selectedCase of cases) {
      const id = oneOf(selectedCase?.id, caseIds);
      if (!id) {
        issues.push('invalid_case_declaration');
        continue;
      }
      const caseDirectory =
        mode === 'suite' || (mode === 'declaration' && !!declaration?.cases)
          ? join(saved, id)
          : saved;
      const caseResult =
        mode === 'suite'
          ? object((await artifact(caseDirectory, 'matrix-results.json')).value)
          : result;
      for (const declaredCell of cells) {
        const checked = cell(declaredCell);
        if (!checked.valid || !checked.cellId) {
          issues.push('invalid_cell_declaration');
          continue;
        }
        const row = array(caseResult.rows).find((item) => item?.id === checked.cellId);
        const fallbackSingle = mode === 'declaration' && !declaration?.selection;
        for (
          let repetition = 1;
          repetition <= (fallbackSingle && declaration?.repeats === '2' ? 2 : 1);
          repetition++
        )
          plans.push({
            ...checked,
            directory: fallbackSingle ? saved : join(caseDirectory, checked.cellId),
            caseId: id,
            caseVersion: count(selectedCase.version),
            repetition,
            fallback: object(
              array(caseResult.results).find((item) => item?.cellId === checked.cellId),
            ),
            unattempted:
              mode === 'declaration' ||
              array(result.unattempted).includes(id) ||
              array(caseResult.unattempted).includes(checked.cellId) ||
              row?.status === 'unattempted',
          });
      }
    }
    if (resultFile.state !== 'present') issues.push('missing_or_invalid_campaign_result');
  } else if (mode === 'single') {
    const attemptFile = object((await artifact(saved, 'attempts.json')).value);
    const results = array((await artifact(saved, 'results.json')).value);
    const repeats = count(source.repeats);
    if (repeats !== 1 && repeats !== 2) issues.push('invalid_repeat_declaration');
    for (let index = 1; index <= (repeats === 2 ? 2 : 1); index++)
      plans.push({
        directory: saved,
        caseId: oneOf(source.caseId, caseIds),
        caseVersion: count(source.caseVersion),
        cellId: oneOf(source.cellId, cellIds),
        model: oneOf(source.requestedModel, models),
        runner: oneOf(source.runner, ['claude', 'responses', 'codex']),
        role: oneOf(source.role, ['required', 'probe', 'reference']),
        repetition: index,
        fallback: object(results.find((item) => item?.repetition === index)),
        unattempted: count(attemptFile.attempted) !== null && index > attemptFile.attempted,
      });
    selectedStatus =
      results.length === repeats && results.every((item) => item?.status === 'pass')
        ? 'pass'
        : results.some((item) => ['fail', 'error'].includes(item?.status))
          ? 'fail'
          : 'unknown';
  } else issues.push('missing_plan');
  if ([suiteFile, matrixFile, cellFile].some((file) => file.state === 'malformed'))
    issues.push('malformed_manifest');
  if (mode === 'declaration') {
    issues.push('fallback_declaration_only');
    if (!fallback.valid) issues.push('invalid_fallback_declaration');
  }
  const uniquePlans = new Set(
    plans.map((item) => `${item.caseId}/${item.cellId}/${item.repetition}`),
  );
  if (uniquePlans.size !== plans.length) throw new Error('Duplicate retained attempt declaration');
  const attempts = await Promise.all(plans.map(attempt));
  const groups = new Map<string, AttemptReport[]>();
  for (const row of attempts) {
    const key = `${row.model}/${row.runner}/${row.tokenBasis}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return {
    reportVersion: 1,
    synthetic,
    mode,
    recordedGate: { selectedStatus, requiredPairStatus },
    counts: {
      selected:
        mode === 'unknown' ||
        issues.some((issue) => issue.startsWith('invalid_') || issue === 'malformed_manifest') ||
        !plans.length
          ? null
          : plans.length,
      attempted: attempts.filter((row) => row.attempted === true).length,
      attemptedUnknown: attempts.filter((row) => row.attempted === null).length,
      pass: attempts.filter((row) => row.status === 'pass').length,
      fail: attempts.filter((row) => row.status === 'fail').length,
      error: attempts.filter((row) => row.status === 'error').length,
      unattempted: attempts.filter((row) => row.status === 'unattempted').length,
      missingResult: attempts.filter((row) => row.status === 'missing_result').length,
    },
    attempts,
    models: [...groups.values()].map((rows) => {
      const attempted = rows.filter((row) => row.attempted !== false);
      return {
        model: rows[0].model,
        runner: rows[0].runner,
        tokenBasis: rows[0].tokenBasis,
        attempts: attempted.length,
        tokens: Object.fromEntries(
          tokenFields.map((field) => [field, coverage(attempted.map((row) => row.tokens[field]))]),
        ) as Record<TokenField, CoverageMetric>,
        requests: coverage(attempted.map((row) => row.requests.count)),
        costs: {
          nativeCliEstimateUsd: coverage(attempted.map((row) => row.costs.nativeCliEstimateUsd)),
          publishedRateEstimateUsd: {
            ...coverage(attempted.map((row) => row.costs.publishedRateEstimateUsd.value)),
            observedSubtotal: coverage(
              attempted.map((row) => row.costs.publishedRateEstimateUsd.observedSubtotal),
            ).observedSubtotal,
          },
          committedEstimateUsd: coverage(attempted.map((row) => row.costs.committedEstimateUsd)),
          providerBilledCostUsd: coverage(attempted.map((row) => row.costs.providerBilledCostUsd)),
        },
      };
    }),
    issues: [...new Set(issues)],
  };
}

const display = (value: number | null) =>
  value === null ? 'unknown' : String(Number(value.toFixed(8)));
export function renderRunReport(report: RunReport): string {
  return [
    '# Retained agent evaluation report',
    '',
    ...(report.synthetic
      ? [
          '**Synthetic reporting preflight. No inference or Google calls; these are not real actor results.**',
          '',
        ]
      : []),
    `Recorded selected gate: **${report.recordedGate.selectedStatus.toUpperCase()}**. Required pair: **${report.recordedGate.requiredPairStatus.toUpperCase()}**.`,
    '',
    `Selected ${display(report.counts.selected)}; attempted ${report.counts.attempted}; attempted unknown ${report.counts.attemptedUnknown}; PASS ${report.counts.pass}; FAIL ${report.counts.fail}; ERROR ${report.counts.error}; unattempted ${report.counts.unattempted}; missing result ${report.counts.missingResult}.`,
    '',
    '| Case | Model | Attempt | Gate | Failed / unknown criteria | Requests | Input | Output | Cache read | Cache creation | Native estimate USD | Published-rate estimate USD | Committed estimate USD |',
    '| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.attempts.map(
      (row) =>
        `| ${row.caseId ?? 'unknown'} | ${row.model ?? 'unknown'} | ${row.repetition} | ${row.status} | ${[...row.failedCriteria, ...row.unknownCriteria].join(', ') || 'none recorded'} | ${display(row.requests.count)} | ${display(row.tokens.inputTokens)} | ${display(row.tokens.outputTokens)} | ${display(row.tokens.cacheReadInputTokens)} | ${display(row.tokens.cacheCreationInputTokens)} | ${display(row.costs.nativeCliEstimateUsd)} | ${display(row.costs.publishedRateEstimateUsd.value)} | ${display(row.costs.committedEstimateUsd)} |`,
    ),
    '',
    '## Per-model totals and coverage',
    '',
    ...report.models.flatMap((model) => [
      `### ${model.model ?? 'unknown'} (${model.runner ?? 'unknown'})`,
      '',
      `Input basis: ${model.tokenBasis}. Attempt denominator: ${model.attempts}.`,
      '',
      '| Metric | Complete total | Observed subtotal | Coverage |',
      '| --- | ---: | ---: | --- |',
      ...Object.entries({ ...model.tokens, requests: model.requests, ...model.costs }).map(
        ([key, metric]) =>
          `| ${key} | ${display(metric.value)} | ${display(metric.observedSubtotal)} | ${metric.covered}/${metric.expected} |`,
      ),
      '',
    ]),
    '## Evidence and limits',
    '',
    ...report.attempts.map(
      (row) =>
        `- ${row.caseId ?? 'unknown'}/${row.cellId ?? 'unknown'} attempt ${row.repetition}: revision ${row.identity.revision ?? 'unknown'}; source receipt ${row.identity.sourceReceiptSha256 ?? 'unknown'}; backend ${row.identity.backend ?? 'unknown'}; bundle ${row.identity.bundleDigest ?? 'unknown'}; worker version ${row.identity.workerVersion ?? 'unknown'}; case version ${display(row.caseVersion)}; grading ${display(row.identity.gradingVersion)}; runner ${row.identity.runnerVersion ?? 'unknown'}; accounting ${display(row.identity.accountingVersion)}; criteria ${row.criteria.filter((criterion) => criterion.status === 'pass').length}/${row.criteria.length} pass (${row.omittedCriteria} unrecognized IDs omitted); cleanup failures ${display(row.cleanup.failures)}, unknown cleanup mutations ${display(row.cleanup.unknownMutations)}; unknown effects ${row.unknownEffects ?? 'unknown'}; complete identity receipts ${display(row.requests.identityMatches)}/${display(row.requests.count)}; stable system/tools prefixes ${row.requests.systemPrefixStable ?? 'unknown'}/${row.requests.toolsPrefixStable ?? 'unknown'}; native baseline/final version ${row.versionEvidence.baseline ?? 'unknown'}/${row.versionEvidence.final ?? 'unknown'}; readiness ${row.versionEvidence.readiness.map((entry) => `${entry.version ?? 'unknown'}@${display(entry.elapsedMs)}ms(${entry.status ?? 'unknown'})`).join(' → ') || 'unknown'}.`,
    ),
    '',
    'Claude ordinary input, cache reads and cache creation are separate counters. Responses/Codex input includes cache reads. Reasoning tokens, when available, are part of output. These bases are not interchangeable cache-savings comparisons.',
    '',
    'Native CLI estimates, observed published-rate estimates, conservative commitments and provider/proxy billing are separate quantities. Missing telemetry stays unknown. Partial observed subtotals do not establish complete costs. Prefix stability describes only recorded hashes.',
    '',
    'This report reads retained evidence; it performs no inference, Google calls or regrading and does not change original gates. It establishes no new host, service, deployment or statistical qualification.',
    '',
    ...(report.issues.length ? [`Report issues: ${report.issues.join(', ')}.`, ''] : []),
  ].join('\n');
}

export async function writeRetainedReport(
  saved: string,
  output: string,
  options: { stepSummary?: string; declaration?: ReportDeclaration } = {},
): Promise<RunReport> {
  const input = await realpath(saved);
  const destination = join(await realpath(dirname(resolve(output))), basename(output));
  if (destination === input) throw new Error('Report output must be a new directory');
  if (options.stepSummary) {
    const summary = join(
      await realpath(dirname(resolve(options.stepSummary))),
      basename(options.stepSummary),
    );
    if (summary === input || summary.startsWith(input + '/'))
      throw new Error('Step summary must be outside retained evaluation evidence');
    const existing = await lstat(summary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.isFile()) throw new Error('Step summary must be a regular file');
  }
  const report = await summarizeSavedRun(input, options.declaration);
  const markdown = renderRunReport(report);
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, 'summary.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(destination, 'summary.md'), markdown, { mode: 0o600, flag: 'wx' });
  if (options.stepSummary) await appendFile(options.stepSummary, markdown);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [saved, output, ...flags] = process.argv.slice(2);
  if (!saved || !output || flags.some((flag) => flag !== '--step-summary') || flags.length > 1) {
    console.error('Usage: report.ts SAVED NEW_OUTPUT [--step-summary]');
    process.exitCode = 1;
  } else {
    const declaration = {
      profile: process.env.EVAL_PROFILE,
      cases: process.env.EVAL_CASES,
      caseId: process.env.EVAL_CASE,
      selection: process.env.EVAL_SELECTION,
      model: process.env.EVAL_MODEL,
      repeats: process.env.EVAL_REPEATS,
      runner: process.env.EVAL_RUNNER,
    };
    writeRetainedReport(saved, output, {
      declaration: Object.values(declaration).some(Boolean) ? declaration : undefined,
      stepSummary: flags.length ? process.env.GITHUB_STEP_SUMMARY : undefined,
    }).catch(() => {
      console.error('Retained report generation failed; original evaluation evidence is unchanged');
      process.exitCode = 1;
    });
  }
}
