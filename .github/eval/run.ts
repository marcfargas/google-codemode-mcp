import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { createBuiltWorker } from '../worker-client.ts';
import { prepareGmailFixture, gradeGmail, type GmailFixture } from './gmail.ts';
import { runActor } from './actor.ts';
import { startEvalServer, type McpEvent } from './server.ts';
import { getCellByModel } from './matrix.ts';
import { verifyModels } from './catalog.ts';
import { RESPONSES_RUNNER_VERSION } from './responses.ts';
import { RESPONSES_ACCOUNTING_VERSION } from './responses-relay.ts';

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
    status: 'unsupported',
    task: 'Find and read a run-owned fixture file; save its bytes locally.',
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

export function gradeMechanisms(audit: McpEvent[]) {
  const calls = audit.filter((event) => event.method === 'tools/call');
  const discoveries = calls.filter(
    (event) => event.params.name === 'describe' && !event.response.error,
  );
  const root = discoveries.some((event) => !event.params.arguments?.path);
  const method = discoveries.some(
    (event) =>
      /^gmail\/v1\/users\./.test(event.params.arguments?.path ?? '') &&
      event.response.result?.structuredContent?.signature,
  );
  const skill = audit.some(
    (event) =>
      event.method === 'resources/read' &&
      event.params.uri === 'skill://google-codemode-mcp/google-workspace/SKILL.md' &&
      event.response.result?.contents?.some((entry: any) =>
        entry.text?.includes('# Google Workspace Code Mode'),
      ),
  );
  const outcomes = calls.flatMap(
    (event) => event.response.result?.structuredContent?.outcomes ?? [],
  );
  const sends = outcomes.filter(
    (entry: any) =>
      entry.mutation &&
      /(?:messages|drafts)\.send$/.test(entry.path) &&
      entry.outcome === 'acknowledged',
  );
  const uncertain = outcomes.some((entry: any) => entry.mutation && entry.outcome === 'unknown');
  return [
    {
      id: 'root_discovery',
      status: root ? 'pass' : 'fail',
      evidence: `${discoveries.length} observed describe calls`,
    },
    {
      id: 'method_discovery',
      status: method ? 'pass' : 'fail',
      evidence: 'Observed method description with native signature required',
    },
    {
      id: 'skill_resource',
      status: skill ? 'pass' : 'fail',
      evidence: 'Observed successful read of actual skill:// resource required',
    },
    {
      id: 'send_ledger',
      status: sends.length === 1 && !uncertain ? 'pass' : 'fail',
      evidence: `${sends.length} acknowledged sends; unknown mutation=${uncertain}`,
    },
    {
      id: 'actor_mutation_surface',
      status: outcomes.every(
        (entry: any) =>
          !entry.mutation ||
          /^gmail\/v1\/users\.(messages\.(modify|send)|threads\.modify|drafts\.(create|update|send|delete))$/.test(
            entry.path ?? '',
          ),
      )
        ? 'pass'
        : 'fail',
      evidence:
        'Only task-related send, label and draft mutations allowed; not exhaustive Gmail configuration readback',
    },
  ];
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
}) {
  const profile = configuration?.profile ?? required('EVAL_PROFILE');
  const output = resolve(configuration?.output ?? required('EVAL_OUTPUT'));
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  await json(join(output, 'coverage.json'), profiles);
  if (profile !== 'gmail')
    throw new Error(`Coverage unavailable for ${profile}; no model call made`);
  if (process.getuid?.() !== 0)
    throw new Error(
      'Run via just eval/act; separate actor OS identity requires the workflow root runner',
    );
  const model = configuration?.model ?? required('EVAL_MODEL');
  const cell = getCellByModel(model);
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
    if (!info.scopes.includes('https://www.googleapis.com/auth/gmail.modify')) throw new Error();
  } catch {
    throw new Error('Test OAuth grant unavailable or missing Gmail modify scope; no agent started');
  }
  const worker = await createBuiltWorker();
  const results: any[] = [];
  try {
    const identity = {
      revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      bundleSha256: sha256(await readFile('dist/worker.js')),
      files: Object.fromEntries(
        await Promise.all(
          [
            '.github/eval/run.ts',
            '.github/eval/campaign.ts',
            '.github/eval/catalog.ts',
            '.github/eval/server.ts',
            '.github/eval/actor.ts',
            '.github/eval/responses.ts',
            '.github/eval/responses-relay.ts',
            '.github/eval/matrix.ts',
            '.github/eval/gmail.ts',
            'skills/google-workspace/SKILL.md',
            'package-lock.json',
          ].map(async (file) => [file, sha256(await readFile(file))]),
        ),
      ),
      profile,
      requestedModel: model,
      runner: cell.runner,
      runnerVersion: cell.runner === 'claude' ? '2.1.318' : RESPONSES_RUNNER_VERSION,
      accountingVersion: cell.runner === 'responses' ? RESPONSES_ACCOUNTING_VERSION : null,
      role: cell.role,
      cellId: cell.id,
      repeats,
      createdAt: new Date().toISOString(),
      limits: {
        wallMs: 300_000,
        modelRequests: 18,
        maxOutputTokensPerRequest: 2048,
        totalOutputTokensUpperBound: 15_000,
        nativeEstimatedUsd: cell.runner === 'claude' ? 1 : null,
        publishedRateEstimatedUsd: cell.runner === 'responses' ? 1 : null,
        retries: 0,
      },
    };
    await json(join(output, 'source.json'), identity);
    for (let repetition = 1; repetition <= repeats; repetition++) {
      const trial = join(output, `trial-${repetition}`);
      await mkdir(trial, { mode: 0o700 });
      const result: any = {
        repetition,
        status: 'error',
        startedAt: new Date().toISOString(),
        criteria: [],
      };
      results.push(result);
      let fixture: GmailFixture | undefined;
      let relay: Awaited<ReturnType<typeof startEvalServer>> | undefined;
      let observed = false;
      try {
        fixture = await prepareGmailFixture({
          accessToken,
          expectedUser,
          onEvent: (manifest) => json(join(trial, 'fixture-manifest.json'), manifest),
        });
        await json(join(trial, 'expected.json'), fixture.expected);
        relay = await startEvalServer({
          accessToken,
          proxyKey,
          proxyUrl,
          model,
          runner: cell.runner,
          output: trial,
          dispatch: async (request) => {
            const response = await worker.dispatchFetch(request.url, {
              method: request.method,
              headers: Object.fromEntries(request.headers),
              body: await request.text(),
            });
            if (
              response.headers.has('mcp-session-id') ||
              !response.headers.get('content-type')?.includes('application/json')
            )
              throw new Error('Expected finite sessionless JSON');
            return response as unknown as Response;
          },
        });
        const actor = await runActor({
          prompt: fixture.prompt,
          model,
          runner: cell.runner,
          output: trial,
          mcpUrl: relay.url + '/mcp',
          proxyUrl: relay.url + '/llm',
        });
        await json(join(trial, 'actor-result.json'), actor);
        await relay.close();
        const observation = await fixture.observe();
        await json(join(trial, 'observation.json'), observation);
        observed = true;
        await json(join(trial, 'files.json'), actor.files);
        result.criteria = [
          ...gradeGmail(fixture.expected, observation, actor.files),
          ...gradeMechanisms(relay.audit),
          gradeModel(model, relay.llm),
          {
            id: 'mutation_certainty',
            status: relay.hasUnknownMutation ? 'fail' : 'pass',
            evidence: `Outer and inner execution certainty: unknown=${relay.hasUnknownMutation}`,
          },
          {
            id: 'native_execution',
            status:
              actor.exitCode === 0 && !actor.timedOut && actor.transcript.valid ? 'pass' : 'fail',
            evidence: `exit=${actor.exitCode}; timeout=${actor.timedOut}; valid transcript=${actor.transcript.valid}`,
          },
        ];
        result.taskSuccess = gradeGmail(fixture.expected, observation, actor.files).every(
          (criterion) => criterion.status === 'pass',
        );
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
        result.runner = cell.runner;
        result.runnerVersion = actor.cliVersion;
        result.llmReceipts = relay.llm;
        result.hasUnknownMutation = relay.hasUnknownMutation;
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
          result.hasUnknownMutation = relay.hasUnknownMutation;
          result.llmReceipts = relay.llm;
        }
        if (fixture) {
          if (!observed) {
            try {
              await json(join(trial, 'observation.json'), await fixture.observe());
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
      'Only Gmail is implemented. Drive, Sheets, Docs, and Calendar remain pending.',
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
      'This synthetic pilot measures feasibility for the observed workflow, not statistical superiority or hosted Cloudflare acceptance.',
      '',
    ].join('\n');
    await writeFile(join(output, 'report.md'), report, { mode: 0o600 });
    console.log(
      `Agent feasibility ${passed ? 'PASS' : 'FAIL'}; ${results.length} trial(s); report ${join(output, 'report.md')}`,
    );
    return { passed, results, identity, profile, model, output };
  } finally {
    await worker.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('.github/eval/run.ts')) {
  runCell()
    .then((run) => {
      if (!run.passed) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Agent feasibility infrastructure failed; inspect retained private evidence');
      process.exitCode = 1;
    });
}
