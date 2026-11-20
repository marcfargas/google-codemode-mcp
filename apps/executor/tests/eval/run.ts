import {
  prepareArtifactFixture,
  gradeArtifacts,
  type ArtifactFixture,
  type ArtifactExpected,
  type ArtifactTaskObservation,
} from './artifacts.ts';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { createEvaluationBackend } from './backend.ts';
import { prepareGmailFixture, gradeGmail, type GmailFixture } from './gmail.ts';
import { runActor } from './actor.ts';
import { startEvalServer } from './server.ts';
import { gradeMechanisms, GRADING_VERSION } from './mechanisms.ts';
export { gradeMechanisms } from './mechanisms.ts';
import { getCellByModel, NATIVE_CODEX_PROBE } from './matrix.ts';
import { verifyModels } from './catalog.ts';
import { RESPONSES_RUNNER_VERSION } from './responses.ts';
import { RESPONSES_ACCOUNTING_VERSION } from './responses-relay.ts';
import { getCase, getGmailCase } from './cases.ts';
import {
  prepareDriveFixture,
  gradeDrive,
  type DriveExpected,
  type DriveObservation,
} from './drive.ts';
import type { GmailExpected, GmailObservation } from './gmail.ts';
import {
  prepareMediaFixture,
  gradeMedia,
  type MediaExpected,
  type MediaObservation,
  type MediaFixture,
} from './media.ts';
import type { McpEvent } from './server.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const profiles = {
  gmail: {
    status: 'implemented',
    task: 'Read/reply/label a seeded message and save its UTF-8 attachment.',
  },
  drive: {
    status: 'implemented',
    task: 'Find and read a run-owned fixture file; save its bytes locally.',
  },
  artifacts: {
    status: 'implemented',
    task: 'Store, inspect and delete large native JSON and binary attachments through R2 artifacts.',
  },
  media: {
    status: 'implemented',
    task: 'Compose Gmail attachments and Drive files with exact bytes and an unsent Gmail draft.',
  },
  sheets: {
    status: 'unsupported',
    task: 'Read a fixture value and update one designated cell; preserve surrounding cells.',
  },
  docs: {
    status: 'unsupported',
    task: 'Read a fixture document and append a requested paragraph; preserve existing content.',
  },
  calendar: {
    status: 'unsupported',
    task: 'Find a fixture event and update its description; preserve its time and guests.',
  },
};

export function gradeTask(
  expected: GmailExpected | DriveExpected | MediaExpected | ArtifactExpected,
  observation:
    GmailObservation | DriveObservation | MediaObservation | ArtifactTaskObservation | null,
  files: Record<string, string>,
  audit: McpEvent[],
  outbound?: unknown,
) {
  if ('profile' in expected && expected.profile === 'artifacts')
    return gradeArtifacts(expected, observation as ArtifactTaskObservation | null, files, audit);
  return 'profile' in expected && expected.profile === 'media'
    ? gradeMedia(expected, observation as MediaObservation | null, files, audit)
    : 'fileId' in expected
      ? gradeDrive(expected, observation as DriveObservation | null, files, audit, outbound)
      : gradeGmail(expected as GmailExpected, observation as GmailObservation | null, files, audit);
}

export function gradeModel(model: string, receipts: any[]) {
  const mismatch = receipts.some(
    (receipt) =>
      receipt.requestedModel !== model ||
      receipt.servedModels?.some((served: string) => served !== model),
  );
  const complete =
    receipts.length > 0 &&
    receipts.every((receipt) => receipt.complete === true && receipt.servedModels?.length > 0);
  return {
    id: 'model_identity',
    status: mismatch ? 'fail' : complete ? 'pass' : 'unknown',
    evidence: `Requested ${model}; ${receipts.length} receipts; complete identity evidence=${complete}; mismatch=${mismatch}`,
  };
}

export async function runCell(configuration?: {
  profile: string;
  model: string;
  output: string;
  repeats?: number;
  caseId?: string;
}) {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.ACT !== 'true')
    throw new Error('Paid agent evaluation requires local act and marcdev CLIProxyAPI');
  const nativeProbe = process.env.EVAL_RUNNER === 'codex';
  if (process.env.EVAL_RUNNER && !nativeProbe)
    throw new Error('Only the explicit codex capability probe overrides a runner');
  const profile = configuration?.profile ?? required('EVAL_PROFILE');
  if (
    nativeProbe &&
    (profile !== 'gmail' ||
      (configuration?.model ?? process.env.EVAL_MODEL) !== NATIVE_CODEX_PROBE.model ||
      (configuration?.caseId ?? process.env.EVAL_CASE ?? 'read-search') !== 'read-search' ||
      Number(configuration?.repeats ?? process.env.EVAL_REPEATS ?? 1) !== 1 ||
      !!process.env.EVAL_SELECTION ||
      !!process.env.EVAL_CASES)
  )
    throw new Error(
      `Native Codex is one optional Gmail read-search probe with ${NATIVE_CODEX_PROBE.model}`,
    );
  const output = resolve(configuration?.output ?? required('EVAL_OUTPUT'));
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  await json(join(output, 'coverage.json'), profiles);
  if (!['gmail', 'drive', 'media', 'artifacts'].includes(profile))
    throw new Error(`Coverage unavailable for ${profile}; no model call made`);
  const selectedCase = getCase(
    profile,
    configuration?.caseId ?? process.env.EVAL_CASE ?? (nativeProbe ? 'read-search' : undefined),
  );
  const captureOutbound =
    profile === 'drive' && selectedCase.id === 'conditional-update-unsupported';
  if (captureOutbound && process.env.EVAL_BACKEND === 'hosted')
    throw new Error(
      'Hosted conditional evaluation lacks independent outbound recording; no actor started',
    );
  if (process.getuid?.() !== 0)
    throw new Error(
      'Run via just eval/act; separate actor OS identity requires the workflow root runner',
    );
  const model = configuration?.model ?? required('EVAL_MODEL');
  const cell = nativeProbe ? NATIVE_CODEX_PROBE : getCellByModel(model);
  const { runner } = cell;
  const proxyUrl = required('EVAL_PROXY_URL');
  if (!/^https?:\/\//.test(proxyUrl)) throw new Error('Proxy URL must use HTTP or HTTPS');
  const repeats = Number(configuration?.repeats ?? process.env.EVAL_REPEATS ?? 1);
  if (![1, 2].includes(repeats))
    throw new Error('Select one trial or two fresh cache-observation trials');
  const proxyKey = required('CPA_CLIENT_API_KEY');
  await json(join(output, 'catalogue.json'), await verifyModels(proxyUrl, proxyKey, [model]));
  const expectedUser = required('GOOGLE_TEST_USER');
  const { installed } = JSON.parse(required('GOOGLE_OAUTH_CLIENT_JSON'));
  const oauth = new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
  });
  oauth.setCredentials({ refresh_token: required('GOOGLE_TEST_REFRESH_TOKEN') });
  let accessToken: string;
  try {
    accessToken = (await oauth.refreshAccessToken()).credentials.access_token!;
    if (!accessToken) throw new Error();
    const info = await oauth.getTokenInfo(accessToken);
    if (
      (profile === 'media'
        ? ['gmail.modify', 'drive.file']
        : [['gmail', 'artifacts'].includes(profile) ? 'gmail.modify' : 'drive.file']
      ).some((scope) => !info.scopes.includes('https://www.googleapis.com/auth/' + scope))
    )
      throw new Error();
  } catch {
    throw new Error(
      'Test OAuth grant unavailable or missing selected service scope; no agent started',
    );
  }
  await mkdir(join(output, 'trial-1'), { mode: 0o700 });
  let backend = await createEvaluationBackend(join(output, 'trial-1'), {
    captureOutbound,
    artifacts: profile === 'artifacts',
  });
  const results: any[] = [];
  try {
    const identity = {
      revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      backend: backend.identity,
      files: Object.fromEntries(
        await Promise.all(
          [
            'apps/executor/tests/eval/run.ts',
            'apps/executor/tests/eval/backend.ts',
            'apps/executor/tests/eval/outbound.ts',
            'apps/executor/tests/support/worker-client.ts',
            'apps/executor/tests/support/io.ts',
            'apps/executor/tests/eval/campaign.ts',
            'apps/executor/tests/eval/catalog.ts',
            'apps/executor/tests/eval/server.ts',
            'apps/executor/tests/eval/actor.ts',
            'apps/executor/tests/eval/codex.ts',
            'apps/executor/tests/eval/responses.ts',
            'apps/executor/tests/eval/responses-relay.ts',
            'apps/executor/tests/eval/matrix.ts',
            'apps/executor/tests/eval/gmail.ts',
            'apps/executor/tests/eval/mechanisms.ts',
            'apps/executor/tests/eval/cases.ts',
            'apps/executor/tests/eval/drive.ts',
            'apps/executor/tests/eval/media.ts',
            'apps/executor/tests/eval/artifacts.ts',
            'apps/executor/skills/google-workspace/references/artifacts.md',
            'apps/executor/skills/google-workspace/references/pagination.md',
            'apps/executor/skills/google-workspace/references/media-transfers.md',
            'apps/executor/skills/google-workspace/SKILL.md',
            'package-lock.json',
          ].map(async (file) => [file, sha256(await readFile(file))]),
        ),
      ),
      profile,
      gradingVersion: GRADING_VERSION,
      caseId: selectedCase.id,
      caseVersion: selectedCase.version,
      mechanismPolicy: selectedCase.policy,
      requestedModel: model,
      runner,
      runnerVersion:
        runner === 'claude' ? '2.1.318' : runner === 'codex' ? '0.166.0' : RESPONSES_RUNNER_VERSION,
      accountingVersion: runner === 'claude' ? null : RESPONSES_ACCOUNTING_VERSION,
      role: cell.role,
      cellId: cell.id,
      repeats,
      createdAt: new Date().toISOString(),
      limits: {
        wallMs: 300_000,
        modelRequests: 18,
        maxOutputTokensPerRequest: 2048,
        totalOutputTokensUpperBound: 15_000,
        nativeEstimatedUsd: runner === 'claude' ? 1 : null,
        publishedRateEstimatedUsd: runner === 'claude' ? null : 1,
        retries: 0,
      },
    };
    await json(join(output, 'source.json'), identity);
    for (let repetition = 1; repetition <= repeats; repetition++) {
      const trial = join(output, `trial-${repetition}`);
      if (repetition > 1) {
        await mkdir(trial, { mode: 0o700 });
        backend = await createEvaluationBackend(trial, {
          captureOutbound,
          artifacts: profile === 'artifacts',
        });
        if (JSON.stringify(backend.identity) !== JSON.stringify(identity.backend)) {
          await backend.close();
          throw new Error('Backend identity changed between trials; no actor started');
        }
      }
      const result: any = {
        repetition,
        gradingVersion: GRADING_VERSION,
        caseId: selectedCase.id,
        caseVersion: selectedCase.version,
        status: 'error',
        startedAt: new Date().toISOString(),
        criteria: [],
      };
      results.push(result);
      let fixture:
        | GmailFixture
        | Awaited<ReturnType<typeof prepareDriveFixture>>
        | MediaFixture
        | ArtifactFixture
        | undefined;
      let relay: Awaited<ReturnType<typeof startEvalServer>> | undefined;
      let observed = false;
      let outbound: unknown;
      try {
        const fixtureOptions = {
          accessToken,
          expectedUser,
          onEvent: (manifest: unknown) => json(join(trial, 'fixture-manifest.json'), manifest),
        };
        fixture =
          profile === 'artifacts'
            ? await prepareArtifactFixture({ ...fixtureOptions, caseId: selectedCase.id })
            : profile === 'gmail'
              ? await prepareGmailFixture({
                  ...fixtureOptions,
                  caseId: getGmailCase(selectedCase.id).id,
                })
              : profile === 'media'
                ? await prepareMediaFixture({ ...fixtureOptions, caseId: selectedCase.id })
                : await prepareDriveFixture({ ...fixtureOptions, caseId: selectedCase.id });
        await json(join(trial, 'expected.json'), fixture.expected);
        relay = await startEvalServer({
          accessToken,
          proxyKey,
          proxyUrl,
          model,
          runner,
          output: trial,
          redactSecrets: backend.secrets,
          dispatch: backend.dispatch,
          requireArtifactLedger: profile === 'artifacts',
        });
        const actor = await runActor({
          prompt: fixture.prompt,
          model,
          runner,
          output: trial,
          mcpUrl: relay.url + '/mcp',
          proxyUrl: relay.url + '/llm',
        });
        await json(join(trial, 'actor-result.json'), actor);
        await relay.close();
        outbound = await backend.finishObservation();
        if (
          captureOutbound &&
          (!(outbound as any)?.complete || !(outbound as any)?.workerDisposed)
        ) {
          result.outboundError = true;
          result.infrastructureAbort = true;
          throw new Error('Independent outbound coverage incomplete; no later actor may start');
        }
        const observation =
          profile === 'artifacts'
            ? await (fixture as ArtifactFixture).observe(backend.artifacts!)
            : profile === 'media'
              ? await (fixture as MediaFixture).observe(actor.files, relay.audit)
              : await (fixture as GmailFixture).observe();
        await json(join(trial, 'observation.json'), observation);
        observed = true;
        await json(join(trial, 'files.json'), actor.files);
        const task = gradeTask(fixture.expected, observation, actor.files, relay.audit, outbound);
        result.criteria = [
          ...task,
          ...gradeMechanisms(relay.audit, selectedCase.policy),
          gradeModel(model, relay.llm),
          {
            id: 'mutation_certainty',
            status: relay.hasUnknownMutation || backend.hasUnknownMutation ? 'fail' : 'pass',
            evidence: `Execution or independently observed write uncertainty: unknown=${relay.hasUnknownMutation || backend.hasUnknownMutation}`,
          },
          {
            id: 'native_execution',
            status:
              actor.exitCode === 0 && !actor.timedOut && actor.transcript.valid ? 'pass' : 'fail',
            evidence: `exit=${actor.exitCode}; timeout=${actor.timedOut}; valid transcript=${actor.transcript.valid}`,
          },
        ];
        result.taskSuccess = task.every((criterion) => criterion.status === 'pass');
        result.status = result.criteria.every((criterion: any) => criterion.status === 'pass')
          ? 'pass'
          : 'fail';
        if (
          !observation.complete ||
          relay.llm.some((receipt) => receipt.error || receipt.status >= 400)
        ) {
          result.status = 'error';
          result.error = 'Independent readback or model transport failed';
        }
        if (actor.exitCode !== 0 || actor.timedOut || !actor.transcript.valid) {
          result.infrastructureAbort = true;
          result.status = 'error';
          result.error = 'Actor execution did not complete with a valid successful transcript';
        }
        result.usage = actor.usage;
        result.runner = runner;
        result.runnerVersion = actor.cliVersion;
        result.llmReceipts = relay.llm;
        result.hasUnknownMutation = relay.hasUnknownMutation || backend.hasUnknownMutation;
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'Evaluation failed';
      } finally {
        if (relay) {
          await json(join(trial, 'result-before-cleanup.json'), result);
          try {
            await relay.close();
          } catch {
            result.relayCloseError = true;
            result.status = 'error';
          }
          result.hasUnknownMutation =
            result.hasUnknownMutation === true ||
            relay.hasUnknownMutation ||
            backend.hasUnknownMutation;
          result.llmReceipts = relay.llm;
        }
        try {
          outbound ??= await backend.finishObservation();
          if (
            captureOutbound &&
            (!(outbound as any)?.complete || !(outbound as any)?.workerDisposed)
          )
            throw new Error('Incomplete outbound observation');
        } catch {
          result.outboundError = true;
          result.infrastructureAbort = true;
          result.status = 'error';
        }
        result.hasUnknownMutation =
          result.hasUnknownMutation === true || backend.hasUnknownMutation;
        if (fixture) {
          if (!observed) {
            try {
              await json(
                join(trial, 'observation.json'),
                profile === 'artifacts'
                  ? await (fixture as ArtifactFixture).observe(backend.artifacts!)
                  : profile === 'media'
                    ? await (fixture as MediaFixture).observe(undefined, relay?.audit)
                    : await (fixture as GmailFixture).observe(),
              );
            } catch {
              result.observationError = true;
            }
          }
          try {
            result.cleanup = await fixture.cleanup();
            if (result.cleanup.failures.length || result.cleanup.unknownMutations.length)
              result.status = 'error';
          } catch {
            result.cleanupError = true;
            result.status = 'error';
          }
        }
        result.finishedAt = new Date().toISOString();
        await json(join(trial, 'result.json'), result);
        await json(join(output, 'results.json'), results);
      }
      if (result.status !== 'pass') break;
    }
    const passed =
      results.length === repeats && results.every((result) => result.status === 'pass');
    await json(join(output, 'attempts.json'), {
      requested: repeats,
      attempted: results.length,
      unattempted: repeats - results.length,
    });
    const report = [
      '# Agent feasibility',
      '',
      `Profile: ${profile}. Model: ${model}. Result: ${passed ? 'PASS' : 'FAIL'}.`,
      '',
      nativeProbe
        ? 'Optional native Codex CLI capability probe with a broader tool surface. The required Responses runner has its own matrix results.'
        : `Runner: ${runner}.`,
      '',
      'Gmail, Drive and their media-composition profiles are implemented. Sheets, Docs, and Calendar remain pending.',
      '',
      ...results.flatMap((result) => [
        `## Trial ${result.repetition}: ${result.status}`,
        '',
        `Task outcomes: ${result.taskSuccess === true ? 'PASS' : result.taskSuccess === false ? 'FAIL' : 'UNKNOWN'}. Full gate includes discovery, skill, model and execution criteria.`,
        '',
        ...(result.criteria ?? []).map(
          (criterion: any) => `- ${criterion.id}: ${criterion.status} — ${criterion.evidence}`,
        ),
        '',
        result.error ? `Execution error: ${result.error}` : '',
        `Usage and provider cache counters: see trial-${result.repetition}/actor-result.json and model-receipts.jsonl. CLI-estimated costs are not billed costs.`,
        `Terminal token totals: ${JSON.stringify(result.usage?.totals ?? null)}. CLI-estimated USD: ${JSON.stringify(result.usage?.nativeResults?.map((entry: any) => entry.cliEstimatedCostUsd) ?? null)}.`,
        `Cleanup: ${JSON.stringify(result.cleanup ?? null)}.`,
        '',
      ]),
      backend.identity.kind === 'hosted'
        ? 'This pilot measures the selected protected hosted product path and observed workflow; it does not establish other hosts or statistical reliability.'
        : 'This synthetic pilot measures feasibility for the observed workflow, not statistical superiority or hosted Cloudflare acceptance.',
      '',
    ].join('\n');
    await writeFile(join(output, 'report.md'), report, { mode: 0o600 });
    console.log(
      `Agent feasibility ${passed ? 'PASS' : 'FAIL'}; ${results.length} trial(s); report ${join(output, 'report.md')}`,
    );
    return { passed, results, identity, profile, model, output };
  } finally {
    await backend.close();
  }
}
