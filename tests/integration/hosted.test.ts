import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Miniflare } from 'miniflare';
import { createBuiltWorker } from '../support/worker-client.ts';
import { prepareHosted } from '../hosted/prepare.ts';
import { gradeProbe } from '../hosted/verify.ts';
import { SYNTHETIC_TOKEN, PROTOCOL_VERSION, type Probe } from '../hosted/contract.ts';

let directory: string;
let worker: Miniflare;
let candidateDigest: string;
const workerVersion = 'local-synthetic-version';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hosted-harness-'));
  const output = join(directory, 'prepared');
  const manifest = await prepareHosted(output);
  candidateDigest = manifest.sourceDigest;
  assert.equal(manifest.hostedExecution, false);
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.no_bundle, true);
  assert.equal(config.vars.CANDIDATE_DIGEST, candidateDigest);
  assert.deepEqual(config.version_metadata, { binding: 'WORKER_VERSION' });
  assert.equal(config.routes, undefined);
  const bundle = await readFile(join(output, 'worker.js'), 'utf8');
  worker = await createBuiltWorker({
    bundle,
    bindings: {
      CANDIDATE_DIGEST: { type: 'text', value: candidateDigest },
      WORKER_VERSION: { type: 'json', value: { id: workerVersion } },
    },
    outbound: async () => {
      throw new Error('Verification must not access a real network');
    },
  });
});
after(async () => {
  await worker?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function invoke(probe: Probe | string) {
  const response = await worker.dispatchFetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'MCP-Method': 'tools/call',
      'MCP-Name': 'execute',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { accessToken: SYNTHETIC_TOKEN, code: probe, requestId: 'local-test' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  return (await response.json()) as any;
}

test('prepared private harness identity, five calls and healthy followup work locally', async () => {
  for (const probe of ['identity', 'multiple', 'healthy'] as const) {
    const response = await invoke(probe);
    const receipt = response.result?.structuredContent;
    assert.equal(
      gradeProbe(probe, receipt, { candidateDigest, workerVersion }).status,
      'pass',
      JSON.stringify(response),
    );
  }
});

test('delayed and unawaited calls cannot dispatch after production executor closure', async () => {
  for (const probe of ['delayed', 'unawaited', 'healthy'] as const) {
    const response = await invoke(probe);
    assert.equal(
      gradeProbe(probe, response.result?.structuredContent, { candidateDigest, workerVersion })
        .status,
      'pass',
      JSON.stringify(response),
    );
  }
});

test(
  'production fifteen-second async timeout returns and fences its later call',
  { timeout: 25000 },
  async () => {
    const response = await invoke('asyncTimeout');
    assert.equal(
      gradeProbe('asyncTimeout', response.result?.structuredContent, {
        candidateDigest,
        workerVersion,
      }).status,
      'pass',
      JSON.stringify(response),
    );
    const followup = await invoke('healthy');
    assert.equal(
      gradeProbe('healthy', followup.result?.structuredContent, { candidateDigest, workerVersion })
        .status,
      'pass',
      JSON.stringify(followup),
    );
  },
);

test('verification Worker rejects arbitrary programs and has no public product test route', async () => {
  const response = await invoke('return 123');
  assert.ok(response.error || response.result?.isError, JSON.stringify(response));
  assert.equal((await worker.dispatchFetch('http://localhost/test')).status, 404);
});

test('CPU qualification needs an explicit platform CPU exception and correct identity', async () => {
  // Never execute an infinite CPU loop in local workerd; local runtime does not enforce CPU limits.
  const response = await invoke('identity');
  const receipt = response.result.structuredContent;
  receipt.probe = 'cpu';
  receipt.execution.status = 'error';
  for (const error of [
    'Execution timed out',
    'Worker exceeded resource limits',
    'Execution failed',
  ]) {
    receipt.executorSignal = { kind: 'threw', error };
    assert.equal(gradeProbe('cpu', receipt, { candidateDigest, workerVersion }).status, 'unknown');
  }
  receipt.executorSignal = { kind: 'threw', error: 'Worker exceeded the CPU time limit' };
  assert.equal(gradeProbe('cpu', receipt, { candidateDigest, workerVersion }).status, 'pass');
  receipt.executorSignal.kind = 'returned';
  assert.equal(gradeProbe('cpu', receipt, { candidateDigest, workerVersion }).status, 'unknown');
  assert.equal(
    gradeProbe('cpu', receipt, { candidateDigest, workerVersion: 'wrong-version' }).status,
    'fail',
  );
  assert.equal(gradeProbe('cpu', null, { candidateDigest, workerVersion }).status, 'unknown');
});

test('runner retains a redacted ingress failure and stops before stress probes without retry', async () => {
  const { verifyHosted } = await import('../hosted/verify.ts');
  const names = [
    'HOSTED_VERIFICATION_URL',
    'HOSTED_ACCESS_HEADERS_JSON',
    'HOSTED_EXPECTED_CANDIDATE_DIGEST',
    'HOSTED_EXPECTED_WORKER_VERSION',
    'HOSTED_PREPARED_DIR',
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  Object.assign(process.env, {
    HOSTED_VERIFICATION_URL: 'https://protected.example.invalid/mcp',
    HOSTED_ACCESS_HEADERS_JSON: JSON.stringify({ Authorization: 'Bearer PRIVATE_HARNESS_TEST' }),
    HOSTED_EXPECTED_CANDIDATE_DIGEST: candidateDigest,
    HOSTED_EXPECTED_WORKER_VERSION: workerVersion,
    HOSTED_PREPARED_DIR: join(directory, 'prepared'),
  });
  globalThis.fetch = async (_input, init) => {
    requests++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer PRIVATE_HARNESS_TEST');
    assert.equal(headers.get('mcp-protocol-version'), PROTOCOL_VERSION);
    assert.equal(init?.redirect, 'manual');
    assert.equal(JSON.parse(String(init?.body)).params.arguments.code, 'identity');
    return new Response('Ingress unavailable: Bearer PRIVATE_HARNESS_TEST', { status: 503 });
  };
  try {
    const output = join(directory, 'ingress-failure');
    const report = await verifyHosted(output);
    assert.equal(requests, 1);
    assert.equal(report.status, 'unknown');
    assert.equal(report.hostedQualified, false);
    const saved = await readFile(join(output, '01-identity.json'), 'utf8');
    assert.ok(saved.includes('[REDACTED]'));
    assert.ok(!saved.includes('PRIVATE_HARNESS_TEST'));
    assert.ok(
      (await readFile(join(output, 'prepared-manifest.json'), 'utf8')).includes(candidateDigest),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
