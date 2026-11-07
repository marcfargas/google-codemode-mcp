import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createStreamArtifactStore } from '../../src/stream-artifacts.ts';
import type { Storage } from '../../src/storage.ts';
import { composeReferenceMime, decodeGmailAttachment } from '../../src/reference-mime.ts';

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage: Storage = {
    async read(key) {
      const bytes = objects.get(key);
      return bytes ? { body: new Response(bytes).body!, size: bytes.length } : null;
    },
    async write(key, body) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, bytes);
      return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { storage, objects };
}
const content = () => new Response('small file').body!;
const metadata = { mimeType: 'text/plain' };

test('stream handles bind trusted owners across token rotation, resource reads and expiry', async () => {
  const { storage, objects } = memoryStorage();
  let now = 1000;
  const store = (owner?: string) => createStreamArtifactStore(storage, { owner, now: () => now });
  const first = store('account-a').createExecution({ token: 'old-token' });
  const ref = await first.put(content(), metadata);
  first.close();
  const next = store('account-a').createExecution({ token: 'new-token' });
  assert.equal((await next.readBytes(ref.uri)).data, Buffer.from('small file').toString('base64'));
  for (const owner of ['account-b', undefined]) {
    await assert.rejects(store(owner).readResource(ref.uri), /ARTIFACT_UNAVAILABLE/);
    await assert.rejects(
      store(owner).createExecution({ token: 'other' }).open(ref.uri),
      /ARTIFACT_UNAVAILABLE/,
    );
  }
  assert.equal(
    JSON.parse(
      ((await store('account-a').readResource(ref.uri)).contents[0] as { text: string }).text,
    ).size,
    10,
  );
  now = ref.expiresAt;
  await assert.rejects(store('account-a').readResource(ref.uri), /ARTIFACT_UNAVAILABLE/);
  now = 1000;
  await next.delete(ref.uri);
  assert.equal(objects.size, 0);
  next.close();
});

test('stream reads reject corrupt content, oversized bridge reads and split credential echoes', async () => {
  const { storage, objects } = memoryStorage();
  const store = createStreamArtifactStore(storage);
  const session = store.createExecution({ token: 'credential-canary' });
  const leaked = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(Buffer.from('prefix credential-'));
      c.enqueue(Buffer.from('canary suffix'));
      c.close();
    },
  });
  await assert.rejects(session.put(leaked, metadata), /ARTIFACT_CREDENTIAL_ECHO/);
  assert.equal(objects.size, 0);
  const ref = await session.put(content(), metadata);
  const key = [...objects.keys()].find((key) => key.endsWith('/data'))!;
  objects.get(key)![0] ^= 1;
  await assert.rejects(session.readBytes(ref.uri), /ARTIFACT_INTEGRITY/);
  await session.delete(ref.uri);
  const large = await session.put(new Response(new Uint8Array(131073)).body!, metadata);
  await assert.rejects(session.readBytes(large.uri), /ARTIFACT_LIMIT/);
  await session.delete(large.uri);
  assert.equal(objects.size, 0);
  session.close();
});

test('closing during a late manifest commit seals unknown outcome and cleans both objects', async () => {
  const { storage, objects } = memoryStorage();
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const delayed: Storage = {
    ...storage,
    async write(key, body, options) {
      if (key.endsWith('/manifest')) {
        reached();
        await blocked;
      }
      return storage.write(key, body, options);
    },
  };
  const session = createStreamArtifactStore(delayed).createExecution({ token: 'unused' });
  const pending = session.put(content(), metadata);
  await ready;
  session.close();
  const sealed = session.snapshot();
  assert.equal(sealed.outcomes[0].outcome, 'unknown');
  assert.equal(sealed.references.length, 0);
  release();
  await assert.rejects(pending, /ARTIFACT_CLOSED/);
  assert.equal(objects.size, 0);
  assert.deepEqual(session.snapshot(), sealed);
});

test('trusted MIME composition verifies references, headers, owner, MIME and aggregate bounds', async () => {
  const { storage, objects } = memoryStorage();
  const session = createStreamArtifactStore(storage, { owner: 'a' }).createExecution({
    token: 'canary',
  });
  const source = await session.put(new Response(new Uint8Array(262144)).body!, metadata);
  const message = {
    to: 'recipient@example.test',
    subject: 'Résumé',
    text: 'Body',
    attachments: [{ artifact: source.uri, name: 'résumé.bin', mimeType: 'text/plain' }],
  };
  const signal = new AbortController().signal;
  const mime = await composeReferenceMime(message, session, signal);
  assert.equal(mime.mimeType, 'message/rfc822');
  assert.ok(mime.size > source.size);
  for (const input of [
    { ...message, to: 'recipient@example.test\r\nBcc: injected@example.test' },
    { ...message, attachments: [{ ...message.attachments[0], name: 'bad\nname' }] },
    { ...message, attachments: [{ ...message.attachments[0], mimeType: 'text/html' }] },
    { ...message, attachments: Array(5).fill(message.attachments[0]) },
    {
      ...message,
      attachments: [{ ...message.attachments[0], artifact: 'https://example.test/file' }],
    },
  ])
    await assert.rejects(composeReferenceMime(input, session, signal));
  const other = createStreamArtifactStore(storage, { owner: 'b' }).createExecution({
    token: 'canary',
  });
  await assert.rejects(composeReferenceMime(message, other, signal), /ARTIFACT_UNAVAILABLE/);
  const key = [...objects.keys()].find((key) => key.endsWith('/data'))!;
  objects.get(key)![0] ^= 1;
  await assert.rejects(composeReferenceMime(message, session, signal), /ARTIFACT_INTEGRITY/);
  session.close();
  other.close();
});

test('Gmail attachment JSON adapter requires canonical base64url and exact decoded native size', () => {
  const bytes = Buffer.alloc(1024 * 1024, 255);
  assert.deepEqual(
    decodeGmailAttachment({ data: bytes.toString('base64url'), size: bytes.length }),
    bytes,
  );
  for (const body of [
    { data: 'Zh==', size: 1 },
    { data: 'Zg=', size: 1 },
    { data: '/w==', size: 1 },
    { data: 'Zg', size: 2 },
    { data: 'Zg', size: -1 },
    { data: 'Zg', size: 1.5 },
    { data: Buffer.alloc(bytes.length + 1).toString('base64url'), size: bytes.length + 1 },
  ])
    assert.throws(() => decodeGmailAttachment(body));
  assert.equal(decodeGmailAttachment({ data: '', size: 0 }).length, 0);
});
