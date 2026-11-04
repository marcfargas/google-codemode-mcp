import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeGmail, type GmailExpected, type GmailObservation } from './gmail.ts';
import { parseTranscript, summarizeUsage } from './actor.ts';
import { gradeMechanisms, gradeModel } from './run.ts';
import type { McpEvent } from './server.ts';

type RecordValue = Record<string, any>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function gradeSavedEvidence(evidence: {
  expected: GmailExpected | null;
  observation: GmailObservation | null;
  files: Record<string, string> | null;
  actor: RecordValue | null;
  audit: McpEvent[];
  receipts: RecordValue[];
  source: RecordValue | null;
  original: RecordValue | null;
  evidenceErrors: string[];
}) {
  const { expected, observation, files, actor, audit, receipts, source, original } = evidence;
  const safeGrade = (
    id: string,
    grade: () => { id: string; status: string; evidence: string }[],
  ) => {
    try {
      return grade();
    } catch {
      evidence.evidenceErrors.push(`Malformed retained ${id} evidence`);
      return [{ id, status: 'unknown', evidence: `Saved ${id} evidence could not be graded` }];
    }
  };
  const task = safeGrade('task_evidence', () =>
    expected
      ? gradeGmail(expected, observation, files ?? {})
      : [
          {
            id: 'task_evidence',
            status: 'unknown',
            evidence: 'Saved fixture expectation unavailable',
          },
        ],
  );
  const native =
    actor && Array.isArray(actor.native)
      ? parseTranscript(
          actor.native.map((event: unknown) => JSON.stringify(event)).join('\n'),
          actor.exitCode,
          actor.timedOut,
        )
      : null;
  const nativeValid = !!native?.transcript.valid && actor?.transcript?.valid === true;
  const cleanup = original?.cleanup;
  const cleanupKnown =
    cleanup && Array.isArray(cleanup.failures) && Array.isArray(cleanup.unknownMutations);
  const cleanupClean =
    cleanupKnown &&
    cleanup.failures.length === 0 &&
    cleanup.unknownMutations.length === 0 &&
    !original?.cleanupError;
  const originalError =
    original?.status === 'error' ||
    !!original?.error ||
    !!original?.relayCloseError ||
    !!original?.cleanupError;
  const outerUnknown = audit.some((event) => event.response?.outerUnknown === true);
  const mutationCertain = original?.hasUnknownMutation === false && !outerUnknown;
  const fileAgreement =
    actor &&
    files &&
    JSON.stringify(Object.entries(actor.files ?? {}).sort()) ===
      JSON.stringify(Object.entries(files).sort());
  const criteria = [
    ...task,
    ...safeGrade('mechanism_evidence', () => gradeMechanisms(audit)),
    ...safeGrade('model_identity', () => [
      gradeModel(typeof source?.requestedModel === 'string' ? source.requestedModel : '', receipts),
    ]),
    {
      id: 'native_execution',
      status: nativeValid ? 'pass' : 'fail',
      evidence: native
        ? native.transcript.errors.join('; ') || 'Saved native execution and transcript agree'
        : 'Saved native trace unavailable',
    },
    {
      id: 'mutation_certainty',
      status: mutationCertain ? 'pass' : 'unknown',
      evidence: `Saved unknown-mutation evidence: ${String(original?.hasUnknownMutation)}; outer dispatch unknown=${outerUnknown}`,
    },
    {
      id: 'saved_files',
      status: fileAgreement ? 'pass' : 'fail',
      evidence: 'Independent captured files.json compared with saved actor-result.json files',
    },
    {
      id: 'saved_execution_errors',
      status: original && !originalError ? 'pass' : originalError ? 'fail' : 'unknown',
      evidence: originalError
        ? 'Original execution/relay/cleanup error remains part of the result'
        : 'Original result retained without changing its error evidence',
    },
    {
      id: 'saved_cleanup',
      status: cleanupClean ? 'pass' : cleanupKnown ? 'fail' : 'unknown',
      evidence:
        'Original cleanup failures, unknown mutations and cleanupError preserved; no new cleanup performed',
    },
    {
      id: 'evidence_completeness',
      status: evidence.evidenceErrors.length === 0 ? 'pass' : 'unknown',
      evidence:
        evidence.evidenceErrors.join('; ') || 'Required retained inputs parsed successfully',
    },
  ];
  return {
    status:
      originalError || (cleanupKnown && !cleanupClean)
        ? 'error'
        : criteria.every((criterion) => criterion.status === 'pass')
          ? 'pass'
          : 'fail',
    taskSuccess: task.every((criterion) => criterion.status === 'pass'),
    criteria,
    originalResult: original,
    executionSource: source,
    originalUsage: actor?.usage ?? null,
    usage: native ? summarizeUsage(native.native, source?.requestedModel ?? '') : null,
    offline: true,
    liveSystemQualified: false,
  };
}

export async function regradeTrial(saved: string, output: string) {
  if (!isAbsolute(saved) || !isAbsolute(output))
    throw new Error('Saved trial and new output must be absolute paths');
  const execution = await realpath(saved);
  const destination = resolve(output);
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  const destinationParent = await realpath(dirname(destination));
  const canonicalDestination = join(destinationParent, destination.split('/').at(-1)!);
  if (inside(execution, canonicalDestination) || inside(checkout, canonicalDestination))
    throw new Error('Regrade output must be outside saved execution and checkout');
  await mkdir(canonicalDestination, { mode: 0o700 });
  const evidenceErrors: string[] = [];
  const inputs: Record<string, { path: string; sha256: string }> = {};
  async function load(name: string, path = join(execution, name), jsonl = false) {
    try {
      const text = await readFile(path, 'utf8');
      inputs[name] = { path, sha256: hash(text) };
      await writeFile(join(canonicalDestination, name), text, { mode: 0o600 });
      return jsonl
        ? text
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        : JSON.parse(text);
    } catch {
      evidenceErrors.push(`Missing or malformed retained ${name}`);
      return null;
    }
  }
  const source = await load('source.json', join(dirname(execution), 'source.json'));
  const original = await load('result.json');
  const expected = await load('expected.json');
  const observation = await load('observation.json');
  const files = await load('files.json');
  const actor = await load('actor-result.json');
  const audit = await load('mcp.jsonl', undefined, true);
  const receipts = await load('model-receipts.jsonl', undefined, true);
  const result = gradeSavedEvidence({
    source,
    original,
    expected,
    observation,
    files,
    actor,
    audit: audit ?? [],
    receipts: receipts ?? [],
    evidenceErrors,
  });
  const gradingFiles = ['regrade.ts', 'gmail.ts', 'run.ts', 'actor.ts'];
  const gradingIdentity = {
    revision:
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim() ||
      null,
    files: Object.fromEntries(
      await Promise.all(
        gradingFiles.map(async (file) => [
          file,
          hash(await readFile(join(checkout, '.github/eval', file), 'utf8')),
        ]),
      ),
    ),
  };
  const report = {
    ...result,
    savedExecution: execution,
    regradedAt: new Date().toISOString(),
    gradingIdentity,
    inputs,
  };
  await json(join(canonicalDestination, 'regrade.json'), report);
  await writeFile(
    join(canonicalDestination, 'report.md'),
    [
      '# Offline agent regrade',
      '',
      `Result: ${report.status.toUpperCase()}. Saved execution: ${execution}.`,
      '',
      `Task outcomes: ${report.taskSuccess ? 'PASS' : 'FAIL'}. Full gate includes mechanism and evidence criteria.`,
      `Terminal token totals: ${JSON.stringify(report.usage?.totals ?? null)}. CLI-estimated USD: ${JSON.stringify(report.usage?.nativeResults?.map((entry) => entry.cliEstimatedCostUsd) ?? null)}. Provider billing remains unknown.`,
      '',
      'This reuses retained evidence. No Google, model, fixture or cleanup operation ran; it cannot qualify the current live system.',
      '',
      ...report.criteria.map(
        (criterion) => `- ${criterion.id}: ${criterion.status} — ${criterion.evidence}`,
      ),
      '',
      'Original source identity and result, including cleanup and error evidence, are preserved unchanged beside regrade.json.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [saved, output] = process.argv.slice(2);
  if (!saved || !output) {
    console.error('Use just eval-regrade ABSOLUTE_SAVED_TRIAL NEW_ABSOLUTE_OUTPUT');
    process.exitCode = 2;
  } else
    regradeTrial(saved, output)
      .then((result) => {
        console.log(`Offline regrade ${result.status.toUpperCase()}; ${join(output, 'report.md')}`);
        if (result.status !== 'pass') process.exitCode = 1;
      })
      .catch((error: Error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
