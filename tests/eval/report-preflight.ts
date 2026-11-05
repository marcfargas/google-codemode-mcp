import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCampaign } from './campaign.ts';

/** Exercise real campaign manifests with synthetic failed/passing cells; no network or actors. */
export async function prepareReportPreflight(output: string) {
  const original = { ...process.env };
  try {
    Object.assign(process.env, {
      EVAL_OUTPUT: output,
      EVAL_PROFILE: 'drive',
      EVAL_CASES: 'conditional-update-unsupported',
      EVAL_SELECTION: 'required',
      EVAL_MODEL: '',
      EVAL_REPEATS: '1',
    });
    const passed = await runCampaign({
      verifyModels: async () => ({
        checkedAt: 'synthetic',
        models: ['claude-sonnet-5-5', 'gpt-6.1-sol'],
        evidence: 'synthetic; no inference',
      }),
      runCell: async (options) => {
        const claude = options!.model === 'claude-sonnet-5-5';
        const result = {
          repetition: 1,
          status: claude ? ('fail' as const) : ('pass' as const),
          caseId: options!.caseId,
          caseVersion: 2,
          gradingVersion: 3,
          taskSuccess: !claude,
          hasUnknownMutation: false,
          cleanup: { failures: [], unknownMutations: [] },
          criteria: [{ id: 'drive_version_preserved', status: claude ? 'fail' : 'pass' }],
          usage: {
            totalsSource: claude ? 'terminal_native_result' : 'terminal_responses_usage',
            totals: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 4 },
            providerBilledCostUsd: null,
          },
        };
        await mkdir(join(options!.output, 'trial-1'), { recursive: true, mode: 0o700 });
        const json = (path: string, value: unknown) =>
          writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        await json(join(options!.output, 'source.json'), {
          profile: 'drive',
          caseId: options!.caseId,
          caseVersion: 2,
          gradingVersion: 3,
          requestedModel: options!.model,
          runner: claude ? 'claude' : 'responses',
          role: 'required',
          cellId: claude ? 'sonnet' : 'sol',
          repeats: 1,
        });
        await json(join(options!.output, 'trial-1/result.json'), result);
        return {
          passed: !claude,
          profile: 'drive',
          model: options!.model,
          output: options!.output,
          identity: {} as never,
          results: [result],
        };
      },
    });
    if (passed) throw new Error('Synthetic failed campaign unexpectedly passed');
    await writeFile(
      join(output, 'report-preflight.json'),
      JSON.stringify({ synthetic: true, inference: false, google: false, campaignPassed: passed }) +
        '\n',
      { mode: 0o600 },
    );
  } finally {
    process.env = original;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.EVAL_OUTPUT) throw new Error('Missing evidence output');
    await prepareReportPreflight(resolve(process.env.EVAL_OUTPUT));
  } catch {
    console.error('Synthetic report preflight failed');
    process.exitCode = 1;
  }
}
