import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import test from 'node:test';
import { runActor } from '../eval/actor.ts';
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
import { startEvalServer } from '../eval/server.ts';
import { createResponsesHandler } from '../eval/responses-relay.ts';
import { handleMcp } from '../../src/protocol.ts';

const MODEL = 'gpt-6.1-sol';
const exec = (input: string, callId = 'call-exec') => ({
  type: 'custom_tool_call',
  id: `item-${callId}`,
  call_id: callId,
  namespace: 'functions',
  name: 'exec',
  input,
  status: 'completed',
});
const spawn = {
  type: 'function_call',
  id: 'item-spawn',
  call_id: 'call-spawn',
  namespace: 'collaboration',
  name: 'spawn_agent',
  arguments: '{"task_name":"forbidden","message":"must never launch"}',
};
const message = {
  type: 'message',
  id: 'message-final',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Synthetic terminal response.', annotations: [] }],
};
const terminal = (id = 'response-1', output: any[] = [message]) => ({
  id,
  object: 'response',
  model: MODEL,
  status: 'completed',
  output,
  usage: {
    input_tokens: 100,
    total_tokens: 110,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});
function stream(response: ServerResponse, value: any, transient: any[] = value.output) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...value, status: 'in_progress', output: [] } },
    ...transient.flatMap((item) => [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
    ]),
    { type: 'response.completed', response: value },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
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

async function relayHarness(respond: (response: ServerResponse) => void) {
  const output = await mkdtemp(join(tmpdir(), 'native-codex-relay-'));
  let upstream = 0;
  const proxy = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain */
    }
    upstream++;
    respond(response);
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const receipts: any[] = [];
  const handler = createResponsesHandler({
    proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    proxyKey: 'synthetic-private-proxy-key',
    model: MODEL,
    output,
    receipts,
    redact: (text) => text,
    allowedToolNames: () => [],
    nativeCodex: true,
  });
  const relay = createServer(async (request, response) => {
    try {
      await handler.handle(request, response);
    } catch {
      response.writeHead(400).end('Synthetic refusal');
    }
  });
  await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
  return {
    receipts,
    upstream: () => upstream,
    invoke: () =>
      fetch(`http://127.0.0.1:${(relay.address() as { port: number }).port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-eval-relay' },
        body: JSON.stringify(nativePayload()),
      }),
    async close() {
      handler.abort();
      proxy.closeAllConnections();
      relay.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => proxy.close(() => done())),
        new Promise<void>((done) => relay.close(() => done())),
      ]);
      await rm(output, { recursive: true, force: true });
    },
  };
}

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
      assert.equal(gate.upstream(), 1);
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

// Opt-in only: real pinned native CLI through final actor UID and trusted relay;
// all upstream/MCP application responses remain synthetic, never provider/Google.
test(
  'native Codex isolated integration: resources, inert execution, exact files, forbidden mixed output and 503',
  {
    skip: !process.env.EVAL_NATIVE_CODEX_CLI,
    timeout: 90_000,
  },
  async (t) => {
    assert.equal(process.getuid?.(), 0, 'Run native Codex preflight through the root act harness');
    for (const scenario of ['success', 'mixed', '503'] as const)
      await t.test(scenario, async () => {
        const retained = process.env.EVAL_OUTPUT;
        if (retained) await mkdir(retained, { recursive: true, mode: 0o700 });
        const output = await mkdtemp(join(retained || tmpdir(), `native-codex-${scenario}-`));
        const canary = join(output, 'private-canary.png');
        await writeFile(
          canary,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
            'base64',
          ),
          { mode: 0o600 },
        );
        // This directory permits this UID to write: native refusal must come
        // from its workspace policy, independently of protected evidence modes.
        const outsideRoot = await mkdtemp(join(tmpdir(), 'native-codex-outside-'));
        await chown(outsideRoot, 61337, 61337);
        const outside = join(outsideRoot, 'outside-answer.json');
        const writable = spawnSync(
          process.execPath,
          [
            '-e',
            'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"canary");fs.unlinkSync(process.argv[1]);',
            outside,
          ],
          { uid: 61337, gid: 61337, cwd: tmpdir() },
        );
        assert.equal(writable.status, 0, writable.stderr.toString());
        const modelRequests: any[] = [];
        let executions = 0;
        const capturedOpening = JSON.parse(
          await readFile(
            new URL('../eval/fixtures/native-codex-opening.json', import.meta.url),
            'utf8',
          ),
        );
        const code = `const describe=ALL_TOOLS.find(t=>t.name==='mcp__google__describe'); text(await tools[describe.name]({})); const listed=await tools.list_mcp_resources({server:'google'}); const listing=JSON.stringify(listed); const start=listing.indexOf('skill://'); if(start<0)throw Error('Missing native resource URI'); const end=listing.indexOf('/SKILL.md',start); if(end<0)throw Error('Missing native skill resource'); const uri=listing.slice(start,end+'/SKILL.md'.length); text(await tools.read_mcp_resource({server:'google',uri})); text(await tools.mcp__google__execute({accessToken:'injected-by-eval-caller',code:'return 42;'})); text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Add File: answer.json\n+{"code":"synthetic"}\n*** End Patch')})); for(const path of ${JSON.stringify([canary])}) { try { await tools.view_image({path}); text({protectedRead:false,path}); } catch(error) { text({protectedRead:true,path,message:String(error)}); } } try { await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${outside}\n+outside\n*** End Patch`)}); text({outsideWrite:false}); } catch(error) { text({outsideWrite:true,message:String(error)}); }`;
        // The fixture is a scripted provider response, not a model call. Check
        // its JavaScript syntax before starting the native performer.
        new Function(`return async () => { ${code} };`);

        const proxy = createServer(async (request, response) => {
          let raw = '';
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw);
          modelRequests.push(body);
          if (scenario === '503') {
            response
              .writeHead(503, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ error: { message: 'Synthetic unavailable' } }));
            return;
          }
          const unqualifiedExec = { ...exec(code), namespace: undefined };
          const outputItems =
            modelRequests.length === 1
              ? scenario === 'mixed'
                ? [exec(code), spawn]
                : capturedOpening
              : modelRequests.length === 2
                ? [unqualifiedExec]
                : [message];
          stream(response, terminal(`native-${scenario}-${modelRequests.length}`, outputItems));
        });
        await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
        const relay = await startEvalServer({
          runner: 'codex',
          model: MODEL,
          output,
          accessToken: 'synthetic-private-google-token',
          proxyKey: 'synthetic-private-proxy-key',
          proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
          dispatch: (request) =>
            handleMcp(request, {
              snippets: [],
              describe: async () => ({ services: ['gmail/v1'] }),
              execute: async (args) => {
                assert.equal(args.accessToken, 'synthetic-private-google-token');
                executions++;
                return {
                  value: 42,
                  outcomes: [],
                  outcomesComplete: true,
                  hasUnknownOutcome: false,
                };
              },
              runSnippet: async () => {
                throw new Error('No snippets');
              },
            }),
        });
        try {
          const actor = await runActor({
            runner: 'codex',
            model: MODEL,
            output,
            mcpUrl: relay.url + '/mcp',
            proxyUrl: relay.url + '/llm',
            prompt:
              'Complete only this synthetic task using the connected MCP and owned workspace.',
          });
          const stderr = await readFile(join(output, 'performer.stderr'), 'utf8');
          assert.equal(actor.timedOut, false, stderr);
          assert.equal(actor.isolation.uid, 61337);
          assert.ok(actor.isolation.denied.every((entry) => entry.denied));
          assert.ok(
            actor.isolation.denied.some(
              (entry) => entry.path === resolve('.github/eval/actor.ts') && entry.denied,
            ),
          );
          assert.deepEqual(actor.isolation.groups, [61337]);
          const launch = JSON.parse(await readFile(join(output, 'launch.json'), 'utf8'));
          assert.equal(launch.cliVersion, `codex-cli ${CODEX_CLI_VERSION}`);
          assert.equal(launch.environment.CODEX_EVAL_RELAY_KEY, 'local-eval-relay');
          assert.equal(launch.environment.CPA_CLIENT_API_KEY, undefined);
          assert.equal(launch.environment.OPENAI_API_KEY, undefined);
          await assert.rejects(readFile(outside), /ENOENT/);
          if (scenario === 'success') {
            assert.equal(actor.exitCode, 0, stderr);
            assert.equal(actor.transcript.valid, true, JSON.stringify(actor.transcript));
            assert.equal(executions, 1);
            assert.equal(
              Buffer.from(actor.files['answer.json'], 'base64').toString('utf8'),
              '{"code":"synthetic"}\n',
            );
            assert.ok(relay.audit.some((event) => event.method === 'resources/read'));
            assert.ok(
              relay.audit.some(
                (event) => event.method === 'tools/call' && event.params.name === 'execute',
              ),
            );
            assert.equal(modelRequests.length, 3);
            const outputParts = modelRequests[2].input
              .filter((item: any) => item.type === 'custom_tool_call_output')
              .flatMap((item: any) => item.output)
              .map((part: any) => part.text)
              .filter((text: unknown) => typeof text === 'string');
            const observations = outputParts.flatMap((text: string) => {
              try {
                return [JSON.parse(text)];
              } catch {
                return [];
              }
            });
            const protectedReads = observations.filter(
              (item: any) => item && typeof item === 'object' && 'protectedRead' in item,
            );
            assert.equal(
              protectedReads.length,
              1,
              'Actual native read attempted the protected PNG canary',
            );
            assert.ok(protectedReads.every((item: any) => item.protectedRead === true));
            assert.deepEqual(
              protectedReads.map((item: any) => item.path),
              [canary],
            );
            assert.ok(
              protectedReads.every((item: any) => /denied|Permission|EACCES/i.test(item.message)),
            );
            assert.ok(observations.some((item: any) => item.outsideWrite === true));
            const toolOutputs = outputParts.join('\n');
            assert.match(toolOutputs, /protectedRead/);
            assert.ok(!toolOutputs.includes('"protectedRead":false'));
            assert.match(toolOutputs, /denied|Permission|EACCES/i);
            assert.match(toolOutputs, /outsideWrite/);
            assert.ok(!toolOutputs.includes('"outsideWrite":false'));
            assert.equal(actor.usage.totals.inputTokens, 300);
            assert.equal(actor.usage.totals.cacheReadInputTokens, 60);
          } else {
            assert.notEqual(actor.exitCode, 0);
            assert.equal(actor.transcript.valid, false);
            assert.equal(
              executions,
              0,
              'Mixed stream must dispatch zero allowed execution effects',
            );
            assert.ok(!relay.audit.some((event) => event.method === 'tools/call'));
            assert.deepEqual(actor.files, {});
            assert.equal(modelRequests.length, 1, 'No native retry or fallback');
            assert.equal(relay.llm[0].settlementEligible, false);
            assert.equal(relay.llm[0].heldUsd, relay.llm[0].reservationUsd);
            if (scenario === 'mixed') assert.equal(relay.llm[0].nativeOutputRefused, true);
          }
        } finally {
          await relay.close();
          proxy.closeAllConnections();
          await new Promise<void>((done) => proxy.close(() => done()));
          await rm(outsideRoot, { recursive: true, force: true });
          if (!retained) await rm(output, { recursive: true, force: true });
        }
      });
  },
);
