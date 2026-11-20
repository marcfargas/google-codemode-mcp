import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { listen, closeServer } from '../support/relay.ts';
import { runActor } from '../eval/actor.ts';

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
        {
          name: 'Read',
          arguments: { file_path: join(process.cwd(), 'apps/executor/tests/eval/gmail.ts') },
        },
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
          model: 'gpt-6.2-sol',
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
    const url = await listen(server);
    try {
      const actor = await runActor({
        runner: 'responses',
        model: 'gpt-6.2-sol',
        prompt: 'Synthetic file and MCP preflight.',
        output: directory,
        mcpUrl: url + '/mcp',
        proxyUrl: url + '/llm',
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
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
