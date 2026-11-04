import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startEvalServer, TOKEN_SENTINEL } from '../eval/server.ts';
import { gradeModel } from '../eval/run.ts';

test('agent relay injects tokens only at the trusted boundary and fences unknown writes across executions', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-relay-'));
  const requests: any[] = [];
  const relay = await startEvalServer({
    output,
    model: 'synthetic-model',
    accessToken: 'private-google-token',
    redactSecrets: ['private-access-secret'],
    proxyKey: 'private-proxy-key',
    proxyUrl: 'http://127.0.0.1:1',
    dispatch: async (request) => {
      const rpc = (await request.json()) as any;
      requests.push(rpc);
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          structuredContent: {
            hasUnknownOutcome: true,
            outcomesComplete: true,
            outcomes: [
              { path: 'gmail/v1/users.messages.send', mutation: true, outcome: 'unknown' },
            ],
            logs: ['private-google-token', 'private-access-secret'],
          },
        },
      });
    },
  });
  try {
    const invoke = (token: string) =>
      fetch(relay.url + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'MCP-Method': 'tools/call',
          'MCP-Name': 'execute',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'execute', arguments: { accessToken: token, code: 'return {};' } },
        }),
      });
    assert.equal((await invoke('wrong')).status, 400);
    assert.equal(requests.length, 0);
    const first = await invoke(TOKEN_SENTINEL);
    assert.equal(first.status, 200);
    assert.equal(requests[0].params.arguments.accessToken, 'private-google-token');
    const actorResponse = await first.text();
    assert.ok(!actorResponse.includes('private-google-token'));
    assert.ok(!actorResponse.includes('private-access-secret'));
    assert.equal(relay.hasUnknownMutation, true);
    assert.equal((await invoke(TOKEN_SENTINEL)).status, 400);
    assert.equal(requests.length, 1);
    assert.ok(
      !(await readFile(join(output, 'mcp.jsonl'), 'utf8')).includes('private-google-token'),
    );
    assert.ok(
      !(await readFile(join(output, 'mcp.jsonl'), 'utf8')).includes('private-access-secret'),
    );
    assert.equal((await fetch(relay.url + '/mcp')).status, 405);
  } finally {
    await relay.close();
    await rm(output, { recursive: true, force: true });
  }
});

test('LLM relay forwards cache controls, preserves receipts and limits requests without provider credentials reaching the actor', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-model-'));
  let upstream: any;
  const proxy = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    upstream = { headers: request.headers, body: JSON.parse(body) };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: {"type":"message_start","message":{"model":"synthetic-model","usage":{"input_tokens":8,"cache_read_input_tokens":12,"cache_creation_input_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\ndata: {"type":"message_stop"}\n\n',
    );
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address() as { port: number };
  const relay = await startEvalServer({
    output,
    model: 'synthetic-model',
    accessToken: 'private-google-token',
    proxyKey: 'private-proxy-key',
    proxyUrl: `http://127.0.0.1:${address.port}`,
    dispatch: async () => Response.json({}),
  });
  try {
    const payload = {
      model: 'synthetic-model',
      max_tokens: 10000,
      system: [
        { type: 'text', text: 'Stable shared instructions', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'Task' }],
    };
    const result = await fetch(relay.url + '/llm/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'local-eval-relay' },
      body: JSON.stringify(payload),
    });
    assert.equal(result.status, 200);
    await result.text();
    assert.equal(upstream.headers['x-api-key'], 'private-proxy-key');
    assert.deepEqual(upstream.body.system, payload.system);
    assert.equal(upstream.body.max_tokens, 2048);
    assert.equal(relay.llm[0].usageEvents[0].cache_read_input_tokens, 12);
    assert.deepEqual(relay.llm[0].servedModels, ['synthetic-model']);
    assert.equal(relay.llm[0].totalOutputTokensOrUpperBound, 9);
    assert.ok(
      !(await readFile(join(output, 'model-requests.jsonl'), 'utf8')).includes('private-proxy-key'),
    );
    const wrong = await fetch(relay.url + '/llm/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'local-eval-relay' },
      body: JSON.stringify({ ...payload, model: 'silent-fallback' }),
    });
    assert.equal(wrong.status, 400);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
});

test('model identity requires complete receipts from the selected model', () => {
  assert.equal(gradeModel('selected', []).status, 'unknown');
  assert.equal(
    gradeModel('selected', [
      { requestedModel: 'selected', servedModels: ['other'], complete: true },
    ]).status,
    'fail',
  );
  assert.equal(
    gradeModel('selected', [
      { requestedModel: 'selected', servedModels: ['selected'], complete: false },
    ]).status,
    'unknown',
  );
  assert.equal(
    gradeModel('selected', [
      { requestedModel: 'selected', servedModels: ['selected'], complete: true },
    ]).status,
    'pass',
  );
});

for (const failure of ['throw', 'malformed']) {
  test(`outer ${failure} execution fences the next attempt and retains receipts`, async () => {
    const output = await mkdtemp(join(tmpdir(), 'eval-outer-'));
    let calls = 0;
    const relay = await startEvalServer({
      output,
      model: 'model',
      accessToken: 'secret',
      proxyKey: 'key',
      proxyUrl: 'http://127.0.0.1:1',
      dispatch: async () => {
        calls++;
        if (failure === 'throw') throw new Error('dispatch failed');
        return Response.json({ result: { structuredContent: {} } });
      },
    });
    const invoke = () =>
      fetch(relay.url + '/mcp', {
        method: 'POST',
        body: JSON.stringify({
          method: 'tools/call',
          params: { name: 'execute', arguments: { accessToken: TOKEN_SENTINEL } },
        }),
      });
    try {
      await (await invoke()).text();
      assert.equal(relay.hasUnknownMutation, true);
      assert.equal((await invoke()).status, 400);
      assert.equal(calls, 1);
      assert.equal(relay.audit.length, 1);
      assert.ok((await readFile(join(output, 'mcp.jsonl'), 'utf8')).length > 0);
    } finally {
      await relay.close();
      await rm(output, { recursive: true, force: true });
    }
  });
}

test('a concurrent execution cannot pass the outer fence', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-concurrent-'));
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const relay = await startEvalServer({
    output,
    model: 'model',
    accessToken: 'secret',
    proxyKey: 'key',
    proxyUrl: 'http://127.0.0.1:1',
    dispatch: async () => {
      calls++;
      entered();
      await waiting;
      return Response.json({
        result: {
          structuredContent: { outcomes: [], outcomesComplete: true, hasUnknownOutcome: false },
        },
      });
    },
  });
  const invoke = () =>
    fetch(relay.url + '/mcp', {
      method: 'POST',
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: 'execute', arguments: { accessToken: TOKEN_SENTINEL } },
      }),
    });
  try {
    const first = invoke();
    await entering;
    assert.equal((await invoke()).status, 400);
    finish();
    await (await first).text();
    assert.equal(calls, 1);
    assert.equal(relay.hasUnknownMutation, false);
  } finally {
    finish();
    await relay.close();
    await rm(output, { recursive: true, force: true });
  }
});

test('incomplete model streams keep their reserved output budget', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-incomplete-'));
  let calls = 0;
  const proxy = createServer((_request, response) => {
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: {"type":"message_start","message":{"model":"model","usage":{"output_tokens":0}}}\n\n',
    );
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const relay = await startEvalServer({
    output,
    model: 'model',
    accessToken: 'secret',
    proxyKey: 'key',
    proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    dispatch: async () => Response.json({}),
  });
  try {
    const invoke = () =>
      fetch(relay.url + '/llm/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'local-eval-relay' },
        body: JSON.stringify({ model: 'model', max_tokens: 2048 }),
      });
    for (let i = 0; i < 8; i++) {
      const response = await invoke();
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await invoke()).status, 400);
    assert.equal(calls, 8);
    assert.equal(relay.llm.at(-1).totalOutputTokensOrUpperBound, 15000);
    assert.ok(relay.llm.every((receipt) => receipt.complete === false));
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
});

test('message stop without terminal output telemetry cannot refund reservations', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-missing-usage-'));
  const proxy = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: {"type":"message_start","message":{"model":"model","usage":{"output_tokens":0}}}\n\ndata: {"type":"message_stop"}\n\n',
    );
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const relay = await startEvalServer({
    output,
    model: 'model',
    accessToken: 'secret',
    proxyKey: 'key',
    proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    dispatch: async () => Response.json({}),
  });
  try {
    await (
      await fetch(relay.url + '/llm/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'local-eval-relay' },
        body: JSON.stringify({ model: 'model', max_tokens: 2048 }),
      })
    ).text();
    assert.equal(relay.llm[0].totalOutputTokensOrUpperBound, 2048);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
});

test('closing aborts upstream inference and waits for its retained failure receipt', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-abort-'));
  let started!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const proxy = createServer((_request, _response) => {
    started();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const relay = await startEvalServer({
    output,
    model: 'model',
    accessToken: 'secret',
    proxyKey: 'key',
    proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    dispatch: async () => Response.json({}),
  });
  try {
    const request = fetch(relay.url + '/llm/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'local-eval-relay' },
      body: JSON.stringify({ model: 'model', max_tokens: 2048 }),
    }).catch(() => null);
    await starting;
    await relay.close();
    await request;
    assert.equal(relay.llm[0].error, 'upstream_failure');
    assert.equal(
      JSON.parse((await readFile(join(output, 'model-receipts.jsonl'), 'utf8')).trim()).complete,
      false,
    );
    await relay.close(); // shutdown is safe on both normal and finally paths
  } finally {
    await relay.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
});

test('relay ordinals reflect full response completion across overlapping discovery and execution', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-order-'));
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const relay = await startEvalServer({
    output,
    model: 'model',
    accessToken: 'secret',
    proxyKey: 'key',
    proxyUrl: 'http://127.0.0.1:1',
    dispatch: async (request) => {
      const rpc = (await request.json()) as any;
      if (rpc.params.name === 'describe') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('{"result":'));
              entered();
              await waiting;
              controller.enqueue(
                new TextEncoder().encode(
                  '{"structuredContent":{"path":"gmail/v1/users.messages.get","signature":"get(params)"}}}',
                ),
              );
              controller.close();
            },
          }),
        );
      }
      return Response.json({
        result: {
          structuredContent: { outcomes: [], outcomesComplete: true, hasUnknownOutcome: false },
        },
      });
    },
  });
  const invoke = (name: string) =>
    fetch(relay.url + '/mcp', {
      method: 'POST',
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name,
          arguments:
            name === 'describe'
              ? { path: 'gmail/v1/users.messages.get' }
              : { accessToken: TOKEN_SENTINEL },
        },
      }),
    });
  try {
    const discovery = invoke('describe');
    await entering;
    assert.equal(relay.audit[0].startedOrdinal, 1);
    assert.equal(relay.audit[0].completedOrdinal, undefined);
    await (await invoke('execute')).text();
    assert.equal(relay.audit[1].startedOrdinal, 2);
    assert.equal(relay.audit[1].completedOrdinal, 3);
    finish();
    await (await discovery).text();
    assert.equal(relay.audit[0].completedOrdinal, 4);
    const retained = (await readFile(join(output, 'mcp.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(retained, [relay.audit[1], relay.audit[0]]);
    const attempts = (await readFile(join(output, 'mcp-attempts.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      attempts.map((event) => [event.startedOrdinal, event.completedOrdinal]),
      [
        [1, undefined],
        [2, undefined],
      ],
    );
  } finally {
    finish();
    await relay.close();
    await rm(output, { recursive: true, force: true });
  }
});

test('unparseable response retains the started ordinal without a fabricated completion', async () => {
  const output = await mkdtemp(join(tmpdir(), 'eval-order-invalid-'));
  const relay = await startEvalServer({
    output,
    model: 'model',
    accessToken: 'secret',
    proxyKey: 'key',
    proxyUrl: 'http://127.0.0.1:1',
    dispatch: async () => new Response('{unfinished'),
  });
  try {
    await (
      await fetch(relay.url + '/mcp', {
        method: 'POST',
        body: JSON.stringify({
          method: 'tools/call',
          params: { name: 'execute', arguments: { accessToken: TOKEN_SENTINEL } },
        }),
      })
    ).text();
    assert.equal(relay.audit[0].startedOrdinal, 1);
    assert.equal(relay.audit[0].completedOrdinal, undefined);
    assert.equal(relay.hasUnknownMutation, true);
    assert.deepEqual(
      JSON.parse((await readFile(join(output, 'mcp.jsonl'), 'utf8')).trim()),
      relay.audit[0],
    );
  } finally {
    await relay.close();
    await rm(output, { recursive: true, force: true });
  }
});
