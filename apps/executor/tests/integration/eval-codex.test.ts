import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import test from 'node:test';
import {
  CODEX_CLI_VERSION,
  codexConfiguration,
  codexLaunchArguments,
  codexRequestHashes,
  parseCodexTranscript,
  summarizeCodexUsage,
  validateCodexInput,
  validateCodexOutput,
} from '../eval/codex.ts';
import { responsesHarness } from '../support/relay.ts';

import { MODEL, exec, spawn, message, terminal, stream } from '../support/native-codex.ts';

function nativePayload() {
  return {
    model: MODEL,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: false,
    prompt_cache_key: 'native-session-cache-key',
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              { type: 'custom', name: 'exec', description: 'Synthetic JS runner' },
              { type: 'function', name: 'wait', parameters: { type: 'object' } },
            ],
          },
          {
            type: 'namespace',
            name: 'collaboration',
            tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
          },
        ],
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Stable native instructions' }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task' }] },
    ] as any[],
  };
}

test('native Codex configuration preserves native host mechanics without user credentials or retries', () => {
  const config = codexConfiguration({
    model: MODEL,
    mcpUrl: 'http://127.0.0.1:1/mcp',
    proxyUrl: 'http://127.0.0.1:1/llm/',
    systemPrompt: 'Trusted caller instructions',
  });
  assert.equal(CODEX_CLI_VERSION, '0.166.0');
  for (const value of [
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
    'shell_tool = false',
    'unified_exec = false',
    'mcp_2026_07_28 = true',
    'sandbox_mode = "workspace-write"',
    'exclude_slash_tmp = true',
    'exclude_tmpdir_env_var = true',
    'approval_policy = "never"',
    'env_key = "CODEX_EVAL_RELAY_KEY"',
    'base_url = "http://127.0.0.1:1/llm/v1"',
    'enabled_tools = ["describe", "execute"]',
    '[mcp_servers.google.tools.execute]\napproval_mode = "approve"',
  ])
    assert.ok(config.includes(value), value);
  assert.ok(!config.includes('model_instructions_file'));
  assert.deepEqual(codexLaunchArguments('/tmp/task'), [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    '-C',
    '/tmp/task',
    '-',
  ]);
});

test('native Codex transcript separates execution, aggregate usage and unknown served identity', () => {
  const events = [
    { type: 'thread.started', thread_id: 'synthetic-thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 },
    },
  ];
  const text = events.map((event) => JSON.stringify(event)).join('\n');
  const parsed = parseCodexTranscript(text, 0);
  assert.equal(parsed.transcript.valid, true);
  const usage = summarizeCodexUsage(parsed.native, MODEL);
  assert.deepEqual(usage.observedModels, []);
  assert.equal(usage.modelIdentitySource, 'trusted_relay_required');
  assert.equal(usage.totalsSource, 'terminal_native_codex_turn');
  assert.deepEqual(usage.totals, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: null,
    reasoningOutputTokens: null,
  });
  for (const candidate of [
    '',
    '[]',
    text + '\nnull',
    text + '\n' + JSON.stringify(events[2]),
    text + '\n' + JSON.stringify({ type: 'turn.failed' }),
    text + '\n' + JSON.stringify({ type: 'error', message: 'Failed' }),
  ])
    assert.equal(parseCodexTranscript(candidate, 0).transcript.valid, false);
  assert.equal(parseCodexTranscript(text, 1).transcript.valid, false);
  assert.equal(parseCodexTranscript(text, null, true).transcript.valid, false);
  assert.equal(summarizeCodexUsage([], MODEL).totals.inputTokens, null);
  assert.equal(summarizeCodexUsage([...events, events[2]], MODEL).totals.inputTokens, null);
});

test('native Codex history and hashes retain actual developer declarations and self-contained outputs', () => {
  const payload = nativePayload();
  payload.input.push(
    { type: 'reasoning', summary: [], encrypted_content: 'opaque-reasoning' },
    exec('text(1);'),
    {
      type: 'custom_tool_call_output',
      call_id: 'call-exec',
      output: [{ type: 'input_text', text: '1' }],
    },
    {
      type: 'function_call',
      namespace: 'functions',
      name: 'wait',
      call_id: 'wait-one',
      arguments: '{"cell_id":"one"}',
    },
    { type: 'function_call_output', call_id: 'wait-one', output: 'Done' },
  );
  validateCodexInput(payload);
  const hashes = codexRequestHashes(payload);
  assert.equal(hashes.promptCacheKey, payload.prompt_cache_key);
  assert.equal(hashes.prefixSource, 'native_developer_messages_and_additional_tools');
  assert.match(hashes.systemHash, /^[a-f0-9]{64}$/);
  assert.match(hashes.toolsHash, /^[a-f0-9]{64}$/);
  const instructions = structuredClone(payload);
  instructions.input[1].content[0].text = 'Changed native instructions';
  assert.notEqual(codexRequestHashes(instructions).systemHash, hashes.systemHash);
  const declarations = structuredClone(payload);
  declarations.input[0].tools[0].tools[0].description = 'Changed tools';
  assert.notEqual(codexRequestHashes(declarations).toolsHash, hashes.toolsHash);
  for (const patch of [
    { store: true },
    { previous_response_id: 'remote' },
    { conversation: 'remote' },
    { background: true },
    { stream: false },
    { parallel_tool_calls: true },
    { include: [] },
    { tools: [{ type: 'web_search' }] },
    { input: [{ type: 'item_reference', id: 'remote' }] },
    { input: [...nativePayload().input, spawn] },
    {
      input: [
        ...nativePayload().input,
        {
          type: 'custom_tool_call_output',
          call_id: 'one',
          output: [{ type: 'input_image', image_url: 'remote' }],
        },
      ],
    },
  ])
    assert.throws(() => validateCodexInput({ ...payload, ...patch }));
  const unknown = nativePayload();
  unknown.input[0].tools[0].tools.push({ type: 'function', name: 'exec_command' });
  assert.throws(() => validateCodexInput(unknown), /declaration/);
});

test('native Codex output checks every transient and terminal executable item before delivery', () => {
  validateCodexOutput(
    [{ type: 'response.completed', response: terminal('allowed', [exec('text(1)')]) }],
    true,
  );
  const wait = {
    type: 'function_call',
    namespace: 'functions',
    name: 'wait',
    call_id: 'wait',
    arguments: '{}',
  };
  validateCodexOutput([terminal('wait', [wait])], false);
  for (const namespace of [undefined, null]) {
    const unqualified = { ...exec('text(1)'), namespace };
    validateCodexOutput([terminal('unqualified', [unqualified])], false);
    validateCodexOutput([terminal('unqualified-wait', [{ ...wait, namespace }])], false);
    const history = nativePayload();
    history.input.push(unqualified);
    validateCodexInput(history);
  }
  for (const item of [
    spawn,
    { ...spawn, namespace: undefined },
    { ...spawn, namespace: null },
    { ...exec('text(1)'), type: 'function_call', arguments: '{}' },
    { ...wait, type: 'custom_tool_call', input: '{}' },
    ...['collaboration', 'other', '', 42].map((namespace) => ({ ...exec('text(1)'), namespace })),
    { ...exec('text(1)'), call_id: '' },
    { ...exec('text(1)'), call_id: undefined },
    { ...exec('text(1)'), name: 'other' },
    { type: 'web_search_call' },
    { type: 'computer_call' },
  ]) {
    for (const events of [
      [
        { type: 'response.output_item.added', item },
        { type: 'response.completed', response: terminal() },
      ],
      [
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: terminal() },
      ],
      [{ type: 'response.completed', response: terminal('mixed', [exec('text(1)'), item]) }],
    ])
      assert.throws(() => validateCodexOutput(events, true));
  }
});

const relayHarness = (respond: (response: ServerResponse) => void) =>
  responsesHarness((_body, response) => respond(response), nativePayload(), true);

test('native Codex relay withholds mixed or transient forbidden calls and keeps usage reservations', async () => {
  for (const transientOnly of [false, true]) {
    const gate = await relayHarness((response) =>
      stream(response, terminal('mixed', transientOnly ? [message] : [exec('text(1)'), spawn]), [
        exec('text(1)'),
        spawn,
      ]),
    );
    try {
      const response = await gate.invoke();
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.ok(!body.includes('spawn_agent'));
      assert.ok(!body.includes('text(1)'));
      assert.equal(gate.upstream.length, 1);
      const receipt = gate.receipts[0];
      assert.equal(receipt.error, 'native_executable_output_refused');
      assert.equal(receipt.nativeOutputRefused, true);
      assert.equal(receipt.settlementEligible, false);
      assert.equal(receipt.refundUsd, 0);
      assert.equal(receipt.heldUsd, receipt.reservationUsd);
      assert.equal(receipt.rawUsage.output_tokens, 10);
      assert.equal(receipt.promptCacheKey, 'native-session-cache-key');
    } finally {
      await gate.close();
    }
  }
});

test('native Codex relay accepts the native prefix and retains actual cache/usage without changing custom validation', async () => {
  const gate = await relayHarness((response) => stream(response, terminal()));
  try {
    const response = await gate.invoke();
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
    const receipt = gate.receipts[0];
    assert.equal(receipt.complete, true);
    assert.equal(receipt.settlementEligible, true);
    assert.equal(receipt.cacheReadInputTokens, 20);
    assert.equal(receipt.prefixSource, 'native_developer_messages_and_additional_tools');
    assert.equal(receipt.promptCacheKey, 'native-session-cache-key');
  } finally {
    await gate.close();
  }
});
