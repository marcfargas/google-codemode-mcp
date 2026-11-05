import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutboundRecorder } from '../eval/outbound.ts';
import { createBuiltWorker } from '../support/worker-client.ts';

const parameters = { fileId: { type: 'string', required: true, location: 'path' } };
const discovery = {
  name: 'drive',
  version: 'v3',
  rootUrl: 'https://www.googleapis.com/',
  servicePath: 'drive/v3/',
  schemas: {
    File: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' } },
    },
  },
  resources: {
    files: {
      methods: {
        get: { path: 'files/{fileId}', httpMethod: 'GET', parameters, response: { $ref: 'File' } },
        update: {
          path: 'files/{fileId}',
          httpMethod: 'PATCH',
          parameters,
          request: { $ref: 'File' },
          response: { $ref: 'File' },
        },
      },
    },
  },
};

test('actual built Worker egress is independently observed while sandbox fetch and redirects stay fenced', async () => {
  let forwards = 0,
    version = 3,
    name = 'original.txt';
  const recorder = createOutboundRecorder({
    transport: (async (input, init) => {
      forwards++;
      const request = input as Request;
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://www.googleapis.com', 'no real network or redirect trap');
      assert.equal(init?.redirect, 'manual');
      if (url.pathname === '/discovery/v1/apis/drive/v3/rest') return Response.json(discovery);
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic-outbound-token');
      if (url.pathname.endsWith('/synthetic-redirect'))
        return new Response(null, {
          status: 307,
          headers: { location: 'https://redirect-trap.invalid/' },
        });
      assert.equal(url.pathname, '/drive/v3/files/synthetic-owned');
      if (request.method === 'PATCH') {
        name = ((await request.json()) as { name: string }).name;
        version++;
      } else assert.equal(request.method, 'GET');
      return Response.json({ id: 'synthetic-owned', name, version: String(version) });
    }) as typeof fetch,
  });
  const worker = await createBuiltWorker({ outbound: recorder.handler });
  let disposed = false;
  const execute = async (code: string) => {
    const response = await worker.dispatchFetch('http://localhost/mcp', {
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
        params: {
          name: 'execute',
          arguments: { accessToken: 'synthetic-outbound-token', code },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const rpc = (await response.json()) as any;
    assert.equal(rpc.result?.structuredContent?.status, 'completed', JSON.stringify(rpc));
    return rpc.result.structuredContent;
  };
  try {
    const read = await execute(
      `let denied=false;try{await fetch('https://sandbox-trap.invalid/')}catch{denied=true;}return {denied,file:(await google.drive({version:'v3'}).files.get({fileId:'synthetic-owned'})).data};`,
    );
    assert.equal(read.result.denied, true);
    assert.equal(read.result.file.version, '3');
    assert.equal(forwards, 2, 'only Discovery and native get reach the parent observer');
    const forged = await execute(
      `const d=google.drive({version:'v3'});await d.files.update({fileId:'synthetic-owned',requestBody:{name:'changed.txt'}});await d.files.update({fileId:'synthetic-owned',requestBody:{name:'original.txt'}});return {outcomes:[],version:'3'};`,
    );
    assert.deepEqual(forged.result.outcomes, []);
    assert.equal(name, 'original.txt');
    assert.equal(version, 5);
    const redirect = await execute(
      `try{await google.drive({version:'v3'}).files.get({fileId:'synthetic-redirect'})}catch{}return 'finished';`,
    );
    assert.equal(redirect.outcomes[0].httpStatus, 307);
    const sealed = await recorder.seal();
    await assert.rejects(
      recorder.handler(new Request('https://www.googleapis.com/late')),
      /admission closed/,
    );
    await worker.dispose();
    disposed = true;
    assert.equal(sealed.complete, true);
    const final = await recorder.finalize();
    assert.equal(
      final.complete,
      false,
      'the late blocked callback cannot leave qualifying coverage',
    );
    assert.equal(final.failure, 'late_request');
    assert.deepEqual(
      sealed.requests.map((row) => row.method),
      ['GET', 'GET', 'PATCH', 'PATCH', 'GET'],
    );
    assert.ok(sealed.requests.every((row) => row.dispatched && !row.methodOverride));
    assert.equal(sealed.requests.at(-1)!.status, 307);
    assert.equal(sealed.requests.at(-1)!.outcome, 'unknown');
    assert.equal(forwards, 5, 'no hidden redirect, late request, or replay');
    assert.ok(!JSON.stringify(sealed).includes('synthetic-outbound-token'));
  } finally {
    if (!disposed) await worker.dispose();
  }
});

test('real evaluation backends drain and dispose each trial before creating a fresh observation window', async () => {
  const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createEvaluationBackend } = await import('../eval/backend.ts');
  const root = await mkdtemp(join(tmpdir(), 'outbound-trials-'));
  const originalFetch = globalThis.fetch;
  const priorBackend = process.env.EVAL_BACKEND;
  delete process.env.EVAL_BACKEND;
  let admitted!: () => void, reply!: () => void;
  const arrived = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const response = new Promise<void>((resolve) => {
    reply = resolve;
  });
  let forwards = 0;
  const instances: Awaited<ReturnType<typeof createEvaluationBackend>>[] = [];
  globalThis.fetch = (async (input: any) => {
    forwards++;
    const url = new URL(input.url);
    if (url.pathname === '/discovery/v1/apis/drive/v3/rest') return Response.json(discovery);
    assert.equal(url.pathname, '/drive/v3/files/synthetic-owned');
    if (forwards === 2) {
      admitted();
      await response;
    }
    return Response.json({ id: 'synthetic-owned', name: 'original.txt' });
  }) as typeof fetch;
  const dispatch = (backend: Awaited<ReturnType<typeof createEvaluationBackend>>) =>
    backend.dispatch(
      new Request('http://localhost/mcp', {
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
          params: {
            name: 'execute',
            arguments: {
              accessToken: 'synthetic',
              code: "return await google.drive({version:'v3'}).files.get({fileId:'synthetic-owned'});",
            },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );
  try {
    const trial1 = join(root, 'trial-1');
    await mkdir(trial1);
    const first = await createEvaluationBackend(trial1, { captureOutbound: true });
    instances.push(first);
    const firstResponse = dispatch(first)
      .then(async (r) => {
        await r.text();
      })
      .catch(() => {});
    await arrived;
    const finishing = first.finishObservation();
    assert.equal(first.finishObservation(), finishing);
    let finished = false;
    void finishing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    reply();
    await firstResponse;
    const sealed = await finishing;
    assert.equal(sealed?.complete, true);
    assert.equal(sealed?.workerDisposed, true);
    assert.equal(sealed?.requests.length, 2);
    const retained = await readFile(join(trial1, 'product-outbound.json'), 'utf8');
    await assert.rejects(dispatch(first), /admission closed/i);
    const trial2 = join(root, 'trial-2');
    await mkdir(trial2);
    const second = await createEvaluationBackend(trial2, { captureOutbound: true });
    instances.push(second);
    await (await dispatch(second)).text();
    const next = await second.finishObservation();
    assert.equal(next?.complete, true);
    assert.equal(next?.workerDisposed, true);
    assert.deepEqual(
      next?.requests.map((row) => row.ordinal),
      [1, 2],
    );
    assert.equal(forwards, 4, 'each fresh Worker performs its own Discovery and read');
    assert.equal(
      await readFile(join(trial1, 'product-outbound.json'), 'utf8'),
      retained,
      'late activity cannot alter the earlier trial',
    );
  } finally {
    reply();
    await Promise.all(instances.map((instance) => instance.close()));
    globalThis.fetch = originalFetch;
    if (priorBackend === undefined) delete process.env.EVAL_BACKEND;
    else process.env.EVAL_BACKEND = priorBackend;
    await rm(root, { recursive: true, force: true });
  }
});
