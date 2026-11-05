import type { ReadResourceResult } from '@modelcontextprotocol/server';
import { prepareUpload, validMimeType } from './media.ts';

export const ARTIFACTS_CAPABILITIES = {
  operations: ['putJson', 'putBytes', 'readJson', 'readBytes', 'delete'],
  access: 'capability-possession',
  ttlSeconds: 3600,
  limits: {
    jsonBytes: 1_000_000,
    bytes: 131_072,
    putAttempts: 4,
    putBytes: 4_000_000,
    operations: 32,
    readBytes: 4_000_000,
    chunkBytes: 65_536,
  },
  skill: 'skill://google-codemode-mcp/google-workspace/references/artifacts.md',
} as const;

export type ArtifactBucket = Pick<R2Bucket, 'get' | 'put' | 'delete'>;
export interface ArtifactReference {
  uri: string;
  kind: 'json' | 'bytes';
  mimeType: string;
  name?: string;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  complete: true;
}
export interface ArtifactOutcome {
  operationId: string;
  operation: string;
  outcome: 'not_attempted' | 'rejected' | 'stored' | 'read' | 'deleted' | 'unknown';
  reference?: ArtifactReference;
  error?: string;
  cleanup?: 'scheduled';
}
export type ArtifactResult =
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

class ArtifactError extends Error {
  code: string;
  constructor(code: string) {
    super(code === 'ARTIFACT_UNAVAILABLE' ? 'Artifact unavailable' : 'Artifact operation failed');
    this.code = code;
  }
}
function fail(code = 'ARTIFACT_INVALID'): never {
  throw new ArtifactError(code);
}
const encoder = new TextEncoder();
const limits = ARTIFACTS_CAPABILITIES.limits;
const prefix = 'artifact://google-codemode-mcp/v1/';
const canonicalSecret = /^[A-Za-z0-9_-]{43}$/;
const encode = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const digest = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

function inputObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (JSON.stringify(parsed) !== value) fail();
      value = parsed;
    } catch {
      fail();
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) fail();
  return object;
}

function displayName(value: unknown): string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    encoder.encode(value).length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail();
  return value;
}

/** Check the raw URI before URL parsing can normalize traversal or escapes. */
async function capability(uri: unknown) {
  if (typeof uri !== 'string') fail('ARTIFACT_UNAVAILABLE');
  const match =
    /^artifact:\/\/google-codemode-mcp\/v1\/([A-Za-z0-9_-]{43})(?:\/chunk\/(0|[1-9][0-9]*)\/([1-9][0-9]*))?$/.exec(
      uri,
    );
  if (!match || !canonicalSecret.test(match[1])) fail('ARTIFACT_UNAVAILABLE');
  const secret = match[1];
  if (
    encode(
      Uint8Array.from(atob(secret.replace(/-/g, '+').replace(/_/g, '/')), (s) => s.charCodeAt(0)),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') !== secret
  )
    fail('ARTIFACT_UNAVAILABLE');
  const offset = match[2] === undefined ? undefined : Number(match[2]);
  const length = match[3] === undefined ? undefined : Number(match[3]);
  if (
    (offset !== undefined && !Number.isSafeInteger(offset)) ||
    (length !== undefined && (!Number.isSafeInteger(length) || length > limits.chunkBytes))
  )
    fail('ARTIFACT_UNAVAILABLE');
  return {
    uri: prefix + secret,
    key: 'artifacts/v1/' + (await digest(encoder.encode(secret))),
    offset,
    length,
  };
}

function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (!needle.length) return false;
  const table = new Uint32Array(needle.length);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j && needle[i] !== needle[j]) j = table[j - 1];
    if (needle[i] === needle[j]) j++;
    table[i] = j;
  }
  for (let i = 0, j = 0; i < haystack.length; i++) {
    while (j && haystack[i] !== needle[j]) j = table[j - 1];
    if (haystack[i] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

async function collect(object: R2ObjectBody, expected: number): Promise<Uint8Array> {
  const reader = object.body.getReader();
  const result = new Uint8Array(expected);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > expected) fail('ARTIFACT_INTEGRITY');
      result.set(value, received);
      received += value.length;
    }
    if (received !== expected) fail('ARTIFACT_INTEGRITY');
    return result;
  } catch {
    await reader.cancel().catch(() => undefined);
    fail('ARTIFACT_INTEGRITY');
  } finally {
    reader.releaseLock();
  }
}

export function createArtifactStore(bucket?: ArtifactBucket, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;

  async function load(uri: unknown, chunk = false) {
    if (!bucket) fail('ARTIFACTS_UNAVAILABLE');
    const parsed = await capability(uri);
    if (!chunk && parsed.offset !== undefined) fail('ARTIFACT_UNAVAILABLE');
    let stored: R2ObjectBody | null;
    try {
      stored = await bucket.get(parsed.key);
    } catch {
      fail('ARTIFACT_UNAVAILABLE');
    }
    if (!stored) fail('ARTIFACT_UNAVAILABLE');
    let reference: ArtifactReference;
    try {
      const metadata = JSON.parse(
        stored.customMetadata?.artifact ?? 'null',
      ) as ArtifactReference | null;
      if (
        !metadata ||
        (metadata.kind !== 'json' && metadata.kind !== 'bytes') ||
        !validMimeType(metadata.mimeType) ||
        metadata.complete !== true ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        metadata.size > (metadata.kind === 'json' ? limits.jsonBytes : limits.bytes) ||
        metadata.size !== stored.size ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        !Number.isSafeInteger(metadata.createdAt) ||
        !Number.isSafeInteger(metadata.expiresAt) ||
        metadata.expiresAt - metadata.createdAt !== 3_600_000 ||
        metadata.expiresAt <= now() ||
        (metadata.kind === 'json' && metadata.mimeType !== 'application/json')
      )
        fail('ARTIFACT_UNAVAILABLE');
      reference = { ...metadata, uri: parsed.uri };
    } catch {
      await stored.body.cancel().catch(() => undefined);
      fail('ARTIFACT_UNAVAILABLE');
    }
    return { ...parsed, stored, reference };
  }

  async function fullRead(uri: unknown, reserve: (size: number) => void) {
    const loaded = await load(uri);
    try {
      reserve(loaded.reference.size);
    } catch (error) {
      await loaded.stored.body.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = await collect(loaded.stored, loaded.reference.size);
    if ((await digest(bytes)) !== loaded.reference.sha256) fail('ARTIFACT_INTEGRITY');
    return { ...loaded, bytes };
  }

  return {
    async readResource(uri: string): Promise<ReadResourceResult> {
      const loaded = await load(uri, true);
      const { reference, offset, length } = loaded;
      await loaded.stored.body.cancel().catch(() => undefined);
      if (offset === undefined) {
        const firstChunkUri = reference.size
          ? `${reference.uri}/chunk/0/${Math.min(reference.size, limits.chunkBytes)}`
          : null;
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ ...reference, firstChunkUri }),
            },
          ],
        };
      }
      if (offset >= reference.size) fail('ARTIFACT_UNAVAILABLE');
      const expected = Math.min(length!, reference.size - offset);
      let ranged: R2ObjectBody | R2Object | null;
      try {
        ranged = await bucket!.get(loaded.key, { range: { offset, length: expected } });
      } catch {
        fail('ARTIFACT_UNAVAILABLE');
      }
      if (!ranged || !('body' in ranged)) fail('ARTIFACT_UNAVAILABLE');
      const bytes = await collect(ranged, expected);
      if (ranged.customMetadata?.artifact !== loaded.stored.customMetadata?.artifact)
        fail('ARTIFACT_INTEGRITY');
      const nextOffset = offset + bytes.length;
      return {
        contents: [
          {
            uri,
            mimeType: 'application/octet-stream',
            blob: encode(bytes),
            _meta: {
              offset,
              returnedBytes: bytes.length,
              totalSize: reference.size,
              wholeSha256: reference.sha256,
              chunkSha256: await digest(bytes),
              originalMimeType: reference.mimeType,
              nextUri:
                nextOffset < reference.size
                  ? `${reference.uri}/chunk/${nextOffset}/${Math.min(length!, reference.size - nextOffset)}`
                  : null,
              complete: offset === 0 && nextOffset === reference.size,
              eof: nextOffset === reference.size,
            },
          },
        ],
      };
    },

    createExecution(settings: {
      token: string;
      canWrite: () => boolean;
      waitUntil?: (promise: Promise<unknown>) => void;
    }) {
      const outcomes: ArtifactOutcome[] = [];
      const references: ArtifactReference[] = [];
      const active = new Map<ArtifactOutcome, { started: boolean; key?: string }>();
      let closed = false;
      let operations = 0;
      let putAttempts = 0;
      let putBytes = 0;
      let readBytes = 0;
      let sealed: ReturnType<typeof snapshot> | undefined;
      function snapshot() {
        return structuredClone({
          outcomes,
          references,
          hasUnknownOutcome: outcomes.some((record) => record.outcome === 'unknown'),
          outcomesComplete: operations <= limits.operations,
        });
      }
      function track(promise: Promise<unknown>) {
        const safe = promise.catch(() => undefined);
        try {
          settings.waitUntil?.(safe);
        } catch {
          /* Completion remains best effort. */
        }
      }
      function cleanup(key: string) {
        track(Promise.resolve().then(() => bucket!.delete(key)));
      }
      function gate() {
        if (closed) fail('ARTIFACT_CLOSED');
      }

      async function run(
        operation: string,
        input: unknown,
        record: ArtifactOutcome,
      ): Promise<ArtifactResult> {
        const state = active.get(record)!;
        try {
          if (!bucket) fail('ARTIFACTS_UNAVAILABLE');
          const writing = operation === 'putJson' || operation === 'putBytes';
          if (writing) {
            if (++putAttempts > limits.putAttempts) fail('ARTIFACT_LIMIT');
            if (!settings.canWrite()) fail('ARTIFACT_WRITE_DENIED');
            const args = inputObject(
              input,
              operation === 'putJson' ? ['json', 'name'] : ['body', 'name'],
            );
            const name = displayName(args.name);
            let bytes: Uint8Array;
            let mimeType: string;
            if (operation === 'putJson') {
              if (typeof args.json !== 'string') fail();
              bytes = encoder.encode(args.json);
              if (bytes.length > limits.jsonBytes) fail('ARTIFACT_LIMIT');
              try {
                if (JSON.stringify(JSON.parse(args.json)) !== args.json) fail();
              } catch {
                fail();
              }
              mimeType = 'application/json';
            } else {
              const body = inputObject(args.body, [
                'encoding',
                'data',
                'size',
                'sha256',
                'mimeType',
              ]);
              if (!validMimeType(body.mimeType)) fail();
              try {
                // Reuse byte validation without importing Drive conversion policy.
                const prepared = await prepareUpload({
                  requestBody: {},
                  media: {
                    mimeType: 'application/octet-stream',
                    body: { ...body, mimeType: 'application/octet-stream' },
                  },
                });
                bytes = prepared.bytes;
                mimeType = body.mimeType;
              } catch {
                fail();
              }
            }
            putBytes += bytes.length;
            if (putBytes > limits.putBytes) fail('ARTIFACT_LIMIT');
            for (const value of [bytes, encoder.encode(JSON.stringify({ name, mimeType }))]) {
              if (
                hasBytes(value, encoder.encode(settings.token)) ||
                hasBytes(value, encoder.encode(JSON.stringify(settings.token).slice(1, -1)))
              )
                fail('CREDENTIAL_ECHO');
            }
            const secret = encode(crypto.getRandomValues(new Uint8Array(32)))
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '');
            const key = 'artifacts/v1/' + (await digest(encoder.encode(secret)));
            const createdAt = now();
            const reference: ArtifactReference = {
              uri: prefix + secret,
              kind: operation === 'putJson' ? 'json' : 'bytes',
              mimeType,
              ...(name === undefined ? {} : { name }),
              size: bytes.length,
              sha256: await digest(bytes),
              createdAt,
              expiresAt: createdAt + 3_600_000,
              complete: true,
            };
            gate();
            record.reference = reference;
            state.key = key;
            state.started = true;
            try {
              const { uri: _uri, ...metadata } = reference;
              const stored = await bucket.put(key, bytes, {
                sha256: reference.sha256,
                onlyIf: { etagDoesNotMatch: '*' },
                httpMetadata: { contentType: mimeType },
                customMetadata: { artifact: JSON.stringify(metadata) },
              });
              if (!stored) {
                state.started = false;
                state.key = undefined;
                delete record.reference;
                fail('ARTIFACT_COLLISION');
              }
            } catch (error) {
              if (error instanceof ArtifactError && error.code === 'ARTIFACT_COLLISION')
                throw error;
              record.cleanup = 'scheduled';
              cleanup(key);
              fail('ARTIFACT_STORAGE');
            }
            if (closed) {
              cleanup(key);
              return {
                ok: false,
                error: { code: 'ARTIFACT_CLOSED', message: 'Artifact operation failed' },
              };
            }
            record.outcome = 'stored';
            references.push(reference);
            return { ok: true, value: reference };
          }
          if (!['readJson', 'readBytes', 'delete'].includes(operation)) fail();
          const args = inputObject(input, ['uri']);
          if (operation === 'delete') {
            const loaded = await load(args.uri);
            await loaded.stored.body.cancel().catch(() => undefined);
            gate();
            state.started = true;
            await bucket.delete(loaded.key);
            gate();
            record.outcome = 'deleted';
            record.reference = loaded.reference;
            const referenceIndex = references.findIndex(
              (reference) => reference.uri === loaded.reference.uri,
            );
            if (referenceIndex >= 0) references.splice(referenceIndex, 1);
            return { ok: true, value: { deleted: true } };
          }
          const loaded = await fullRead(args.uri, (size) => {
            gate();
            readBytes += size;
            if (readBytes > limits.readBytes) fail('ARTIFACT_LIMIT');
            state.started = true;
          });
          gate();
          record.reference = loaded.reference;
          if (loaded.reference.kind !== (operation === 'readJson' ? 'json' : 'bytes'))
            fail('ARTIFACT_TYPE');
          let value: unknown;
          if (operation === 'readJson') {
            try {
              value = JSON.parse(
                new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(loaded.bytes),
              );
            } catch {
              fail('ARTIFACT_INTEGRITY');
            }
          } else
            value = {
              encoding: 'base64',
              data: encode(loaded.bytes),
              size: loaded.bytes.length,
              mimeType: loaded.reference.mimeType,
              sha256: loaded.reference.sha256,
            };
          record.outcome = 'read';
          return { ok: true, value };
        } catch (error) {
          const code = error instanceof ArtifactError ? error.code : 'ARTIFACT_STORAGE';
          if (!closed) {
            record.outcome =
              state.started && ['putJson', 'putBytes', 'delete'].includes(operation)
                ? 'unknown'
                : 'rejected';
            record.error = code;
          }
          return {
            ok: false,
            error: {
              code,
              message:
                code === 'ARTIFACT_UNAVAILABLE'
                  ? 'Artifact unavailable'
                  : 'Artifact operation failed',
            },
          };
        } finally {
          active.delete(record);
        }
      }
      return {
        invoke(operation: string, input: unknown): Promise<ArtifactResult> {
          if (closed)
            return Promise.resolve({
              ok: false,
              error: { code: 'ARTIFACT_CLOSED', message: 'Artifact operation failed' },
            });
          if (++operations > limits.operations)
            return Promise.resolve({
              ok: false,
              error: { code: 'ARTIFACT_LIMIT', message: 'Artifact operation failed' },
            });
          const record: ArtifactOutcome = {
            operationId: `artifact:${operations}`,
            operation: ARTIFACTS_CAPABILITIES.operations.includes(operation as never)
              ? operation
              : '<invalid>',
            outcome: 'not_attempted',
          };
          outcomes.push(record);
          active.set(record, { started: false });
          const result = run(operation, input, record);
          track(result);
          return result;
        },
        close() {
          if (closed) return;
          closed = true;
          for (const [record, state] of active) {
            if (state.started) {
              record.outcome = 'unknown';
              if (state.key) record.cleanup = 'scheduled';
            }
          }
          sealed = snapshot();
        },
        snapshot: () => structuredClone(sealed ?? snapshot()),
      };
    },
  };
}
