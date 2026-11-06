import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { listen, closeServer } from '../support/relay.ts';
import { spawn, spawnSync } from 'node:child_process';
import { actorLaunchArguments, parseTranscript } from '../eval/actor.ts';

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
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr || version.error?.message);
    assert.equal(version.stdout.trim(), '2.1.318 (Claude Code)');
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
    const url = await listen(server);
    const args = actorLaunchArguments({
      model: 'claude-haiku-5-5',
      workspace,
      mcpUrl: url + '/mcp',
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
          ANTHROPIC_BASE_URL: url,
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
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  },
);
