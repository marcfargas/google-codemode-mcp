import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Miniflare } from 'miniflare';
import { createBuiltWorker } from '../support/worker-client.ts';
import { prepareHosted } from '../hosted/prepare.ts';
import { createHostedBackend, hostedConfiguration } from '../eval/backend.ts';

const digest = 'a'.repeat(64);
const version = 'synthetic-version';
const accessHeaders = {
  'CF-Access-Client-Id': 'private-test-access-id',
  'CF-Access-Client-Secret': 'private-test-access-secret',
};
const configuration = {
  endpoint: 'https://synthetic.example/mcp',
  candidateDigest: digest,
  workerVersion: version,
  accessHeaders,
};
const payload = {
  jsonrpc: '2.0',
  id: 0,
  method: 'tools/call',
  params: {
    name: 'describe',
    arguments: {},
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
};
function request() {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'MCP-Method': 'tools/call',
      'MCP-Name': 'describe',
      Authorization: 'actor-forged-auth',
      'CF-Access-Client-Secret': 'actor-forged-access',
      'X-Actor-Header': 'must-not-forward',
    },
    body: JSON.stringify(payload),
  });
}
function reply(
  headers: Record<string, string> = {},
  value: unknown = { jsonrpc: '2.0', id: 0, result: { structuredContent: { services: [] } } },
) {
  return Response.json(value, {
    headers: {
      'x-candidate-digest': digest,
      'x-worker-version': version,
      'set-cookie': 'private-edge-cookie',
      'cf-access-jwt-assertion': 'private-jwt',
      ...headers,
    },
  });
}

test('product preparation serves the actual sessionless product with source/version identity in Miniflare', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-product-'));
  let worker: Miniflare | undefined;
  try {
    const output = join(directory, 'prepared');
    const manifest = await prepareHosted(output, 'product');
    assert.equal(manifest.mode, 'product');
    const sourceDigest = (mode: string) =>
      createHash('sha256')
        .update(JSON.stringify({ mode, sourceFiles: manifest.sourceFiles }))
        .digest('hex');
    assert.equal(manifest.sourceDigest, sourceDigest('product'));
    assert.notEqual(manifest.sourceDigest, sourceDigest('probes'));
    assert.ok(manifest.sourceFiles['snippets.config.ts']);
    assert.ok(manifest.sourceFiles['wrangler.jsonc']);
    const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.deepEqual(config.observability, { enabled: false });
    const bundle = await readFile(join(output, 'worker.js'), 'utf8');
    assert.equal(createHash('sha256').update(bundle).digest('hex'), manifest.bundleSha256);
    worker = await createBuiltWorker({
      bundle,
      bindings: {
        CANDIDATE_DIGEST: { type: 'text', value: manifest.sourceDigest },
        WORKER_VERSION: { type: 'json', value: { id: version } },
      },
      outbound: async () => {
        throw new Error('No network allowed');
      },
    });
    const req = request();
    const response = await worker.dispatchFetch(req.url, {
      method: 'POST',
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-candidate-digest'), manifest.sourceDigest);
    assert.equal(response.headers.get('x-worker-version'), version);
    assert.equal(response.headers.get('mcp-session-id'), null);
    const rpc = (await response.json()) as any;
    assert.deepEqual(
      rpc.result.structuredContent.services.map((s: any) => s.name),
      ['gmail', 'drive'],
    );
    const invalid = await worker.dispatchFetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.ok(invalid.status >= 400);
    assert.equal(invalid.headers.get('x-worker-version'), version);
    const missing = await worker.dispatchFetch('http://localhost/not-product');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-worker-version'), version);
  } finally {
    await worker?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted configuration admits only explicit HTTPS identity and the standard Access pair', () => {
  const env = {
    HOSTED_VERIFICATION_URL: configuration.endpoint,
    HOSTED_EXPECTED_CANDIDATE_DIGEST: digest,
    HOSTED_EXPECTED_WORKER_VERSION: version,
    HOSTED_ACCESS_HEADERS_JSON: JSON.stringify(accessHeaders),
  };
  assert.deepEqual(hostedConfiguration(env), configuration);
  for (const endpoint of [
    'http://synthetic.example/mcp',
    'https://u:p@synthetic.example/mcp',
    'https://synthetic.example/other',
    'https://synthetic.example/mcp?token=x',
    'https://synthetic.example/mcp#x',
  ])
    assert.throws(() => hostedConfiguration({ ...env, HOSTED_VERIFICATION_URL: endpoint }));
  assert.throws(() => hostedConfiguration({ ...env, HOSTED_EXPECTED_CANDIDATE_DIGEST: 'wrong' }));
  for (const headers of [
    { ...accessHeaders, Authorization: 'wrong' },
    { 'CF-Access-Client-Id': 'only' },
    { ...accessHeaders, 'cf-access-client-id': 'duplicate' },
  ])
    assert.throws(() =>
      hostedConfiguration({ ...env, HOSTED_ACCESS_HEADERS_JSON: JSON.stringify(headers) }),
    );
});

test('hosted dispatch gates admission before actor work and retains credentials outside actor headers/evidence', async () => {
  const output = await mkdtemp(join(tmpdir(), 'hosted-backend-'));
  const seen: Headers[] = [];
  try {
    const backend = await createHostedBackend(configuration, {
      output,
      transport: async (input, init) => {
        assert.equal(String(input), configuration.endpoint);
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal);
        const headers = new Headers(init?.headers);
        seen.push(headers);
        if (seen.length === 1) {
          assert.equal(headers.get('cf-access-client-secret'), null);
          return new Response('denied', { status: 403 });
        }
        assert.equal(
          headers.get('cf-access-client-secret'),
          accessHeaders['CF-Access-Client-Secret'],
        );
        assert.equal(headers.get('cf-access-client-id'), accessHeaders['CF-Access-Client-Id']);
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-actor-header'), null);
        return reply();
      },
    });
    assert.equal(seen.length, 2);
    const response = await backend.dispatch(request());
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cf-access-jwt-assertion'), null);
    assert.equal(response.headers.get('x-worker-version'), null);
    assert.equal(seen.length, 3);
    const receipt = await readFile(join(output, 'hosted-preflight.json'), 'utf8');
    for (const value of Object.values(accessHeaders)) assert.ok(!receipt.includes(value));
    assert.deepEqual(backend.secrets, Object.values(accessHeaders));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('hosted preflight refuses exposed ingress and wrong deployment before model/fixture work', async () => {
  for (const mode of ['exposed', 'wrong-version', 'redirect']) {
    const output = await mkdtemp(join(tmpdir(), 'hosted-refusal-'));
    let calls = 0;
    try {
      await assert.rejects(
        createHostedBackend(configuration, {
          output,
          transport: async (_, init) => {
            calls++;
            assert.equal(init?.redirect, 'error');
            if (mode === 'redirect') throw new Error('Synthetic redirect blocked');
            if (calls === 1) return new Response('', { status: mode === 'exposed' ? 200 : 403 });
            return reply({ 'x-worker-version': 'another-version' });
          },
        }),
      );
      assert.equal(calls, mode === 'wrong-version' ? 2 : 1);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
});

test('every later hosted response must remain the expected finite sessionless JSON deployment', async () => {
  for (const mode of ['identity', 'session', 'non-json', 'invalid-json', 'oversized']) {
    const output = await mkdtemp(join(tmpdir(), 'hosted-response-'));
    let calls = 0;
    try {
      const backend = await createHostedBackend(configuration, {
        output,
        transport: async () => {
          calls++;
          if (calls === 1) return new Response('', { status: 403 });
          if (calls === 2) return reply();
          if (mode === 'identity') return reply({ 'x-candidate-digest': 'b'.repeat(64) });
          if (mode === 'session') return reply({ 'mcp-session-id': 'persistent' });
          if (mode === 'non-json') return reply({ 'content-type': 'text/plain' });
          return new Response(
            mode === 'oversized' ? 'x'.repeat(524289) : 'private-malformed-contents',
            {
              headers: {
                'x-candidate-digest': digest,
                'x-worker-version': version,
                'content-type': 'application/json',
              },
            },
          );
        },
      });
      await assert.rejects(
        backend.dispatch(request()),
        (error: Error) => !error.message.includes('private-malformed-contents'),
      );
      assert.equal(calls, 3);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
});

test('hosted preparation binds optional private artifact storage and identifies its selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-artifact-config-'));
  try {
    const output = join(directory, 'prepared');
    const manifest = await prepareHosted(output, 'product', {
      artifactBucket: 'synthetic-private-artifacts',
      downloadOrigin: 'https://files.test',
    });
    const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
    assert.deepEqual(config.r2_buckets, [
      { binding: 'ARTIFACTS', bucket_name: 'synthetic-private-artifacts' },
    ]);
    assert.equal(manifest.artifactBucket, 'synthetic-private-artifacts');
    assert.equal(config.vars.ARTIFACT_DOWNLOAD_ORIGIN, 'https://files.test');
    assert.equal(
      manifest.sourceDigest,
      createHash('sha256')
        .update(
          JSON.stringify({
            mode: 'product',
            sourceFiles: manifest.sourceFiles,
            artifactBucket: manifest.artifactBucket,
            downloadOrigin: manifest.downloadOrigin,
          }),
        )
        .digest('hex'),
    );
    assert.ok(manifest.sourceFiles['skills/google-workspace/references/artifacts.md']);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.observability.enabled, false);
    await assert.rejects(
      prepareHosted(join(directory, 'invalid'), 'probes', {
        artifactBucket: 'synthetic-private-artifacts',
      }),
      /requires product/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
