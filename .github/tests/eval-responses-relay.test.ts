import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createResponsesHandler } from '../eval/responses-relay.ts';

const MODEL = 'gpt-6.1-terra';
const tool = { type: 'function', name: 'describe', parameters: { type: 'object' }, strict: false };
const payload = (model = MODEL) => ({
  model,
  store: false,
  tools: [tool],
  instructions: 'Stable evaluation instructions',
  input: [{ role: 'user', content: 'Task' }],
  max_output_tokens: 2048,
  stream: false,
});
const terminal = (id: string, model = MODEL) => ({
  id,
  object: 'response',
  model,
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
  ],
  usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: 12 } },
});

async function harness(
  respond: (body: any, response: ServerResponse, request: IncomingMessage) => unknown,
  model = MODEL,
) {
  const output = await mkdtemp(join(tmpdir(), 'responses-relay-'));
  const upstream: any[] = [];
  const proxy = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    upstream.push({ body, headers: request.headers });
    await respond(body, response, request);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const receipts: any[] = [];
  const handler = createResponsesHandler({
    proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    proxyKey: 'private-proxy-key',
    model,
    output,
    receipts,
    redact: (text) => text.replaceAll('private-proxy-key', '[proxy-key]'),
    allowedToolNames: () => ['describe'],
  });
  const relay = createServer(async (request, response) => {
    try {
      await handler.handle(request, response);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }));
    }
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  return {
    output,
    upstream,
    receipts,
    handler,
    invoke: (body: any = payload(model), key = 'local-eval-relay') =>
      fetch(`http://127.0.0.1:${(relay.address() as { port: number }).port}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }),
    async close() {
      handler.abort();
      relay.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => relay.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
      await rm(output, { recursive: true, force: true });
    },
  };
}

test('Responses relay preserves cache controls, terminal usage and model identity without leaking auth', async () => {
  const gate = await harness((_body, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(terminal('one')));
  });
  try {
    const body = {
      ...payload(),
      prompt_cache_key: 'stable-evaluation-prefix',
      max_output_tokens: 10_000,
    };
    const response = await gate.invoke(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), terminal('one'));
    assert.equal(gate.upstream[0].headers.authorization, 'Bearer private-proxy-key');
    assert.equal(gate.upstream[0].body.max_output_tokens, 2048);
    assert.equal(gate.upstream[0].body.prompt_cache_key, body.prompt_cache_key);
    assert.deepEqual(gate.upstream[0].body.tools, body.tools);
    const receipt = gate.receipts[0];
    assert.equal(receipt.api, 'responses');
    assert.equal(receipt.complete, true);
    assert.deepEqual(receipt.servedModels, [MODEL]);
    assert.equal(receipt.cacheReadInputTokens, 12);
    assert.equal(receipt.cacheCreationInputTokens, null);
    assert.equal(receipt.totalOutputTokensOrUpperBound, 9);
    assert.equal(receipt.providerBilledCostUsd, null);
    assert.ok(receipt.usagePublishedRateEstimateUsd > 0);
    assert.ok(receipt.estimatedUsdUpperBound >= receipt.usagePublishedRateEstimateUsd);
    assert.match(receipt.responseSha256, /^[a-f0-9]{64}$/);
    for (const name of ['model-requests.jsonl', 'model-receipts.jsonl'])
      assert.ok(!(await readFile(join(gate.output, name), 'utf8')).includes('private-proxy-key'));
  } finally {
    await gate.close();
  }
});

test('Responses relay rejects wrong credentials, models, context references and unadvertised tools before spending', async () => {
  const gate = await harness(() => assert.fail('Invalid request reached upstream'));
  try {
    const invalid = [
      { ...payload(), model: 'different-model' },
      { ...payload(), store: true },
      { ...payload(), previous_response_id: 'remote-response' },
      { ...payload(), conversation: { id: 'remote-conversation' } },
      { ...payload(), background: true },
      { ...payload(), tools: [{ type: 'web_search' }] },
      { ...payload(), tools: [{ ...tool, name: 'unknown' }] },
      { ...payload(), tools: [tool, tool] },
      { ...payload(), input: [{ type: 'item_reference', id: 'remote-item' }] },
      {
        ...payload(),
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://example.invalid/image.png' }],
          },
        ],
      },
      { ...payload(), max_output_tokens: -1 },
      { ...payload(), max_output_tokens: 0 },
      { ...payload(), max_output_tokens: 1.5 },
    ];
    assert.equal((await gate.invoke(payload(), 'wrong-key')).status, 400);
    for (const body of invalid) assert.equal((await gate.invoke(body)).status, 400);
    assert.equal(gate.upstream.length, 0);
    assert.equal(gate.receipts.length, 0);
  } finally {
    await gate.close();
  }
});

test('Responses relay retains complete reasoning and function context without rewriting it', async () => {
  const gate = await harness((_body, response) =>
    response.end(JSON.stringify(terminal('reasoning'))),
  );
  try {
    const body = {
      ...payload(),
      input: [
        { role: 'user', content: 'Task' },
        {
          type: 'reasoning',
          id: 'reasoning-item',
          summary: [],
          encrypted_content: 'self-contained-opaque-data',
        },
        {
          type: 'function_call',
          id: 'call-item',
          call_id: 'call-one',
          name: 'describe',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'call-one', output: '{"services":[]}' },
      ],
    };
    assert.equal((await gate.invoke(body)).status, 200);
    assert.deepEqual(gate.upstream[0].body.input, body.input);
  } finally {
    await gate.close();
  }
});

test('Responses SSE terminal completion deduplicates repeated terminal usage within one response', async () => {
  const gate = await harness((_body, response) => {
    const value = terminal('streamed');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      [
        { type: 'response.created', response: { ...value, status: 'in_progress', usage: null } },
        { type: 'response.completed', response: value },
        { type: 'response.completed', response: value },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(''),
    );
  });
  try {
    assert.equal((await gate.invoke({ ...payload(), stream: true })).status, 200);
    assert.equal(gate.receipts[0].complete, true);
    assert.equal(gate.receipts[0].usageEvents.length, 1);
    assert.deepEqual(gate.receipts[0].responseIds, ['streamed']);
    assert.equal(gate.receipts[0].totalOutputTokensOrUpperBound, 9);
    assert.equal((await gate.invoke({ ...payload(), stream: true })).status, 502);
    assert.equal(gate.receipts[1].duplicateResponse, true);
    assert.equal(gate.receipts[1].complete, false);
  } finally {
    await gate.close();
  }
});

test('incomplete Responses retain full output reservations and stop before the aggregate ceiling', async () => {
  let count = 0;
  const gate = await harness((_body, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        ...terminal(`incomplete-${++count}`),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    );
  });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await gate.invoke();
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await gate.invoke()).status, 400);
    assert.equal(gate.upstream.length, 8);
    assert.equal(gate.receipts.at(-1).totalOutputTokensOrUpperBound, 15_000);
    assert.ok(gate.receipts.every((receipt) => receipt.complete === false));
    assert.equal(gate.receipts[0].incompleteDetails.reason, 'max_output_tokens');
  } finally {
    await gate.close();
  }
});

test('model mismatch is retained and returned as a transport failure without silent fallback', async () => {
  const gate = await harness((_body, response) =>
    response.end(JSON.stringify(terminal('wrong-served', 'different-model'))),
  );
  try {
    assert.equal((await gate.invoke()).status, 502);
    assert.deepEqual(gate.receipts[0].servedModels, ['different-model']);
    assert.equal(gate.receipts[0].modelMismatch, true);
    assert.equal(gate.receipts[0].error, 'model_identity_mismatch');
    assert.equal(gate.receipts[0].usagePublishedRateEstimateUsd, null);
  } finally {
    await gate.close();
  }
});

test('published-rate cost reservation blocks a large third request before spending', async () => {
  let count = 0;
  const model = 'gpt-6.1-sol';
  const gate = await harness(
    (_body, response) => response.end(JSON.stringify(terminal(`cost-${++count}`, model))),
    model,
  );
  try {
    const body = { ...payload(model), instructions: 'x'.repeat(200_000) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await gate.invoke(body);
      assert.equal(response.status, 200);
      await response.text();
    }
    const rejected = await gate.invoke(body);
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /estimate ceiling/);
    assert.equal(gate.upstream.length, 2);
    assert.ok(gate.receipts.at(-1).estimatedUsdUpperBound < 1);
  } finally {
    await gate.close();
  }
});

test('active request rejects overlapping inference; abort retains its failure receipt and fences future requests', async () => {
  let started!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = await harness(() => {
    started();
  });
  try {
    const first = gate.invoke();
    await starting;
    assert.equal((await gate.invoke()).status, 400);
    gate.handler.abort();
    assert.equal((await first).status, 400);
    assert.equal(gate.receipts[0].complete, false);
    assert.equal(gate.receipts[0].error, 'upstream_failure');
    assert.equal(gate.receipts[0].totalOutputTokensOrUpperBound, 2048);
    const saved = JSON.parse(
      (await readFile(join(gate.output, 'model-receipts.jsonl'), 'utf8')).trim(),
    );
    assert.equal(saved.complete, false);
    assert.equal((await gate.invoke()).status, 400);
    assert.equal(gate.upstream.length, 1);
  } finally {
    await gate.close();
  }
});

test('conflicting terminal states and trailing error events cannot complete or refund a stream', async () => {
  for (const trailing of ['response.incomplete', 'error']) {
    const gate = await harness((_body, response) => {
      const value = terminal('conflict');
      const later =
        trailing === 'error'
          ? { type: 'error', message: 'stream failed' }
          : {
              type: 'response.incomplete',
              response: {
                ...value,
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
              },
            };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        [{ type: 'response.completed', response: value }, later]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    });
    try {
      const response = await gate.invoke({ ...payload(), stream: true });
      assert.equal(response.status, 502);
      await response.text();
      assert.equal(gate.receipts[0].complete, false);
      assert.equal(gate.receipts[0].totalOutputTokensOrUpperBound, 2048);
      assert.ok(gate.receipts[0].error);
    } finally {
      await gate.close();
    }
  }
});

test('missing response IDs and invalid output telemetry cannot release output reservations', async () => {
  for (const patch of [
    { id: undefined },
    { id: '' },
    { usage: { input_tokens: 20, output_tokens: -1, input_tokens_details: { cached_tokens: 0 } } },
    {
      usage: {
        input_tokens: 20,
        output_tokens: 10_000,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
    {
      usage: { input_tokens: 20, output_tokens: null, input_tokens_details: { cached_tokens: 0 } },
    },
    { usage: { input_tokens: 20, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } },
  ]) {
    const gate = await harness((_body, response) =>
      response.end(JSON.stringify({ ...terminal('telemetry'), ...patch })),
    );
    try {
      await (await gate.invoke()).text();
      assert.equal(gate.receipts[0].totalOutputTokensOrUpperBound, 2048);
      if (!patch.id && 'id' in patch) assert.equal(gate.receipts[0].complete, false);
      if (
        patch.usage &&
        patch.usage.output_tokens !== null &&
        (patch.usage.output_tokens < 0 || patch.usage.output_tokens > 2048)
      ) {
        assert.equal(gate.receipts[0].error, 'invalid_usage_telemetry');
        assert.equal(gate.receipts[0].usagePublishedRateEstimateUsd, null);
      }
    } finally {
      await gate.close();
    }
  }
});

test('completed one-token requests still stop at the explicit request ceiling', async () => {
  let count = 0;
  const gate = await harness((_body, response) =>
    response.end(
      JSON.stringify({
        ...terminal(`count-${++count}`),
        usage: { input_tokens: 20, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
      }),
    ),
  );
  try {
    for (let attempt = 0; attempt < 18; attempt++) {
      const response = await gate.invoke({ ...payload(), max_output_tokens: 1 });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await gate.invoke({ ...payload(), max_output_tokens: 1 })).status, 400);
    assert.equal(gate.upstream.length, 18);
    assert.equal(gate.receipts.at(-1).totalOutputTokensOrUpperBound, 18);
  } finally {
    await gate.close();
  }
});
