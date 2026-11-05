import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createArtifactStore } from '../../src/artifacts.ts';
import type { ArtifactBucket, ArtifactReference, ArtifactResult } from '../../src/artifacts.ts';

const token = 'synthetic-request-oauth-token-never-store';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function fakeBucket() {
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  let gets = 0;
  let puts = 0;
  let deletes = 0;
  let putHook: (() => Promise<void>) | undefined;
  let deleteHook: (() => Promise<void>) | undefined;
  const bucket = {
    async get(key: string, options?: R2GetOptions) {
      gets++;
      const object = objects.get(key);
      if (!object) return null;
      const range = options?.range as { offset?: number; length?: number } | undefined;
      const bytes = range
        ? object.bytes.subarray(
            range.offset ?? 0,
            (range.offset ?? 0) + (range.length ?? object.bytes.length),
          )
        : object.bytes;
      return {
        size: object.bytes.length,
        customMetadata: object.metadata,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
    async put(key: string, value: Uint8Array, options: R2PutOptions) {
      puts++;
      if (putHook) await putHook();
      const bytes = Buffer.from(value);
      assert.equal(hash(bytes), options.sha256);
      objects.set(key, { bytes, metadata: options.customMetadata! });
      return { size: bytes.length };
    },
    async delete(key: string) {
      deletes++;
      if (deleteHook) await deleteHook();
      objects.delete(key);
    },
  } as unknown as ArtifactBucket;
  return {
    bucket,
    objects,
    stats: () => ({ gets, puts, deletes }),
    onPut: (hook: () => Promise<void>) => {
      putHook = hook;
    },
    onDelete: (hook: () => Promise<void>) => {
      deleteHook = hook;
    },
  };
}
function value<T>(result: ArtifactResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}
function rejected(result: ArtifactResult, code?: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  if (code) assert.equal(result.error.code, code);
  return result.error;
}
const writer = (store: ReturnType<typeof createArtifactStore>) =>
  store.createExecution({ token, canWrite: () => true });
const putJson = (controller: ReturnType<typeof writer>, json: string, name?: string) =>
  controller.invoke('putJson', JSON.stringify({ json, ...(name === undefined ? {} : { name }) }));
const putBytes = (
  controller: ReturnType<typeof writer>,
  bytes: Buffer,
  mimeType = 'application/octet-stream',
) =>
  controller.invoke('putBytes', {
    body: {
      encoding: 'base64url',
      data: bytes.toString('base64url'),
      size: bytes.length,
      sha256: hash(bytes),
      mimeType,
    },
  });

test('canonical JSON stores exact bytes, hashed capability key and descriptor across executions', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket, { now: () => 1000 });
  const controller = writer(store);
  const json = JSON.stringify({ label: 'résumé 📎', items: [1, true, null] });
  const reference = value<ArtifactReference>(await putJson(controller, json, 'listing.json'));
  assert.match(reference.uri, /^artifact:\/\/google-codemode-mcp\/v1\/[A-Za-z0-9_-]{43}$/);
  assert.equal(reference.sha256, hash(json));
  assert.equal(reference.size, Buffer.byteLength(json));
  assert.equal(reference.createdAt, 1000);
  assert.equal(reference.expiresAt, 3_601_000);
  const [key, stored] = [...fake.objects.entries()][0];
  assert.equal(key, 'artifacts/v1/' + hash(reference.uri.split('/').at(-1)!));
  assert.equal(stored.bytes.toString(), json);
  assert.equal(JSON.stringify(stored.metadata).includes(reference.uri.split('/').at(-1)!), false);
  const other = store.createExecution({ token: 'different-google-token', canWrite: () => false });
  assert.deepEqual(value(await other.invoke('readJson', { uri: reference.uri })), JSON.parse(json));
  assert.equal(controller.snapshot().references[0].uri, reference.uri);
});

test('resource manifest and raw chunks independently reassemble JSON and arbitrary binary', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  const controller = writer(store);
  const json = JSON.stringify({ text: 'é📎'.repeat(20_000) });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  for (const [reference, expected] of [
    [value<ArtifactReference>(await putJson(controller, json)), Buffer.from(json)],
    [value<ArtifactReference>(await putBytes(controller, bytes)), bytes],
  ] as const) {
    const manifest = await store.readResource(reference.uri);
    assert.ok('text' in manifest.contents[0]);
    const parsed = JSON.parse(manifest.contents[0].text as string);
    assert.equal(manifest.contents[0].mimeType, 'application/json');
    assert.ok(parsed.firstChunkUri);
    const chunks: Buffer[] = [];
    let uri: string | null = `${reference.uri}/chunk/0/65536`;
    while (uri) {
      const resource = await store.readResource(uri);
      const content = resource.contents[0];
      assert.ok('blob' in content);
      assert.equal(content.mimeType, 'application/octet-stream');
      const chunk = Buffer.from(content.blob as string, 'base64');
      assert.equal(content._meta?.chunkSha256, hash(chunk));
      assert.equal(content._meta?.wholeSha256, hash(expected));
      assert.equal(
        content._meta?.offset,
        chunks.reduce((sum, item) => sum + item.length, 0),
      );
      chunks.push(chunk);
      uri = content._meta?.nextUri as string | null;
    }
    assert.deepEqual(Buffer.concat(chunks), expected);
  }
  const tiny = value<ArtifactReference>(await putJson(controller, '"é"'));
  const second = await store.readResource(`${tiny.uri}/chunk/2/1`);
  assert.ok('blob' in second.contents[0]);
  assert.equal(Buffer.from(second.contents[0].blob as string, 'base64')[0], 0xa9);
  assert.equal(second.contents[0]._meta?.complete, false);
});

test('empty byte artifacts, read type and independent integrity checks', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  const controller = writer(store);
  const reference = value<ArtifactReference>(await putBytes(controller, Buffer.alloc(0)));
  const manifest = await store.readResource(reference.uri);
  assert.ok('text' in manifest.contents[0]);
  assert.equal(JSON.parse(manifest.contents[0].text as string).firstChunkUri, null);
  const body = value<{ data: string; size: number }>(
    await controller.invoke('readBytes', { uri: reference.uri }),
  );
  assert.equal(body.size, 0);
  assert.equal(body.data, '');
  rejected(await controller.invoke('readJson', { uri: reference.uri }), 'ARTIFACT_TYPE');
  const nonempty = value<ArtifactReference>(await putBytes(controller, Buffer.from([0, 255])));
  [...fake.objects.values()].at(-1)!.bytes[0] = 1;
  rejected(await controller.invoke('readBytes', { uri: nonempty.uri }), 'ARTIFACT_INTEGRITY');
});

test('artifact bytes preserve valid vendor MIME without inheriting Drive conversion restrictions', async () => {
  const store = createArtifactStore(fakeBucket().bucket);
  const reference = value<ArtifactReference>(
    await putBytes(writer(store), Buffer.from('{}'), 'application/vnd.google-apps.script+json'),
  );
  assert.equal(reference.mimeType, 'application/vnd.google-apps.script+json');
  const result = value<{ mimeType: string }>(
    await writer(store).invoke('readBytes', { uri: reference.uri }),
  );
  assert.equal(result.mimeType, reference.mimeType);
});

test('raw URI canonical validation rejects normalization, guessed capabilities and invalid ranges privately', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  const reference = value<ArtifactReference>(await putJson(writer(store), '{}'));
  const secret = reference.uri.split('/').at(-1)!;
  for (const uri of [
    reference.uri + '?x=1',
    reference.uri + '#fragment',
    reference.uri + '/',
    reference.uri.replace('/v1/', '/x/../v1/'),
    reference.uri.replace('/v1/', '/v%31/'),
    reference.uri.replace('artifact:', 'ARTIFACT:'),
    reference.uri.replace(secret, secret.slice(0, -1) + '!'),
    reference.uri + '/chunk/00/1',
    reference.uri + '/chunk/0/0',
    reference.uri + '/chunk/0/65537',
    reference.uri + '/chunk/9007199254740992/1',
    reference.uri + '/chunk/999/1',
    'artifact://google-codemode-mcp/v1/' + 'A'.repeat(43),
    'artifact://google-codemode-mcp/v1/' + 'A'.repeat(42) + 'B',
  ])
    await assert.rejects(store.readResource(uri), /Artifact unavailable/);
});

test('application expiry denies read/delete at exact TTL; explicit delete revokes access', async () => {
  const fake = fakeBucket();
  let time = 0;
  const store = createArtifactStore(fake.bucket, { now: () => time });
  const controller = writer(store);
  const reference = value<ArtifactReference>(await putJson(controller, '{}'));
  time = 3_599_999;
  await store.readResource(reference.uri);
  time = 3_600_000;
  await assert.rejects(store.readResource(reference.uri), /Artifact unavailable/);
  rejected(await controller.invoke('delete', { uri: reference.uri }), 'ARTIFACT_UNAVAILABLE');
  assert.equal(fake.objects.size, 1, 'expiry does not claim physical lifecycle deletion');
  time = 0;
  const next = value<ArtifactReference>(await putJson(controller, '[]'));
  assert.deepEqual(value(await controller.invoke('delete', { uri: next.uri })), { deleted: true });
  await assert.rejects(store.readResource(next.uri), /Artifact unavailable/);
});

test('disabled store and write gate fail before put; capabilities authorize read without another Google call', async () => {
  const absent = writer(createArtifactStore());
  rejected(await putJson(absent, '{}'), 'ARTIFACTS_UNAVAILABLE');
  const fake = fakeBucket();
  const denied = createArtifactStore(fake.bucket).createExecution({ token, canWrite: () => false });
  rejected(await putJson(denied, '{}'), 'ARTIFACT_WRITE_DENIED');
  assert.equal(fake.stats().puts, 0);
});

test('strict JSON, byte descriptors, supplied integrity and credential echoes reject before storage', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  for (const json of ['-0', '{"a":1,"a":2}', '{ "a":1}', 'NaN', 'undefined', '{"n":1e400}'])
    rejected(await putJson(writer(store), json), 'ARTIFACT_INVALID');
  const sensitive = writer(store);
  rejected(await putJson(sensitive, JSON.stringify({ token })), 'CREDENTIAL_ECHO');
  rejected(await putJson(writer(store), '{}', token), 'CREDENTIAL_ECHO');
  rejected(await putBytes(writer(store), Buffer.from(token)), 'CREDENTIAL_ECHO');
  const escapedToken = 'synthetic-"quoted\\-credential';
  const escapedWriter = store.createExecution({ token: escapedToken, canWrite: () => true });
  rejected(
    await putJson(escapedWriter, JSON.stringify({ value: escapedToken })),
    'CREDENTIAL_ECHO',
  );
  rejected(
    await writer(store).invoke('putBytes', {
      body: { encoding: 'base64', data: 'Zh==', mimeType: 'text/plain' },
    }),
    'ARTIFACT_INVALID',
  );
  rejected(
    await writer(store).invoke('putBytes', {
      body: { encoding: 'base64', data: '', mimeType: 'text/plain', sha256: '0'.repeat(64) },
    }),
    'ARTIFACT_INVALID',
  );
  assert.equal(fake.stats().puts, 0);
});

test('JSON/byte limits, put-attempt and operation quotas remain bounded', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  const exact = '"' + 'a'.repeat(999_998) + '"';
  value(await putJson(writer(store), exact));
  rejected(await putJson(writer(store), exact + ' '), 'ARTIFACT_LIMIT');
  value(await putBytes(writer(store), Buffer.alloc(131_072)));
  rejected(await putBytes(writer(store), Buffer.alloc(131_073)), 'ARTIFACT_INVALID');
  const attempts = writer(store);
  for (let index = 0; index < 4; index++) rejected(await putJson(attempts, 'invalid'));
  rejected(await putJson(attempts, '{}'), 'ARTIFACT_LIMIT');
  const operations = writer(store);
  for (let index = 0; index < 35; index++) rejected(await operations.invoke('bad', {}));
  assert.equal(operations.snapshot().outcomes.length, 32);
  assert.equal(operations.snapshot().outcomesComplete, false);
});

test('full-read quota counts bytes before retrieval and rejects subsequent reads', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  const reference = value<ArtifactReference>(
    await putJson(writer(store), '"' + 'a'.repeat(999_998) + '"'),
  );
  const reader = writer(store);
  for (let index = 0; index < 4; index++)
    value(await reader.invoke('readJson', { uri: reference.uri }));
  rejected(await reader.invoke('readJson', { uri: reference.uri }), 'ARTIFACT_LIMIT');
});

test('uncertain put/delete preserve separate outcomes and never retry mutations', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  fake.onPut(async () => {
    throw new Error('backend contains private diagnostics');
  });
  const controller = writer(store);
  rejected(await putJson(controller, '{}'), 'ARTIFACT_STORAGE');
  assert.equal(controller.snapshot().outcomes[0].outcome, 'unknown');
  assert.ok(controller.snapshot().outcomes[0].reference?.uri);
  assert.equal(controller.snapshot().hasUnknownOutcome, true);
  assert.equal(JSON.stringify(controller.snapshot()).includes('private diagnostics'), false);
  assert.equal(fake.stats().puts, 1);
  fake.onPut(async () => undefined);
  const reference = value<ArtifactReference>(await putJson(writer(store), '{}'));
  fake.onDelete(async () => {
    throw new Error('delete rejected ambiguously');
  });
  const deleting = writer(store);
  rejected(await deleting.invoke('delete', { uri: reference.uri }), 'ARTIFACT_STORAGE');
  assert.equal(deleting.snapshot().outcomes[0].outcome, 'unknown');
});

test('authoritative conditional collision preserves the existing object and exposes no capability', async () => {
  const fake = fakeBucket();
  let calls = 0;
  fake.bucket.put = (async (key: string, _value: Uint8Array, options: R2PutOptions) => {
    assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
    calls++;
    fake.objects.set(key, { bytes: Buffer.from('preexisting-owner-bytes'), metadata: {} });
    return null;
  }) as unknown as ArtifactBucket['put'];
  const controller = writer(createArtifactStore(fake.bucket));
  rejected(await putJson(controller, '{}'), 'ARTIFACT_COLLISION');
  assert.equal(calls, 1);
  assert.equal(fake.stats().deletes, 0);
  assert.equal([...fake.objects.values()][0].bytes.toString(), 'preexisting-owner-bytes');
  assert.equal(controller.snapshot().outcomes[0].outcome, 'rejected');
  assert.equal(controller.snapshot().outcomes[0].reference, undefined);
  assert.deepEqual(controller.snapshot().references, []);
});

test('acknowledged deletion removes own live link reference while retaining operation history', async () => {
  const controller = writer(createArtifactStore(fakeBucket().bucket));
  const reference = value<ArtifactReference>(await putJson(controller, '{}'));
  assert.equal(controller.snapshot().references.length, 1);
  value(await controller.invoke('delete', { uri: reference.uri }));
  assert.deepEqual(controller.snapshot().references, []);
  assert.deepEqual(
    controller.snapshot().outcomes.map((record) => record.outcome),
    ['stored', 'deleted'],
  );
});

test('close fences new operations and snapshots remain immutable after delayed put cleanup', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.onPut(async () => {
    entered();
    await pending;
  });
  const waiting: Promise<unknown>[] = [];
  const controller = store.createExecution({
    token,
    canWrite: () => true,
    waitUntil: (promise) => {
      waiting.push(promise);
    },
  });
  const result = putJson(controller, '{}');
  await started;
  controller.close();
  const receipt = controller.snapshot();
  assert.equal(receipt.outcomes[0].outcome, 'unknown');
  assert.equal(receipt.outcomes[0].cleanup, 'scheduled');
  assert.ok(receipt.outcomes[0].reference?.uri);
  rejected(
    await controller.invoke('delete', { uri: receipt.outcomes[0].reference!.uri }),
    'ARTIFACT_CLOSED',
  );
  release();
  rejected(await result, 'ARTIFACT_CLOSED');
  await Promise.all(waiting);
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.stats().puts, 1);
  assert.equal(fake.stats().deletes, 1);
  assert.deepEqual(controller.snapshot(), receipt);
  receipt.outcomes[0].outcome = 'stored';
  assert.equal(controller.snapshot().outcomes[0].outcome, 'unknown');
});

test('close during preparation prevents dispatch and during delete retains immutable uncertainty', async () => {
  const fake = fakeBucket();
  const store = createArtifactStore(fake.bucket);
  const preparing = writer(store);
  const pendingPut = putJson(preparing, '{}');
  preparing.close();
  rejected(await pendingPut, 'ARTIFACT_CLOSED');
  assert.equal(fake.stats().puts, 0);
  assert.equal(preparing.snapshot().outcomes[0].outcome, 'not_attempted');
  const reference = value<ArtifactReference>(await putJson(writer(store), '{}'));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.onDelete(async () => {
    entered();
    await hold;
  });
  const deleting = writer(store);
  const pendingDelete = deleting.invoke('delete', { uri: reference.uri });
  await started;
  deleting.close();
  const snapshot = deleting.snapshot();
  assert.equal(snapshot.outcomes[0].outcome, 'unknown');
  release();
  rejected(await pendingDelete, 'ARTIFACT_CLOSED');
  assert.deepEqual(deleting.snapshot(), snapshot);
  assert.equal(fake.stats().deletes, 1);
});
