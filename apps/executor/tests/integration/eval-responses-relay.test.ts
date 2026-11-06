import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { RESPONSES_ACCOUNTING_VERSION } from '../eval/responses-relay.ts';
import { responsesHarness } from '../support/relay.ts';

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

function assertHeld(receipt: any) {
  assert.equal(receipt.accountingVersion, RESPONSES_ACCOUNTING_VERSION);
  assert.equal(receipt.settlementEligible, false);
  assert.equal(receipt.refundUsd, 0);
  assert.equal(receipt.settledUsd, null);
  assert.equal(receipt.heldUsd, receipt.reservationUsd);
  assert.ok(receipt.settlementReason.length > 0);
}

const harness = (
  respond: (body: any, response: ServerResponse, request: IncomingMessage) => unknown,
  model = MODEL,
) => responsesHarness(respond, payload(model));

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
    assert.equal(receipt.accountingVersion, 2);
    assert.equal(receipt.settlementEligible, true);
    assert.equal(receipt.settlementReason, 'settled_verified_terminal');
    assert.equal(receipt.settledUsd, (20 * 1 + 9 * 5) / 1_000_000);
    assert.equal(receipt.heldUsd, 0);
    assert.ok(receipt.refundUsd > 0);
    assert.equal(receipt.totalCommittedEstimateUsd, receipt.estimatedUsdUpperBound);
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
    assertHeld(gate.receipts[1]);
    assert.equal(
      gate.receipts[1].totalCommittedEstimateUsd,
      gate.receipts[0].settledUsd + gate.receipts[1].reservationUsd,
    );
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
    assert.ok(gate.receipts.every((receipt) => !receipt.settlementEligible));
    assert.equal(
      gate.receipts.at(-1).totalCommittedEstimateUsd,
      gate.receipts.reduce((sum, receipt) => sum + receipt.reservationUsd, 0),
    );
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
    assertHeld(gate.receipts[0]);
  } finally {
    await gate.close();
  }
});

test('high actual usage still blocks a large third request before spending', async () => {
  let count = 0;
  const model = 'gpt-6.1-sol';
  const gate = await harness(
    (_body, response) =>
      response.end(
        JSON.stringify({
          ...terminal(`cost-${++count}`, model),
          usage: {
            input_tokens: 200_000,
            output_tokens: 2048,
            input_tokens_details: { cached_tokens: 0 },
          },
        }),
      ),
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
    assert.ok(gate.receipts.every((receipt) => receipt.settlementEligible));
    assert.ok(gate.receipts.at(-1).estimatedUsdUpperBound > 0.8);
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
    assertHeld(saved);
    assert.equal(saved.estimatedUsdUpperBound, saved.reservationUsd);
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
      assertHeld(gate.receipts[0]);
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
      assertHeld(gate.receipts[0]);
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

test('settled input usage admits twelve-plus growing Sol requests that permanent byte charges would reject', async () => {
  // Aggregate shapes from the observed failure, with entirely synthetic text.
  const shapes = [
    [5268, 1216, 18],
    [6431, 1440, 39],
    [10639, 2306, 24],
    [11589, 2496, 25],
    [14257, 3031, 26],
    [22170, 4559, 27],
    [51218, 10317, 92],
    [53329, 10859, 27],
    [80826, 16324, 83],
    [87564, 18430, 27],
    [108648, 24446, 29],
    [110000, 25000, 30],
    [115000, 26000, 35],
  ];
  const model = 'gpt-6.1-sol';
  let call = 0;
  const gate = await harness((_body, response) => {
    const [, input_tokens, output_tokens] = shapes[call];
    response.end(
      JSON.stringify({
        ...terminal(`settled-sol-${++call}`, model),
        usage: { input_tokens, output_tokens, input_tokens_details: { cached_tokens: 0 } },
      }),
    );
  }, model);
  try {
    for (const [bytes] of shapes) {
      const body = { ...payload(model), instructions: '' };
      body.instructions = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
      assert.equal(Buffer.byteLength(JSON.stringify(body)), bytes);
      const response = await gate.invoke(body);
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(gate.upstream.length, 13);
    assert.ok(gate.receipts.every((receipt) => receipt.settlementEligible));
    const oldCommittedAfterEleven = gate.receipts
      .slice(0, 11)
      .reduce(
        (sum, receipt) =>
          sum +
          (receipt.inputTokenUpperBound * 2 + receipt.rawUsage.output_tokens * 10) / 1_000_000,
        0,
      );
    assert.ok(oldCommittedAfterEleven + gate.receipts[11].reservationUsd > 1);
    const actualUncached = gate.receipts.reduce((sum, receipt) => sum + receipt.settledUsd, 0);
    assert.ok(actualUncached < 0.4);
    assert.ok(Math.abs(gate.receipts.at(-1).totalCommittedEstimateUsd - actualUncached) < 1e-12);
    assert.equal(
      gate.receipts.at(-1).totalOutputTokensOrUpperBound,
      shapes.reduce((sum, shape) => sum + shape[2], 0),
    );
  } finally {
    await gate.close();
  }
});

test('missing cache detail settles at uncached rates while cache-discount usage remains unknown', async () => {
  const gate = await harness((_body, response) =>
    response.end(
      JSON.stringify({
        ...terminal('missing-cache'),
        usage: { input_tokens: 20, output_tokens: 9 },
      }),
    ),
  );
  try {
    const response = await gate.invoke();
    assert.equal(response.status, 200);
    await response.text();
    const receipt = gate.receipts[0];
    assert.equal(receipt.settlementEligible, true);
    assert.equal(receipt.settledUsd, (20 * 1 + 9 * 5) / 1_000_000);
    assert.equal(receipt.usagePublishedRateEstimateUsd, null);
    assert.equal(receipt.cumulativeUsagePublishedRateEstimateUsd, null);
    assert.equal(receipt.cacheReadInputTokens, null);
    assert.equal(receipt.cacheCreationInputTokens, null);
  } finally {
    await gate.close();
  }
});

test('ineligible identities, terminal classes and input/cache telemetry retain both complete reservations', async () => {
  const scenarios: { patch?: any; httpStatus?: number; reason?: string }[] = [
    { patch: { model: undefined } },
    { patch: { model: 'wrong-model' } },
    { patch: { id: undefined } },
    { patch: { status: 'incomplete' } },
    { patch: { status: 'failed' } },
    { httpStatus: 500 },
    { patch: { usage: { output_tokens: 9 } }, reason: 'missing_or_nonpositive_input_tokens' },
    {
      patch: { usage: { input_tokens: 0, output_tokens: 9 } },
      reason: 'missing_or_nonpositive_input_tokens',
    },
    { patch: { usage: { input_tokens: -1, output_tokens: 9 } } },
    { patch: { usage: { input_tokens: 1.5, output_tokens: 9 } } },
    { patch: { usage: { input_tokens: 1_000_000, output_tokens: 9 } } },
    { patch: { usage: { input_tokens: 20 } }, reason: 'missing_or_nonpositive_output_tokens' },
    {
      patch: {
        usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: 21 } },
      },
    },
    {
      patch: {
        usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: -1 } },
      },
    },
    {
      patch: {
        usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: 0.5 } },
      },
    },
    {
      patch: {
        usage: {
          input_tokens: 20,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: null },
        },
      },
    },
  ];
  for (const scenario of scenarios) {
    const gate = await harness((_body, response) => {
      response.writeHead(scenario.httpStatus ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...terminal('ineligible'), ...scenario.patch }));
    });
    try {
      await (await gate.invoke()).text();
      const receipt = gate.receipts[0];
      assertHeld(receipt);
      assert.equal(receipt.totalOutputTokensOrUpperBound, 2048);
      assert.equal(receipt.totalCommittedEstimateUsd, receipt.reservationUsd);
      if (scenario.reason) assert.equal(receipt.settlementReason, scenario.reason);
    } finally {
      await gate.close();
    }
  }
});
