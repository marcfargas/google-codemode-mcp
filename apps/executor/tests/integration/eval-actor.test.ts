import assert from 'node:assert/strict';
import { chown, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectFiles,
  parseTranscript,
  probeIsolation,
  runActor,
  summarizeUsage,
} from '../eval/actor.ts';

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'synthetic-session',
};

test('native successful no-op is only execution evidence, with unknown usage', () => {
  const parsed = parseTranscript(JSON.stringify(success), 0);
  assert.equal(parsed.transcript.valid, true);
  assert.deepEqual(parsed.native, [success]);
  const usage = summarizeUsage(parsed.native, 'requested');
  assert.deepEqual(usage.observedModels, []);
  assert.deepEqual(usage.totals, {
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  });
  assert.equal(usage.nativeResults[0].cliEstimatedCostUsd, null);
  assert.equal(usage.providerBilledCostUsd, null);
});

test('native failures, missing results and malformed events remain failures', () => {
  for (const [text, exitCode, timedOut] of [
    ['', 0, false],
    ['not json\n' + JSON.stringify(success), 0, false],
    [JSON.stringify(success), 7, false],
    [JSON.stringify(success), null, true],
    [JSON.stringify({ ...success, subtype: 'error_max_turns' }), 0, false],
    [JSON.stringify({ ...success, is_error: true }), 0, false],
    [JSON.stringify(success) + '\n' + JSON.stringify(success), 0, false],
  ] as const) {
    assert.equal(parseTranscript(text, exitCode, timedOut).transcript.valid, false);
  }
});

test('usage distinguishes cache reads, cache writes, ordinary input and native estimates', () => {
  const events = [
    {
      type: 'assistant',
      message: {
        id: 'one',
        model: 'actual',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'one',
        model: 'actual',
        usage: { input_tokens: 0, output_tokens: 3, cache_read_input_tokens: 0 },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'two',
        model: 'actual',
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: 120,
          cache_creation_input_tokens: 0,
        },
      },
    },
    {
      ...success,
      usage: { input_tokens: 15 },
      modelUsage: { actual: { inputTokens: 15, cacheReadInputTokens: 220 } },
      total_cost_usd: 0.04,
    },
  ];
  const usage = summarizeUsage(events, 'requested');
  assert.equal(usage.requestedModel, 'requested');
  assert.deepEqual(usage.observedModels, ['actual']);
  assert.equal(usage.turns.length, 2);
  assert.deepEqual(usage.totals, {
    inputTokens: 15,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  });
  assert.equal(usage.nativeResults[0].cliEstimatedCostUsd, 0.04);
  assert.deepEqual(usage.nativeResults[0].usage, { input_tokens: 15 });
  assert.equal(usage.providerBilledCostUsd, null);
});

test('partly missing counters stay unknown without hiding observed positive cache reads', () => {
  const usage = summarizeUsage(
    [
      { type: 'assistant', message: { id: 'one', usage: { cache_read_input_tokens: 60 } } },
      { type: 'assistant', message: { id: 'two', usage: { input_tokens: 0 } } },
      { ...success, usage: { cache_read_input_tokens: 0 }, total_cost_usd: 0 },
    ],
    'requested',
  );
  assert.equal(usage.totals.cacheReadInputTokens, 0);
  assert.equal(usage.assistantObservations.completeness, 'partial');
  assert.equal(usage.turns[0].cacheReadInputTokens, 60);
  assert.equal(usage.nativeResults[0].cliEstimatedCostUsd, 0);
});

test('terminal native output usage supersedes partial assistant counters', () => {
  const usage = summarizeUsage(
    [
      {
        type: 'assistant',
        message: { id: 'partial', usage: { output_tokens: 179, cache_read_input_tokens: 60 } },
      },
      { ...success, usage: { output_tokens: 4355, cache_read_input_tokens: 64524 } },
    ],
    'requested',
  );
  assert.equal(usage.totals.outputTokens, 4355);
  assert.equal(usage.totals.cacheReadInputTokens, 64524);
  assert.equal(usage.assistantObservations.sums.outputTokens, 179);
  assert.equal(usage.assistantObservations.completeness, 'partial');
  assert.equal(usage.totalsSource, 'terminal_native_result');
});

test('retained files preserve bytes and reject symlink escapes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'eval-actor-files-'));
  try {
    await mkdir(join(workspace, 'nested'));
    await writeFile(join(workspace, 'nested', 'attachment.txt'), Buffer.from([0, 255, 10, 65]));
    assert.deepEqual(await collectFiles(workspace), {
      'nested/attachment.txt': Buffer.from([0, 255, 10, 65]).toString('base64'),
    });
    await symlink('/etc/passwd', join(workspace, 'escape'));
    await assert.rejects(collectFiles(workspace), /Unsupported actor output/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test(
  'actor invocation refuses execution without root',
  { skip: process.getuid?.() === 0 },
  async () => {
    await assert.rejects(
      runActor({
        prompt: 'offline',
        model: 'synthetic',
        proxyUrl: 'http://127.0.0.1:1/llm',
        mcpUrl: 'http://127.0.0.1:1/mcp',
        output: '/tmp/not-created',
      }),
      /requires root/,
    );
  },
);

test(
  'OS identity probe denies protected source, outside canary and parent environment',
  { skip: process.getuid?.() !== 0 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-actor-isolation-'));
    const workspace = join(directory, 'workspace');
    const output = join(directory, 'evidence');
    const checkout = join(directory, 'checkout');
    try {
      await chmod(directory, 0o711);
      await mkdir(workspace, { mode: 0o700 });
      await chown(workspace, 61337, 61337);
      await mkdir(output, { mode: 0o700 });
      await mkdir(checkout, { mode: 0o700 });
      const source = join(checkout, 'source.ts');
      const outside = join(output, 'outside-canary');
      await writeFile(source, 'synthetic source', { mode: 0o644 });
      await writeFile(outside, 'synthetic protected value', { mode: 0o600 });
      const probe = await probeIsolation({ workspace, output, protectedPaths: [source, outside] });
      assert.equal(probe.workspace, true);
      assert.deepEqual(probe.groups, [61337]);
      assert.ok(probe.denied.every((path) => path.denied));
      assert.equal(probe.denied.length, 3);
      assert.deepEqual(JSON.parse(await readFile(join(output, 'isolation.json'), 'utf8')), probe);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
