import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCampaign } from '../eval/campaign.ts';
import { verifyModels } from '../eval/catalog.ts';

test('metadata preflight requires exact advertised IDs without inference', async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    assert.equal(req.headers.authorization, 'Bearer synthetic');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-terra' }] }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await verifyModels(base, 'synthetic', ['gpt-6.1-terra']);
    await assert.rejects(verifyModels(base, 'synthetic', ['gpt-6.1-sol']), /does not advertise/);
    await assert.rejects(
      verifyModels(base + '?secret=invalid', 'synthetic', []),
      /credential-free/,
    );
    assert.deepEqual(paths, ['/v1/models', '/v1/models']);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('campaign continues optional score failures but stops on infrastructure or uncertain cleanup', async () => {
  const original = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'gmail-campaign-'));
  try {
    for (const [index, patch] of [
      {},
      { infrastructureAbort: true },
      { hasUnknownMutation: true },
      { cleanup: { failures: ['fixture'], unknownMutations: [] } },
    ].entries()) {
      const attempted: string[] = [];
      const output = join(root, String(index));
      Object.assign(process.env, {
        EVAL_SELECTION: 'haiku,luna,opus',
        EVAL_MODEL: '',
        EVAL_PROFILE: 'gmail',
        EVAL_REPEATS: '1',
        EVAL_OUTPUT: output,
        EVAL_PROXY_URL: 'http://unused',
        CPA_CLIENT_API_KEY: 'synthetic',
      });
      await runCampaign({
        verifyModels: async () => ({ checkedAt: 'synthetic', models: [], evidence: 'synthetic' }),
        runCell: async (options) => {
          attempted.push(options!.model);
          return {
            passed: false,
            profile: 'gmail',
            model: options!.model,
            output: options!.output,
            identity: {} as never,
            results: [
              {
                status: 'fail',
                taskSuccess: false,
                hasUnknownMutation: false,
                cleanup: { failures: [], unknownMutations: [] },
                ...patch,
              },
            ],
          };
        },
      });
      const saved = JSON.parse(await readFile(join(output, 'matrix-results.json'), 'utf8'));
      assert.equal(attempted.length, index === 0 ? 3 : 1);
      assert.equal(saved.selectedStatus, index === 0 ? 'pass' : 'fail');
      assert.equal(saved.gatedStatus, index === 0 ? 'pending' : 'fail');
      assert.deepEqual(saved.unattempted, index === 0 ? [] : ['luna', 'opus']);
      assert.equal(saved.stopReason === null, index === 0);
    }
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('independent suite attempts each case/model once and retains unattempted safety stops', async () => {
  const original = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'gmail-suite-'));
  try {
    for (const unsafe of [false, true]) {
      const attempted: string[] = [];
      const output = join(root, String(unsafe));
      Object.assign(process.env, {
        EVAL_CASES: 'all',
        EVAL_SELECTION: 'required',
        EVAL_MODEL: '',
        EVAL_PROFILE: 'gmail',
        EVAL_REPEATS: '1',
        EVAL_OUTPUT: output,
        EVAL_PROXY_URL: 'http://unused',
        CPA_CLIENT_API_KEY: 'synthetic',
      });
      const passed = await runCampaign({
        verifyModels: async () => ({ checkedAt: 'synthetic', models: [], evidence: 'synthetic' }),
        runCell: async (options) => {
          attempted.push(`${options!.caseId}/${options!.model}`);
          return {
            passed: !unsafe,
            profile: 'gmail',
            model: options!.model,
            output: options!.output,
            identity: {} as never,
            results: [
              {
                status: unsafe ? 'error' : 'pass',
                taskSuccess: !unsafe,
                hasUnknownMutation: unsafe,
                cleanup: { failures: [], unknownMutations: [] },
              },
            ],
          };
        },
      });
      const saved = JSON.parse(await readFile(join(output, 'suite-results.json'), 'utf8'));
      const source = JSON.parse(await readFile(join(output, 'suite-source.json'), 'utf8'));
      assert.equal(attempted.length, unsafe ? 1 : 12);
      assert.equal(new Set(attempted).size, attempted.length);
      assert.equal(passed, !unsafe);
      assert.equal(source.estimatedUsdCeilingTotal, 12);
      assert.equal(saved.requiredPairStatus, unsafe ? 'fail' : 'pass');
      assert.equal(saved.unattempted.length, unsafe ? 5 : 0);
      assert.equal(saved.stopReason === null, !unsafe);
    }
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
});
