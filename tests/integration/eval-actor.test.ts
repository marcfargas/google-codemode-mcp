import assert from 'node:assert/strict';
import {
  chown,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  actorLaunchArguments,
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

// Opt-in because credential-free CI does not install the native CLI. Every HTTP
// response here is synthetic loopback data; no provider or Google is contacted.
test(
  'pinned native CLI advertises Write, writes task bytes and rejects an outside path',
  { skip: !process.env.EVAL_NATIVE_CLI, timeout: 30_000 },
  async () => {
    const executable = process.env.EVAL_NATIVE_CLI!;
    assert.ok(
      executable.startsWith('/') && !executable.includes('cpa'),
      'Use an absolute native CLI path; proxy wrappers are forbidden for this offline test',
    );
    assert.ok(
      !(await realpath(executable)).includes('cpa'),
      'Native CLI must not resolve to a proxy wrapper',
    );
    assert.equal(
      spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(),
      '2.1.318 (Claude Code)',
    );
    const root = await mkdtemp(join(tmpdir(), 'eval-native-write-'));
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    await mkdir(workspace);
    await mkdir(home);
    await mkdir(join(home, 'tmp'));
    const requests: any[] = [];
    const destination = join(workspace, 'attachment.txt');
    const outside = join(root, 'outside.txt');
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw);
      requests.push(payload);
      const number = requests.length;
      const tool = number <= 2;
      const input = {
        file_path: number === 1 ? destination : outside,
        content: 'Synthetic attachment\n',
      };
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: `offline-${number}`,
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-5-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 0,
            content_block: tool
              ? { type: 'tool_use', id: `write-${number}`, name: 'Write', input: {} }
              : { type: 'text', text: '' },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: tool
              ? { type: 'input_json_delta', partial_json: JSON.stringify(input) }
              : { type: 'text_delta', text: 'Offline probe finished.' },
          },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: 10 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [event, data] of events)
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const args = actorLaunchArguments({
      model: 'claude-haiku-5-5',
      workspace,
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    });
    // No MCP service is needed to isolate native file-tool behavior.
    args[args.indexOf('--mcp-config') + 1] = '{"mcpServers":{}}';
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(executable, args, {
        cwd: workspace,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          TMPDIR: join(home, 'tmp'),
          ANTHROPIC_API_KEY: 'synthetic-no-secret',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_MAX_RETRIES: '0',
        },
      });
      let stdout = '',
        stderr = '';
      child.stdout!.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin!.end('Synthetic native file-tool integration check.');
      const timeout = setTimeout(() => child?.kill('SIGKILL'), 20_000);
      const exit = await new Promise<number | null>((done, fail) => {
        child!.on('error', fail);
        child!.on('close', done);
      });
      clearTimeout(timeout);
      assert.equal(exit, 0, stderr);
      const transcript = parseTranscript(stdout, exit);
      assert.equal(transcript.transcript.valid, true, JSON.stringify(transcript.transcript.errors));
      const init = transcript.native.find(
        (event: any) => event.type === 'system' && event.subtype === 'init',
      ) as any;
      assert.ok(init.tools.includes('Write'), 'Write must be advertised in native init');
      assert.ok(
        requests[0].tools.some((tool: any) => tool.name === 'Write'),
        'Write must reach model tool schema',
      );
      assert.equal(await readFile(destination, 'utf8'), 'Synthetic attachment\n');
      await assert.rejects(readFile(outside), /ENOENT/);
      assert.equal(requests.length, 3);
      const toolResults = requests.flatMap((request) =>
        request.messages.flatMap((message: any) =>
          Array.isArray(message.content)
            ? message.content.filter((block: any) => block.type === 'tool_result')
            : [],
        ),
      );
      assert.ok(
        toolResults.some((block: any) => block.tool_use_id === 'write-1' && !block.is_error),
        'Workspace write must execute',
      );
      assert.ok(
        toolResults.some((block: any) => block.tool_use_id === 'write-2' && block.is_error),
        'Outside write must be denied',
      );
    } finally {
      child?.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

// This invokes the exact bundled child under its separate UID, only in act/root.
// All model and MCP responses are synthetic; no provider or Google is contacted.
test(
  'isolated Responses actor runs bundled MCP/resource/file tools with no credentials',
  { skip: process.getuid?.() !== 0, timeout: 30_000 },
  async () => {
    const { handleMcp } = await import('../../src/protocol.ts');
    const directory = await mkdtemp(join(tmpdir(), 'eval-responses-isolated-'));
    const audit: any[] = [];
    const modelRequests: any[] = [];
    const outside = join(directory, 'outside.txt');
    const workspaceFile = '/tmp/google-mcp-actor/attachment.txt';
    const calls = [
      [
        {
          name: 'ReadMcpResourceTool',
          arguments: {
            server: 'google',
            uri: 'skill://google-codemode-mcp/google-workspace/SKILL.md',
          },
        },
      ],
      [{ name: 'mcp__google__describe', arguments: {} }],
      [
        {
          name: 'mcp__google__execute',
          arguments: { accessToken: 'injected-by-eval-caller', code: 'return {};' },
        },
      ],
      [
        { name: 'Write', arguments: { file_path: outside, content: 'forbidden' } },
        { name: 'Read', arguments: { file_path: join(process.cwd(), 'tests/eval/gmail.ts') } },
        { name: 'Write', arguments: { file_path: workspaceFile, content: 'Café — 東京 ✓\n' } },
      ],
      [],
    ];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (request.url === '/mcp') {
        const rpc = JSON.parse(raw);
        audit.push(rpc);
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        const result = await handleMcp(
          new Request('http://localhost/mcp', { method: 'POST', headers, body: raw }),
          {
            snippets: [],
            describe: async () => ({ services: ['gmail/v1'] }),
            execute: async () => ({
              outcomes: [],
              outcomesComplete: true,
              hasUnknownOutcome: false,
            }),
            runSnippet: async () => ({}),
          },
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
        return;
      }
      assert.equal(request.url, '/llm/v1/responses');
      const payload = JSON.parse(raw);
      modelRequests.push(payload);
      const number = modelRequests.length;
      const output = calls[number - 1].map((call, index) => ({
        type: 'function_call',
        id: `fc-${number}-${index}`,
        call_id: `call-${number}-${index}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        status: 'completed',
      }));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `response-${number}`,
          model: 'gpt-6.1-terra',
          status: 'completed',
          output,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    try {
      const actor = await runActor({
        runner: 'responses',
        model: 'gpt-6.1-terra',
        prompt: 'Synthetic file and MCP preflight.',
        output: directory,
        mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
        proxyUrl: `http://127.0.0.1:${address.port}/llm`,
      });
      assert.equal(actor.exitCode, 0, await readFile(join(directory, 'performer.stderr'), 'utf8'));
      assert.equal(actor.transcript.valid, true, JSON.stringify(actor.transcript));
      assert.equal(
        Buffer.from(actor.files['attachment.txt'], 'base64').toString('utf8'),
        'Café — 東京 ✓\n',
      );
      await assert.rejects(readFile(outside), /ENOENT/);
      assert.ok(audit.some((rpc) => rpc.method === 'server/discover'));
      assert.ok(audit.some((rpc) => rpc.method === 'resources/read'));
      assert.ok(audit.some((rpc) => rpc.method === 'tools/call' && rpc.params.name === 'execute'));
      const outputs = modelRequests
        .at(-1)
        .input.filter((item: any) => item.type === 'function_call_output')
        .map((item: any) => JSON.parse(item.output));
      assert.ok(
        outputs.filter((item: any) => item.isError).length >= 2,
        'Outside read/write denied',
      );
      assert.ok(
        modelRequests.every((request) =>
          request.tools.every(
            (tool: any) =>
              tool.type === 'function' && !/Bash|exec_command|Agent|Task/.test(tool.name),
          ),
        ),
      );
      assert.equal(actor.usage.totals.outputTokens, 100);
      const launch = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'));
      assert.equal(launch.environment.CPA_CLIENT_API_KEY, undefined);
      assert.equal(launch.uid, 61337);
      assert.match(launch.runnerSha256, /^[a-f0-9]{64}$/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
