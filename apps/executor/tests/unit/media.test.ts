import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_METADATA_BYTES,
  MAX_UPLOAD_PARAMS_BYTES,
  MAX_UPLOAD_WIRE_BYTES,
  prepareUpload,
  uploadWireBody,
  normalizeUploadWire,
  validMimeType,
} from '../../src/media.ts';

const params = (data = '', encoding = 'base64') => ({
  requestBody: { name: 'attachment.bin', parents: ['folder'] },
  media: { mimeType: 'application/octet-stream', body: { encoding, data } },
});

test('canonical base64 and base64url preserve every byte, empty bytes and optional valid padding', async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  for (const encoding of ['base64', 'base64url'] as const) {
    for (const data of [bytes.toString(encoding), bytes.toString(encoding).replace(/=+$/, '')]) {
      const input = params(data, encoding);
      Object.assign(input.media.body, {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mimeType: input.media.mimeType,
      });
      assert.deepEqual(Buffer.from((await prepareUpload(input)).bytes), bytes);
    }
  }
  assert.equal((await prepareUpload(params())).bytes.length, 0);
  assert.deepEqual(Array.from((await prepareUpload(params('_w==', 'base64url'))).bytes), [255]);
});

test('noncanonical, mixed, malformed and mismatched byte descriptors fail before upload', async () => {
  for (const [data, encoding] of [
    ['Zh==', 'base64'],
    ['Zg=', 'base64'],
    ['Zg===', 'base64'],
    ['Zg==\n', 'base64'],
    ['a', 'base64'],
    ['_w==', 'base64'],
    ['/w==', 'base64url'],
    ['Zg==', 'hex'],
  ])
    await assert.rejects(prepareUpload(params(data, encoding)));
  for (const extra of [
    { size: 2 },
    { size: 1.5 },
    { sha256: '0'.repeat(64) },
    { sha256: 'A'.repeat(64) },
    { mimeType: 'text/plain' },
    { url: 'https://example.com' },
  ]) {
    const input = params('Zg==');
    Object.assign(input.media.body, extra);
    await assert.rejects(prepareUpload(input));
  }
});

test('MIME validation rejects controls, malformed parameters and conversion', async () => {
  for (const mime of [
    'text/plain',
    'text/plain; charset=UTF-8',
    'image/svg+xml',
    'text/plain; name="a b"',
  ])
    assert.ok(validMimeType(mime), mime);
  for (const mime of [
    'text',
    'text/',
    ' text/plain',
    'text/plain\r\nX: evil',
    'text/plain; bad',
    'text/plain; x="unterminated',
  ])
    assert.equal(validMimeType(mime), false, mime);
  for (const update of [
    { requestBody: { mimeType: 'application/vnd.google-apps.document' } },
    { requestBody: { mimeType: 'text/plain' } },
    { requestBody: null },
    { requestBody: [] },
    {
      media: {
        mimeType: 'application/vnd.google-apps.document',
        body: { encoding: 'base64', data: '' },
      },
    },
  ])
    await assert.rejects(prepareUpload({ ...params(), ...update }));
});

test('decoded bytes and UTF-8 metadata/parameter bounds are enforced exactly', async () => {
  const exact = params(Buffer.alloc(MAX_UPLOAD_BYTES, 255).toString('base64'));
  assert.equal((await prepareUpload(exact)).bytes.length, MAX_UPLOAD_BYTES);
  await assert.rejects(
    prepareUpload(params(Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64'))),
  );
  const prefix = Buffer.byteLength(JSON.stringify({ name: '' }));
  const input = {
    ...params(),
    requestBody: { name: 'a'.repeat(MAX_UPLOAD_METADATA_BYTES - prefix) },
  };
  await prepareUpload(input);
  input.requestBody.name += 'é';
  await assert.rejects(prepareUpload(input));
  await assert.rejects(prepareUpload({ ...params(), fields: 'a'.repeat(MAX_UPLOAD_PARAMS_BYTES) }));
});

test('bounded SDK wire collection preserves bytes and refuses oversized or invalid streams', async () => {
  const bytes = Buffer.alloc(MAX_UPLOAD_WIRE_BYTES, 255);
  assert.deepEqual(Buffer.from(await uploadWireBody(Readable.from([bytes]))), bytes);
  await assert.rejects(uploadWireBody(Readable.from([bytes, Buffer.from([0])])));
  await assert.rejects(uploadWireBody({ data: 'not a stream' }));
  await assert.rejects(uploadWireBody(Readable.from([{ bad: true }])));
});

test('multipart normalization accepts only exact native output or the verified missing flush footer', () => {
  const metadataJson = '{"name":"résumé.bin","parents":["folder"]}';
  const mimeType = 'application/octet-stream';
  const type = 'multipart/related; boundary=native-boundary';
  const prefix = Buffer.from(
    '--native-boundary\r\ncontent-type: application/json\r\n\r\n' +
      metadataJson +
      '\r\n--native-boundary\r\ncontent-type: application/octet-stream\r\n\r\n',
  );
  const footer = Buffer.from('\r\n--native-boundary--');
  for (const length of [0, MAX_UPLOAD_BYTES]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
    const upload = { metadataJson, mimeType, bytes };
    const truncated = Buffer.concat([prefix, bytes]);
    const complete = Buffer.concat([truncated, footer]);
    assert.deepEqual(Buffer.from(normalizeUploadWire(complete, type, upload)), complete);
    assert.deepEqual(Buffer.from(normalizeUploadWire(truncated, type, upload)), complete);
    for (const wire of [
      complete.subarray(0, complete.length - 1),
      truncated.subarray(0, truncated.length - 1),
      Buffer.concat([complete, footer]),
      Buffer.from(complete).fill(0, 0, 1),
    ])
      assert.throws(() => normalizeUploadWire(wire, type, upload));
    assert.throws(() => normalizeUploadWire(complete, type, { ...upload, metadataJson: '{}' }));
    assert.throws(() => normalizeUploadWire(complete, type, { ...upload, mimeType: 'text/plain' }));
    for (const invalid of [
      null,
      'multipart/form-data; boundary=native-boundary',
      type + '\r\nInjected: yes',
      'multipart/related; boundary=other',
    ])
      assert.throws(() => normalizeUploadWire(complete, invalid, upload));
  }
  assert.throws(() =>
    normalizeUploadWire(new Uint8Array(MAX_UPLOAD_WIRE_BYTES), type, {
      metadataJson,
      mimeType,
      bytes: new Uint8Array(MAX_UPLOAD_WIRE_BYTES),
    }),
  );
});
