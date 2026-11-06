import { createHash } from 'node:crypto';
import { MAX_STREAM_BYTES } from './storage.ts';
import { validMimeType } from './media.ts';
import type { ArtifactReference } from './artifacts.ts';

export interface ImportMetadata {
  size: number;
  sha256: string;
  mimeType: string;
  name?: string;
}

/** Complete a client-uploaded staging object without moving its body over RPC. */
export async function completeUpload(
  bucket: R2Bucket,
  uri: string,
  owner: string,
  expected: ImportMetadata,
): Promise<ArtifactReference> {
  const secret = /^artifact:\/\/google-codemode-mcp\/v2\/([A-Za-z0-9_-]{43})$/.exec(uri)?.[1];
  if (
    !secret ||
    Buffer.from(secret, 'base64url').toString('base64url') !== secret ||
    !/^[a-f0-9]{64}$/.test(owner) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > MAX_STREAM_BYTES ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !validMimeType(expected.mimeType) ||
    (expected.name !== undefined &&
      (typeof expected.name !== 'string' ||
        Buffer.byteLength(expected.name) > 256 ||
        /[\x00-\x1f\x7f]/.test(expected.name)))
  )
    throw new Error('ARTIFACT_INVALID');
  const key = 'artifacts/v2/' + createHash('sha256').update(secret).digest('hex');
  // The signed PUT is create-only. Do not delete or replace it on a failed check:
  // its grant may still be in use. Expiry/lifecycle handles abandoned staging data.
  const object = await bucket.get(key + '/data');
  if (!object) throw new Error('ARTIFACT_UNAVAILABLE');
  const reader = object.body.getReader();
  const deadline = AbortSignal.timeout(15000);
  const cancel = () => void reader.cancel().catch(() => undefined);
  deadline.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const hash = createHash('sha256');
  try {
    if (object.size !== expected.size) throw new Error('ARTIFACT_INTEGRITY');
    for (;;) {
      const { done, value } = await reader.read();
      deadline.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > expected.size) throw new Error('ARTIFACT_INTEGRITY');
      hash.update(value);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256)
      throw new Error('ARTIFACT_INTEGRITY');
  } finally {
    deadline.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const createdAt = Date.now();
  const reference: ArtifactReference = {
    uri,
    kind: 'bytes',
    ...expected,
    createdAt,
    expiresAt: createdAt + 3600000,
    complete: true,
  };
  const { uri: _uri, ...manifest } = reference;
  const result = await bucket.put(key + '/manifest', JSON.stringify({ ...manifest, v: 2, owner }), {
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (!result) {
    // A lost finalize response can be reconciled without replaying a Google write.
    const existing = await bucket.get(key + '/manifest');
    const saved = existing ? await existing.json<typeof manifest & { owner: string }>() : null;
    if (
      !saved ||
      saved.owner !== owner ||
      saved.sha256 !== expected.sha256 ||
      saved.size !== size ||
      saved.expiresAt <= Date.now()
    )
      throw new Error('ARTIFACT_UNAVAILABLE');
    return { ...reference, createdAt: saved.createdAt, expiresAt: saved.expiresAt };
  }
  return reference;
}
