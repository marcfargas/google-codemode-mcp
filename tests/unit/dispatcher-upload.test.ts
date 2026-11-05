import { readMultipart } from '../support/multipart.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DiscoveryCatalog } from '../../src/discovery.ts';
import type { DiscoveryDocument } from '../../src/discovery.ts';
import { createDispatcher } from '../../src/dispatcher.ts';
import { MAX_UPLOAD_BYTES, MEDIA_SKILL_URI } from '../../src/media.ts';

function fixture(): DiscoveryDocument {
  return {
    name: 'drive',
    version: 'v3',
    rootUrl: 'https://www.googleapis.com/',
    servicePath: 'drive/v3/',
    parameters: { fields: { type: 'string' } },
    schemas: {
      File: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          mimeType: { type: 'string' },
          parents: { type: 'array', items: { type: 'string' } },
          id: { type: 'string' },
        },
      },
    },
    resources: {
      files: {
        methods: {
          create: {
            path: 'files',
            httpMethod: 'POST',
            request: { $ref: 'File' },
            response: { $ref: 'File' },
            supportsMediaUpload: true,
            mediaUpload: {
              accept: ['*/*'],
              protocols: { simple: { multipart: true, path: '/upload/drive/v3/files' } },
            },
          },
          update: {
            path: 'files/{fileId}',
            httpMethod: 'PATCH',
            parameters: { fileId: { type: 'string', required: true, location: 'path' } },
            request: { $ref: 'File' },
            response: { $ref: 'File' },
            supportsMediaUpload: true,
            mediaUpload: {
              protocols: { simple: { multipart: true, path: '/upload/drive/v3/files/{fileId}' } },
            },
          },
          get: {
            path: 'files/{fileId}',
            httpMethod: 'GET',
            parameters: { fileId: { type: 'string', required: true, location: 'path' } },
            response: { $ref: 'File' },
          },
        },
      },
    },
  };
}

const catalog = () => new DiscoveryCatalog({ documents: { 'drive/v3': fixture() } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const input = (bytes: Buffer, encoding: 'base64' | 'base64url' = 'base64') => ({
  requestBody: { name: 'résumé 📎.bin', parents: ['target-folder'] },
  fields: 'id,name,mimeType',
  media: {
    mimeType: 'application/octet-stream',
    body: {
      encoding,
      data: bytes.toString(encoding),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  },
});

test('native Discovery SDK emits exact binary multipart metadata and zero-byte uploads', async () => {
  let requests = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: 'inert-test-token',
    requestId: 'upload',
    transport: async (url, init) => {
      requests++;
      const target = new URL(String(url));
      assert.equal(
        target.origin + target.pathname,
        'https://www.googleapis.com/upload/drive/v3/files',
      );
      assert.equal(target.searchParams.get('uploadType'), 'multipart');
      assert.equal(target.searchParams.get('fields'), 'id,name,mimeType');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer inert-test-token');
      assert.match(headers.get('content-type')!, /^multipart\/related; boundary=/);
      assert.ok(init?.body instanceof Uint8Array);
      const decoded = readMultipart(init.body, headers.get('content-type')!);
      assert.deepEqual(decoded.metadata, { name: 'résumé 📎.bin', parents: ['target-folder'] });
      assert.equal(decoded.headers, 'content-type: application/octet-stream');
      const expected =
        requests === 1
          ? Buffer.from(Array.from({ length: 256 }, (_, index) => index))
          : Buffer.alloc(0);
      assert.deepEqual(decoded.bytes, expected);
      return json({ id: `file-${requests}` });
    },
  });
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const caller = input(allBytes, 'base64url');
  assert.equal((await dispatcher.call('drive/v3/files.create', caller)).ok, true);
  assert.equal(caller.media.body.data, allBytes.toString('base64url'));
  assert.equal((await dispatcher.call('drive/v3/files.create', input(Buffer.alloc(0)))).ok, true);
  assert.equal(requests, 2);
  assert.deepEqual(
    dispatcher.outcomes.map((record) => record.outcome),
    ['acknowledged', 'acknowledged'],
  );
});

test('upload descriptions and declarations expose the same create-only byte contract', async () => {
  const discovery = catalog();
  const create = await discovery.describe('drive/v3/files.create');
  const runtime = create.runtime as Record<string, unknown>;
  assert.equal(runtime.mediaUpload, true);
  assert.equal(runtime.maxUploadBytes, MAX_UPLOAD_BYTES);
  assert.equal(runtime.skill, MEDIA_SKILL_URI);
  assert.match(create.declarations as string, /"encoding": "base64" \| "base64url"/);
  assert.match(create.declarations as string, /requestBody: NonNullable/);
  assert.ok(Object.hasOwn(create.parameters as object, 'media'));
  const update = await discovery.describe('drive/v3/files.update');
  assert.equal((update.runtime as Record<string, unknown>).mediaUpload, false);
  assert.equal(Object.hasOwn(update.parameters as object, 'media'), false);
  const native = fixture();
  delete native.resources!.files.methods!.create.mediaUpload;
  const noProtocol = new DiscoveryCatalog({ documents: { 'drive/v3': native } });
  assert.equal(
    ((await noProtocol.describe('drive/v3/files.create')).runtime as Record<string, unknown>)
      .mediaUpload,
    false,
  );
});

test('unsupported uploads, transport aliases and invalid envelopes never reach fetch', async () => {
  let calls = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: 'test-token',
    requestId: 'refuse',
    transport: async () => {
      calls++;
      return json({ id: 'unexpected' });
    },
  });
  const good = input(Buffer.from([0, 255]));
  for (const params of [
    { ...good, requestBody: undefined },
    { ...good, requestBody: { mimeType: 'application/vnd.google-apps.document' } },
    { ...good, media: { mimeType: 'text/plain\r\nX:bad', body: good.media.body } },
    { ...good, media: { ...good.media, body: { ...good.media.body, size: 100 } } },
    { ...good, media: { ...good.media, body: { encoding: 'base64', data: 'Zh==' } } },
    {
      ...good,
      media: { ...good.media, body: { encoding: 'base64', data: '', url: 'https://example.com' } },
    },
    { ...good, media: { ...good.media, body: 'raw string' } },
    { ...good, uploadType: 'resumable' },
    { ...good, media_: good.media },
    { ...good, headers: { Authorization: 'Bearer attacker' } },
    {
      ...good,
      media: {
        ...good.media,
        body: { encoding: 'base64', data: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64') },
      },
    },
    { ...good, requestBody: { name: 'é'.repeat(32768) } },
    { ...good, fields: 'x'.repeat(2097152) },
  ]) {
    const result = await dispatcher.call('drive/v3/files.create', params);
    assert.equal(result.ok, false);
    assert.equal(dispatcher.outcomes.at(-1)?.outcome, 'not_dispatched');
  }
  assert.equal(
    (await dispatcher.call('drive/v3/files.update', { ...good, fileId: 'file' })).ok,
    false,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await dispatcher.call('drive/v3/files.create', { requestBody: { name: 'metadata only' } })).ok,
    true,
  );
  assert.equal(calls, 1);
});

test('execution upload budget counts rejected attempts and blocks the ninth full file', async () => {
  let calls = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: 'test-token',
    requestId: 'budget',
    transport: async () => {
      calls++;
      return json({ error: { message: 'denied' } }, 403);
    },
  });
  const params = input(Buffer.alloc(MAX_UPLOAD_BYTES, 255));
  for (let index = 0; index < 8; index++) {
    assert.equal((await dispatcher.call('drive/v3/files.create', params)).ok, false);
    assert.equal(dispatcher.outcomes.at(-1)?.outcome, 'rejected');
  }
  assert.equal((await dispatcher.call('drive/v3/files.create', params)).ok, false);
  assert.equal(dispatcher.outcomes.at(-1)?.outcome, 'not_dispatched');
  assert.equal(calls, 8);
});

test('unknown upload fences queued writes while reads continue; acknowledged response failure remains acknowledged', async () => {
  let calls = 0;
  const unknown = createDispatcher({
    catalog: catalog(),
    accessToken: 'test-token',
    requestId: 'unknown',
    transport: async () => {
      calls++;
      return calls === 1 ? json({}, 500) : json({ id: 'read' });
    },
  });
  const params = input(Buffer.from([0]));
  await Promise.all([
    unknown.call('drive/v3/files.create', params),
    unknown.call('drive/v3/files.create', params),
  ]);
  assert.deepEqual(
    unknown.outcomes.map((value) => value.outcome),
    ['unknown', 'not_dispatched'],
  );
  assert.equal((await unknown.call('drive/v3/files.get', { fileId: 'file' })).ok, true);
  assert.equal(calls, 2);
  const acknowledged = createDispatcher({
    catalog: catalog(),
    accessToken: 'test-token',
    requestId: 'ack',
    limits: { maxResponseBytes: 8 },
    transport: async () => json({ id: 'accepted-but-response-too-large' }),
  });
  assert.equal((await acknowledged.call('drive/v3/files.create', params)).ok, false);
  assert.equal(acknowledged.outcomes[0].outcome, 'acknowledged');
  assert.equal(acknowledged.hasUnknownOutcome, false);
});

test('all native parameters are size-bounded and non-JSON parameters never dispatch', async () => {
  let calls = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: 'test-token',
    requestId: 'parameters',
    transport: async () => {
      calls++;
      return json({ id: 'unreachable' });
    },
  });
  const oversized = await dispatcher.call('drive/v3/files.get', {
    fileId: 'file',
    fields: 'x'.repeat(2 * 1024 * 1024),
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, 'REQUEST_LIMIT');
  const invalid = await dispatcher.call('drive/v3/files.create', { requestBody: { name: 1n } });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_PARAMS');
  assert.equal(calls, 0);
  assert.ok(dispatcher.outcomes.every((outcome) => outcome.outcome === 'not_dispatched'));
});
