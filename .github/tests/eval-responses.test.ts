import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleMcp, type ProtocolApp } from '../../src/protocol.ts';
import {
  createWorkspaceFiles,
  parseResponsesBody,
  parseResponsesTranscript,
  runResponsesLoop,
  summarizeResponsesUsage,
} from '../eval/responses.ts';

type Value = Record<string, any>;
const skillUri = 'skill://google-codemode-mcp/google-workspace/SKILL.md';
const call = (name: string, args: Value, id: string) => ({
  type: 'function_call',
  id: `item-${id}`,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});
const completed = (output: Value[], id = 'response-1') => ({
  id,
  object: 'response',
  model: 'gpt-6.1-terra',
  status: 'completed',
  output,
  usage: {
    input_tokens: 30,
    output_tokens: 12,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 4 },
  },
});

async function harness(
  responder: (payload: Value, index: number, workspace: string) => { body: unknown; sse?: boolean },
) {
  const directory = await mkdtemp(join(tmpdir(), 'eval-responses-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const mcp: Value[] = [],
    requests: Value[] = [],
    application: Value[] = [],
    events: Value[] = [];
  const app: ProtocolApp = {
    snippets: [
      {
        name: 'test',
        description: 'Synthetic deployment snippet',
        services: ['gmail/v1'],
        scopes: [],
        code: 'return inputs;',
        inputSchema: {
          type: 'object',
          properties: { optional: { type: 'string' } },
          additionalProperties: false,
        },
        tool: { name: 'gmail_fixture' },
      },
    ],
    describe: async (args) => {
      application.push({ name: 'describe', args });
      return { synthetic: true };
    },
    execute: async (args) => {
      application.push({ name: 'execute', args });
      return { result: args.inputs, outcomes: [], hasUnknownOutcome: false };
    },
    runSnippet: async (_name, args) => ({
      result: args.inputs,
      outcomes: [],
      hasUnknownOutcome: false,
    }),
  };
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const payload = raw ? JSON.parse(raw) : {};
      if (request.url === '/mcp') {
        mcp.push({
          ...payload,
          protocolHeader: request.headers['mcp-protocol-version'],
          method: payload.method,
        });
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        const result = await handleMcp(
          new Request('http://localhost/mcp', {
            method: request.method,
            headers,
            ...(request.method === 'POST' ? { body: raw } : {}),
          }),
          app,
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
        return;
      }
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer local-eval-relay');
      requests.push(payload);
      const result = responder(payload, requests.length, workspace);
      response.writeHead(200, {
        'Content-Type': result.sse ? 'text/event-stream' : 'application/json',
      });
      response.end(
        result.sse
          ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: result.body })}\n\n`
          : JSON.stringify(result.body),
      );
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    directory,
    workspace,
    requests,
    mcp,
    application,
    events,
    run: () =>
      runResponsesLoop({
        model: 'gpt-6.1-terra',
        mcpUrl: url + '/mcp',
        proxyUrl: url,
        workspace,
        systemPrompt: 'Generic caller instructions',
        prompt: 'Synthetic user task',
        emit: (event) => events.push(event),
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Responses runner uses actual MCP resources and exact tool schemas, preserves reasoning history, and writes exact UTF-8 bytes', async () => {
  const reasoning = {
    type: 'reasoning',
    id: 'reasoning-1',
    summary: [],
    encrypted_content: 'synthetic-preserved-reasoning',
  };
  const text = 'Random attachment\nCafé — 東京 ✓\n';
  const fixture = await harness((_payload, index, workspace) => {
    const outputs: Value[][] = [
      [reasoning, call('ListMcpResourcesTool', {}, 'list')],
      [call('ReadMcpResourceTool', { server: 'google', uri: skillUri }, 'skill')],
      [
        call(
          'mcp__google__execute',
          {
            accessToken: 'injected-by-eval-caller',
            code: 'return inputs;',
            inputs: { fixture: 'synthetic' },
          },
          'execute',
        ),
      ],
      [call('Write', { file_path: join(workspace, 'attachment.txt'), content: text }, 'write')],
      [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Completed synthetic task.' }],
        },
      ],
    ];
    return { body: completed(outputs[index - 1], `response-${index}`), sse: index % 2 === 0 };
  });
  try {
    await fixture.run();
    assert.equal(await readFile(join(fixture.workspace, 'attachment.txt'), 'utf8'), text);
    assert.deepEqual(fixture.application, [
      {
        name: 'execute',
        args: {
          accessToken: 'injected-by-eval-caller',
          code: 'return inputs;',
          inputs: { fixture: 'synthetic' },
        },
      },
    ]);
    assert.ok(fixture.mcp.every((request) => request.protocolHeader === '2026-07-28'));
    assert.ok(fixture.mcp.some((request) => request.method === 'server/discover'));
    assert.ok(
      fixture.mcp.some(
        (request) => request.method === 'resources/read' && request.params.uri === skillUri,
      ),
    );
    assert.ok(!fixture.mcp.some((request) => request.method === 'initialize'));
    assert.equal(fixture.requests[0].tools.length, 7);
    const execute = fixture.requests[0].tools.find(
      (tool: Value) => tool.name === 'mcp__google__execute',
    );
    assert.equal(execute.strict, false);
    assert.deepEqual(execute.parameters.required, ['accessToken', 'code']);
    assert.ok(execute.parameters.properties.inputs);
    assert.ok(!execute.parameters.required.includes('inputs'));
    assert.equal(
      fixture.requests[0].tools.find((tool: Value) => tool.name === 'mcp__google__gmail_fixture')
        .parameters.additionalProperties,
      false,
    );
    assert.deepEqual(fixture.requests[1].input[1], reasoning);
    assert.deepEqual(
      fixture.requests[4].input
        .filter((item: Value) => item.type === 'function_call_output')
        .map((item: Value) => item.call_id),
      ['list', 'skill', 'execute', 'write'],
    );
    assert.ok(
      fixture.requests[2].input.some(
        (item: Value) =>
          item.type === 'function_call_output' &&
          item.output.includes('# Google Workspace Code Mode'),
      ),
    );
    for (const payload of fixture.requests) {
      assert.equal(payload.store, false);
      assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
      assert.equal(payload.parallel_tool_calls, false);
      assert.equal(payload.stream, false);
      assert.equal(payload.max_output_tokens, 2048);
      assert.deepEqual(payload.reasoning, { effort: 'low' });
      assert.equal(payload.prompt_cache_key, 'google-codemode-gmail-v1');
      assert.deepEqual(payload.tools, fixture.requests[0].tools);
    }
    const parsed = parseResponsesTranscript(
      fixture.events.map((event) => JSON.stringify(event)).join('\n'),
      0,
    );
    assert.equal(parsed.transcript.valid, true);
    const usage = summarizeResponsesUsage(parsed.native, 'gpt-6.1-terra');
    assert.deepEqual(usage.totals, {
      inputTokens: 150,
      outputTokens: 60,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: null,
      reasoningOutputTokens: 20,
    });
    assert.equal(usage.providerBilledCostUsd, null);
  } finally {
    await fixture.close();
  }
});

test('local file capabilities reject outside paths, symlink escapes, linked files and blind overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-response-files-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'protected synthetic fixture');
    await symlink(root, join(workspace, 'escape'));
    await symlink(outside, join(workspace, 'link.txt'));
    await link(outside, join(workspace, 'hard.txt'));
    const files = await createWorkspaceFiles(workspace);
    for (const path of [
      outside,
      join(workspace, '..', 'missing', 'new.txt'),
      join(workspace, 'escape', 'outside.txt'),
      join(workspace, 'link.txt'),
      join(workspace, 'hard.txt'),
    ]) {
      await assert.rejects(files.Read({ file_path: path }));
      await assert.rejects(files.Write({ file_path: path, content: 'do not change' }));
    }
    assert.equal(await readFile(outside, 'utf8'), 'protected synthetic fixture');
    const saved = join(workspace, 'nested', 'attachment.txt');
    await files.Write({ file_path: saved, content: 'Café\n' });
    await assert.rejects(
      files.Write({ file_path: saved, content: 'blind replacement' }),
      /Read an existing/,
    );
    assert.equal((await files.Read({ file_path: saved })).content, 'Café\n');
    await files.Write({ file_path: saved, content: 'Exact replacement\n' });
    assert.equal(await readFile(saved, 'utf8'), 'Exact replacement\n');
    await assert.rejects(files.Write({ file_path: 'relative.txt', content: 'x' }), /absolute/);
    await assert.rejects(files.Read({ file_path: saved, arbitrary: true }), /Unsupported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successful no-op transcript supplies only execution evidence and does not force discovery or skill reads', async () => {
  const fixture = await harness(() => ({ body: completed([]) }));
  try {
    await fixture.run();
    assert.deepEqual(fixture.application, []);
    assert.ok(!fixture.mcp.some((request) => request.method === 'resources/read'));
    assert.deepEqual(
      fixture.mcp.map((request) => request.method),
      ['server/discover', 'tools/list', 'resources/list'],
    );
    assert.equal(
      parseResponsesTranscript(fixture.events.map((event) => JSON.stringify(event)).join('\n'), 0)
        .transcript.valid,
      true,
    );
    assert.equal(parseResponsesTranscript('', 0).transcript.valid, false);
    assert.equal(parseResponsesTranscript('{bad', 1, true).transcript.valid, false);
    const missing = summarizeResponsesUsage(
      [
        { type: 'responses.response', response: completed([], 'missing') },
        {
          type: 'responses.response',
          response: { model: 'gpt-6.1-terra', status: 'completed', output: [] },
        },
      ],
      'gpt-6.1-terra',
    );
    assert.equal(missing.totals.inputTokens, null);
    assert.equal(missing.totals.cacheReadInputTokens, null);
  } finally {
    await fixture.close();
  }
});

for (const output of [
  [{ type: 'computer_call', id: 'unsupported' }],
  [call('Bash', { command: 'not exposed' }, 'bad')],
  [call('mcp__google__execute', {}, 'duplicate'), call('mcp__google__execute', {}, 'duplicate')],
])
  test('unsupported or duplicate tool requests fail closed before dispatch', async () => {
    const fixture = await harness(() => ({ body: completed(output) }));
    try {
      await assert.rejects(fixture.run(), /Unsupported|Unknown/);
      assert.deepEqual(fixture.application, []);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.events.at(-1)?.status, 'error');
    } finally {
      await fixture.close();
    }
  });

test('incomplete, missing terminal and failed Responses streams are rejected', () => {
  assert.throws(
    () => parseResponsesBody('data: {"type":"response.created"}\n\n', 'text/event-stream'),
    /terminal/,
  );
  assert.throws(
    () => parseResponsesBody('data: {"type":"response.failed"}\n\n', 'text/event-stream'),
    /failed/,
  );
  assert.throws(() => parseResponsesBody('data: {not json}\n\n', 'text/event-stream'));
});
