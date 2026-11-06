import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutboundRecorder, type OutboundEvidence } from '../eval/outbound.ts';

const url =
  'https://www.googleapis.com/drive/v3/files/synthetic-owned?fields=id&access_token=QUERY_SECRET';
const request = (method = 'GET', headers?: HeadersInit) =>
  new Request(url, {
    method,
    headers: { authorization: 'Bearer HEADER_SECRET', ...Object.fromEntries(new Headers(headers)) },
    ...(method === 'PATCH' ? { body: 'BODY_SECRET' } : {}),
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('outbound recorder persists pending before egress and forwards exactly once with redirects fenced', async () => {
  const events: OutboundEvidence[] = [];
  let forwarded = 0;
  const recorder = createOutboundRecorder({
    onEvent: async (event) => {
      events.push(structuredClone(event));
    },
    transport: (async (input, init) => {
      forwarded++;
      assert.equal(events.at(-1)!.requests[0].outcome, 'pending');
      assert.equal(events.at(-1)!.requests[0].dispatched, false);
      assert.equal(init?.redirect, 'manual');
      assert.equal((input as Request).headers.get('authorization'), 'Bearer HEADER_SECRET');
      assert.equal(await (input as Request).text(), 'BODY_SECRET');
      return new Response(null, { status: 307, headers: { location: 'https://trap.invalid/' } });
    }) as typeof fetch,
  });
  const response = await recorder.handler(request('PATCH'));
  assert.equal(response.status, 307);
  const evidence = await recorder.seal();
  assert.equal(evidence.complete, true);
  assert.equal(evidence.requests[0].outcome, 'unknown');
  assert.equal(recorder.hasUnknownMutation, true);
  assert.equal(forwarded, 1);
  assert.deepEqual(evidence.requests[0].queryKeys, ['access_token', 'fields']);
  for (const secret of ['HEADER_SECRET', 'BODY_SECRET', 'QUERY_SECRET', 'trap.invalid'])
    assert.ok(!JSON.stringify(events).includes(secret));
});

test('seal fences admission synchronously, drains already admitted calls and is idempotent', async () => {
  const admitted = deferred<void>();
  const reply = deferred<Response>();
  let forwarded = 0;
  const recorder = createOutboundRecorder({
    transport: (async () => {
      forwarded++;
      admitted.resolve();
      return reply.promise;
    }) as typeof fetch,
  });
  const first = recorder.handler(request());
  await admitted.promise;
  const sealed = recorder.seal();
  assert.equal(recorder.seal(), sealed);
  await assert.rejects(recorder.handler(request('PATCH')), /admission closed/);
  let finished = false;
  void sealed.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  reply.resolve(Response.json({ id: 'synthetic-owned' }));
  await first;
  const evidence = await sealed;
  assert.equal(forwarded, 1);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.failure, 'late_request');
  assert.equal(evidence.requests.length, 1);
  assert.equal(evidence.requests[0].outcome, 'acknowledged');
});

test('pre-egress persistence failure refuses forwarding and latches incomplete evidence', async () => {
  let forwarded = 0;
  const recorder = createOutboundRecorder({
    onEvent: async () => {
      throw new Error('PRIVATE error');
    },
    transport: (async () => {
      forwarded++;
      return new Response();
    }) as typeof fetch,
  });
  await assert.rejects(recorder.handler(request('PATCH')), /persistence failed/);
  await assert.rejects(recorder.handler(request()), /admission closed/);
  const evidence = await recorder.seal();
  assert.equal(forwarded, 0);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.failure, 'persistence_failed');
  assert.equal(evidence.requests[0].dispatched, false);
  assert.equal(recorder.hasUnknownMutation, false);
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));
});

test('late admission during initial persistence prevents all not-yet-forwarded requests', async () => {
  const entered = deferred<void>();
  const stored = deferred<void>();
  let writes = 0,
    forwarded = 0;
  const recorder = createOutboundRecorder({
    onEvent: async () => {
      if (++writes === 1) {
        entered.resolve();
        await stored.promise;
      }
    },
    transport: (async () => {
      forwarded++;
      return new Response();
    }) as typeof fetch,
  });
  const first = recorder.handler(request());
  await entered.promise;
  const sealed = recorder.seal();
  await assert.rejects(recorder.handler(request('PATCH')), /admission closed/);
  assert.equal(forwarded, 0);
  stored.resolve();
  await assert.rejects(first, /request not forwarded/);
  assert.equal((await sealed).requests[0].dispatched, false);
  assert.equal((await recorder.finalize()).complete, false);
  assert.equal(forwarded, 0);
});

test('a callback after seal resolves still invalidates post-disposal final evidence', async () => {
  let forwards = 0;
  const recorder = createOutboundRecorder({
    transport: (async () => {
      forwards++;
      return new Response();
    }) as typeof fetch,
  });
  await recorder.handler(request());
  assert.equal((await recorder.seal()).complete, true);
  await assert.rejects(recorder.handler(request('PATCH')), /admission closed/);
  const final = await recorder.finalize();
  assert.equal(final.complete, false);
  assert.equal(final.failure, 'late_request');
  assert.equal(forwards, 1);
});

test('acknowledgement survives later persistence or response-body failure', async () => {
  let writes = 0;
  const recorder = createOutboundRecorder({
    onEvent: async () => {
      if (++writes === 2) throw new Error('disk failed');
    },
    transport: (async () => new Response('ack', { status: 200 })) as typeof fetch,
  });
  await assert.rejects(recorder.handler(request('PATCH')), /acknowledgement evidence/);
  const evidence = await recorder.seal();
  assert.equal(evidence.complete, false);
  assert.equal(evidence.requests[0].outcome, 'acknowledged');
  assert.equal(evidence.requests[0].status, 200);
  assert.equal(recorder.hasUnknownMutation, false);
  const bodyFailure = createOutboundRecorder({
    transport: (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('bad body'));
          },
        }),
      )) as typeof fetch,
  });
  const response = await bodyFailure.handler(request('PATCH'));
  await assert.rejects(response.text(), /bad body/);
  assert.equal((await bodyFailure.seal()).requests[0].outcome, 'acknowledged');
});

test('native status classification and bounded forwarding failures retain uncertain mutations', async () => {
  for (const [status, expected] of [
    [204, 'acknowledged'],
    [400, 'rejected'],
    [403, 'rejected'],
    [408, 'unknown'],
    [500, 'unknown'],
  ] as const) {
    const recorder = createOutboundRecorder({
      transport: (async () => new Response(null, { status })) as typeof fetch,
    });
    await recorder.handler(request('PATCH'));
    assert.equal((await recorder.seal()).requests[0].outcome, expected);
    assert.equal(recorder.hasUnknownMutation, expected === 'unknown');
  }
  for (const method of ['PATCH', 'GET']) {
    const recorder = createOutboundRecorder({
      transport: (async () => {
        throw new Error('PRIVATE upstream failure');
      }) as typeof fetch,
    });
    await assert.rejects(recorder.handler(request(method)), /Observed outbound forwarding failed/);
    const evidence = await recorder.seal();
    assert.equal(evidence.requests[0].outcome, 'unknown');
    assert.equal(recorder.hasUnknownMutation, method === 'PATCH');
    assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));
  }
  const timed = createOutboundRecorder({
    timeoutMs: 5,
    transport: (() => new Promise(() => {})) as typeof fetch,
  });
  await assert.rejects(timed.handler(request('PATCH')), /Observed outbound forwarding failed/);
  assert.equal((await timed.seal()).requests[0].outcome, 'unknown');
  assert.equal(timed.hasUnknownMutation, true);
  let calls = 0;
  const latched = createOutboundRecorder({
    transport: (async () => {
      if (++calls === 1) throw new Error();
      return new Response();
    }) as typeof fetch,
  });
  await assert.rejects(latched.handler(request('PATCH')));
  await latched.handler(request());
  assert.equal(
    latched.hasUnknownMutation,
    true,
    'a later acknowledged read cannot erase uncertainty',
  );
  assert.deepEqual(
    (await latched.seal()).requests.map((row) => row.outcome),
    ['unknown', 'acknowledged'],
  );
});

test('method-override headers and query keys are observed without retaining their values', async () => {
  for (const [target, headers] of [
    [url, { 'x-http-method-override': 'SECRET_OVERRIDE' }],
    [url, { 'x-method-override': 'SECRET_OVERRIDE' }],
    [url, { 'x-http-method': 'SECRET_OVERRIDE' }],
    [url + '&_method=SECRET_OVERRIDE', {}],
    [url + '&$method=SECRET_OVERRIDE', {}],
  ] as const) {
    const recorder = createOutboundRecorder({
      transport: (async () => {
        throw new Error();
      }) as typeof fetch,
    });
    await assert.rejects(recorder.handler(new Request(target, { headers })));
    const evidence = await recorder.seal();
    assert.equal(evidence.requests[0].methodOverride, true);
    assert.equal(recorder.hasUnknownMutation, true);
    assert.ok(!JSON.stringify(evidence).includes('SECRET_OVERRIDE'));
  }
});

test('independent uncertain writes fence later writes even if the product continues', async () => {
  let forwarded = 0;
  const recorder = createOutboundRecorder({
    transport: (async () => {
      forwarded++;
      if (forwarded === 1) throw new Error();
      return new Response();
    }) as typeof fetch,
  });
  await assert.rejects(recorder.handler(request('PATCH')));
  await recorder.handler(request());
  await assert.rejects(recorder.handler(request('PATCH')), /Prior outbound write is uncertain/);
  const final = await recorder.finalize();
  assert.equal(forwarded, 2);
  assert.equal(final.complete, false);
  assert.equal(final.failure, 'uncertain_write');
  assert.equal(final.requests[0].outcome, 'unknown');
  assert.equal(final.requests[1].outcome, 'acknowledged');
  assert.equal(final.requests[2].dispatched, false);
  assert.equal(recorder.hasUnknownMutation, true);
});
