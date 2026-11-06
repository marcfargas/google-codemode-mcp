import { createHash, randomBytes } from 'node:crypto';
import type { ReadResourceResult } from '@modelcontextprotocol/server';
import type { ArtifactOutcome, ArtifactReference } from './artifacts.ts';
import { validMimeType } from './media.ts';
import { MAX_STREAM_BYTES } from './storage.ts';
import type { Storage } from './storage.ts';
export { MAX_STREAM_BYTES } from './storage.ts';

export const STREAM_ARTIFACT_CAPABILITIES = {
  maxBytes: MAX_STREAM_BYTES,
  maxExecutionBytes: 128 * 1024 * 1024,
  maxReadBytes: 128 * 1024,
  maxConcurrentTransfers: 1,
  ttlSeconds: 3600,
} as const;
const encoder = new TextEncoder();
const prefix = 'artifact://google-codemode-mcp/v2/';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code = 'ARTIFACT_UNAVAILABLE'): never {
  throw Object.assign(new Error(code), { code });
}
function keyFor(uri: unknown) {
  if (
    typeof uri !== 'string' ||
    !/^artifact:\/\/google-codemode-mcp\/v2\/[A-Za-z0-9_-]{43}$/.test(uri)
  )
    fail();
  const secret = uri.slice(prefix.length);
  if (Buffer.from(secret, 'base64url').toString('base64url') !== secret) fail();
  return 'artifacts/v2/' + hash(secret);
}
function nameFor(value: unknown): string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    encoder.encode(value).length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail('ARTIFACT_INVALID');
  return value;
}

/** Native byte search plus a bounded suffix catches echoes split between chunks. */
function credentialGuard(token: string) {
  const needles = [token, JSON.stringify(token).slice(1, -1)]
    .filter(Boolean)
    .map((value) => Buffer.from(value));
  const keep = Math.max(0, ...needles.map((value) => value.length - 1));
  let tail = Buffer.alloc(0);
  return (chunk: Uint8Array) => {
    const scanned = Buffer.concat([tail, chunk]);
    if (needles.some((needle) => scanned.includes(needle))) fail('ARTIFACT_CREDENTIAL_ECHO');
    tail = Buffer.from(scanned.subarray(Math.max(0, scanned.length - keep)));
  };
}

/** The owner is verified wrapper context, never an MCP argument or Google token. */
export function createStreamArtifactStore(
  storage?: Storage,
  options: { owner?: string; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  if (options.owner !== undefined && (!options.owner || options.owner.length > 512))
    fail('ARTIFACT_INVALID');

  async function load(uri: unknown) {
    const key = keyFor(uri);
    if (!storage) fail();
    const manifest = await storage.read(key + '/manifest');
    if (!manifest) fail();
    if (manifest.size > 4096) {
      await manifest.body.cancel();
      fail();
    }
    const raw = await new Response(manifest.body).text();
    let metadata: ArtifactReference & { owner?: string; v: number };
    try {
      metadata = JSON.parse(raw);
      if (
        !metadata ||
        metadata.v !== 2 ||
        metadata.kind !== 'bytes' ||
        metadata.complete !== true ||
        metadata.owner !== options.owner ||
        !validMimeType(metadata.mimeType) ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        metadata.size > MAX_STREAM_BYTES ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        !Number.isSafeInteger(metadata.createdAt) ||
        !Number.isSafeInteger(metadata.expiresAt) ||
        metadata.expiresAt - metadata.createdAt !== 3_600_000 ||
        metadata.expiresAt <= now()
      )
        fail();
      nameFor(metadata.name);
    } catch {
      fail();
    }
    const reference: ArtifactReference = {
      uri: uri as string,
      kind: 'bytes',
      mimeType: metadata.mimeType,
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      size: metadata.size,
      sha256: metadata.sha256,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      complete: true,
    };
    return { key, reference };
  }

  return {
    enabled: !!storage,
    async readResource(uri: string): Promise<ReadResourceResult> {
      const { key, reference } = await load(uri);
      const data = await storage!.read(key + '/data');
      if (!data) fail();
      await data.body.cancel();
      if (data.size !== reference.size) fail('ARTIFACT_INTEGRITY');
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(reference) }] };
    },
    createExecution(settings: { token: string; waitUntil?: (promise: Promise<unknown>) => void }) {
      const outcomes: ArtifactOutcome[] = [];
      const references: ArtifactReference[] = [];
      const active = new Map<ArtifactOutcome, AbortController>();
      let operations = 0;
      let putAttempts = 0;
      let transferred = 0;
      let closed = false;
      let sealed: ReturnType<typeof snapshot> | undefined;
      const snapshot = () =>
        structuredClone({
          outcomes,
          references,
          hasUnknownOutcome: outcomes.some((record) => record.outcome === 'unknown'),
          outcomesComplete: operations <= 32,
        });
      const gate = () => {
        if (closed) fail('ARTIFACT_CLOSED');
      };
      function begin(operation: string, signal?: AbortSignal) {
        gate();
        if (++operations > 32) fail('ARTIFACT_LIMIT');
        const record: ArtifactOutcome = {
          operationId: `stream-artifact:${operations}`,
          operation,
          outcome: 'not_attempted',
        };
        outcomes.push(record);
        if (active.size) {
          record.outcome = 'rejected';
          record.error = 'ARTIFACT_LIMIT';
          fail('ARTIFACT_LIMIT');
        }
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        active.set(record, controller);
        return {
          record,
          signal: controller.signal,
          end: () => {
            active.delete(record);
            signal?.removeEventListener('abort', abort);
          },
        };
      }
      function reserve(size: number) {
        transferred += size;
        if (transferred > STREAM_ARTIFACT_CAPABILITIES.maxExecutionBytes) fail('ARTIFACT_LIMIT');
      }
      function rejected(record: ArtifactOutcome, error: unknown, started = false) {
        if (!closed) {
          record.outcome = started ? 'unknown' : 'rejected';
          record.error =
            error instanceof Error && /^ARTIFACT_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'ARTIFACT_STORAGE';
        }
      }
      async function remove(key: string) {
        const removed = await Promise.allSettled([
          storage!.delete(key + '/manifest'),
          storage!.delete(key + '/data'),
        ]);
        if (removed.some((result) => result.status === 'rejected')) fail('ARTIFACT_STORAGE');
      }
      return {
        async put(
          body: ReadableStream<Uint8Array>,
          metadata: {
            mimeType: string;
            size?: number;
            name?: string;
            signal?: AbortSignal;
          },
        ): Promise<ArtifactReference> {
          const state = begin('putStream', metadata.signal);
          let key: string | undefined;
          let started = false;
          try {
            if (!storage) fail();
            if (++putAttempts > 4 || !validMimeType(metadata.mimeType)) fail('ARTIFACT_INVALID');
            const name = nameFor(metadata.name);
            if (
              metadata.size !== undefined &&
              (!Number.isSafeInteger(metadata.size) ||
                metadata.size < 0 ||
                metadata.size > MAX_STREAM_BYTES)
            )
              fail('ARTIFACT_LIMIT');
            const secret = randomBytes(32).toString('base64url');
            key = 'artifacts/v2/' + hash(secret);
            credentialGuard(settings.token)(
              encoder.encode(JSON.stringify({ name, mimeType: metadata.mimeType })),
            );
            const checkCredential = credentialGuard(settings.token);
            const checked = body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  state.signal.throwIfAborted();
                  reserve(chunk.length);
                  checkCredential(chunk);
                  controller.enqueue(chunk);
                },
              }),
            );
            started = true;
            const stored = await storage.write(key + '/data', checked, {
              size: metadata.size,
              signal: state.signal,
            });
            gate();
            state.signal.throwIfAborted();
            const createdAt = now();
            const reference: ArtifactReference = {
              uri: prefix + secret,
              kind: 'bytes',
              mimeType: metadata.mimeType,
              ...(name === undefined ? {} : { name }),
              size: stored.size,
              sha256: stored.sha256,
              createdAt,
              expiresAt: createdAt + 3_600_000,
              complete: true,
            };
            const { uri: _uri, ...manifest } = reference;
            const bytes = encoder.encode(
              JSON.stringify({
                ...manifest,
                v: 2,
                ...(options.owner === undefined ? {} : { owner: options.owner }),
              }),
            );
            await storage.write(key + '/manifest', new Response(bytes).body!, {
              size: bytes.length,
              signal: state.signal,
            });
            gate();
            state.signal.throwIfAborted();
            state.record.outcome = 'stored';
            state.record.reference = reference;
            references.push(reference);
            return reference;
          } catch (error) {
            rejected(state.record, error, started);
            await body.cancel().catch(() => undefined);
            if (
              key &&
              started &&
              !(error instanceof Error && error.message === 'ARTIFACT_COLLISION')
            ) {
              state.record.cleanup = 'scheduled';
              const cleanup = remove(key).catch(() => undefined);
              try {
                settings.waitUntil?.(cleanup);
              } catch {
                /* Best effort after request end. */
              }
              await cleanup;
            }
            throw error;
          } finally {
            state.end();
          }
        },
        async open(uri: unknown, readOptions: { signal?: AbortSignal } = {}) {
          const state = begin('readStream', readOptions.signal);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            const { key, reference } = await load(uri);
            gate();
            state.signal.throwIfAborted();
            const data = await storage!.read(key + '/data');
            if (!data) fail();
            if (data.size !== reference.size) {
              await data.body.cancel();
              fail('ARTIFACT_INTEGRITY');
            }
            reader = data.body.getReader();
            gate();
            state.signal.throwIfAborted();
            reserve(reference.size);
            credentialGuard(settings.token)(encoder.encode(JSON.stringify(reference)));
            const hash = createHash('sha256');
            const checkCredential = credentialGuard(settings.token);
            let size = 0;
            state.record.reference = reference;
            const cancel = async (reason?: unknown) => {
              await reader!.cancel(reason).catch(() => undefined);
              state.end();
            };
            const abort = () => {
              rejected(state.record, new Error('ARTIFACT_CANCELLED'));
              void cancel(state.signal.reason).finally(finish);
            };
            state.signal.addEventListener('abort', abort, { once: true });
            const finish = () => {
              state.signal.removeEventListener('abort', abort);
              state.end();
            };
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  gate();
                  state.signal.throwIfAborted();
                  const next = await reader!.read();
                  gate();
                  state.signal.throwIfAborted();
                  if (next.done) {
                    if (size !== reference.size || hash.digest('hex') !== reference.sha256)
                      fail('ARTIFACT_INTEGRITY');
                    state.record.outcome = 'read';
                    controller.close();
                    finish();
                    return;
                  }
                  size += next.value.length;
                  if (size > reference.size) fail('ARTIFACT_INTEGRITY');
                  checkCredential(next.value);
                  hash.update(next.value);
                  controller.enqueue(next.value);
                } catch (error) {
                  rejected(state.record, error);
                  controller.error(error);
                  await cancel(error);
                  finish();
                }
              },
              async cancel(reason) {
                rejected(state.record, new Error('ARTIFACT_CANCELLED'));
                await cancel(reason);
                finish();
              },
            });
            return { reference, body };
          } catch (error) {
            rejected(state.record, error);
            await reader?.cancel().catch(() => undefined);
            state.end();
            throw error;
          }
        },
        async readBytes(uri: unknown) {
          const { reference, body } = await this.open(uri);
          if (reference.size > STREAM_ARTIFACT_CAPABILITIES.maxReadBytes) {
            await body.cancel();
            fail('ARTIFACT_LIMIT');
          }
          const bytes = Buffer.from(await new Response(body).arrayBuffer());
          return {
            encoding: 'base64',
            data: bytes.toString('base64'),
            size: bytes.length,
            mimeType: reference.mimeType,
            sha256: reference.sha256,
          };
        },
        async delete(uri: unknown) {
          const state = begin('delete');
          let started = false;
          try {
            const { key, reference } = await load(uri);
            gate();
            started = true;
            await remove(key);
            gate();
            state.record.outcome = 'deleted';
            state.record.reference = reference;
            const index = references.findIndex((ref) => ref.uri === uri);
            if (index >= 0) references.splice(index, 1);
            return { deleted: true };
          } catch (error) {
            rejected(state.record, error, started);
            throw error;
          } finally {
            state.end();
          }
        },
        close() {
          if (closed) return;
          closed = true;
          for (const [record, controller] of active) {
            record.outcome = 'unknown';
            if (record.operation === 'putStream') record.cleanup = 'scheduled';
            controller.abort(new Error('ARTIFACT_CLOSED'));
          }
          sealed = snapshot();
        },
        snapshot: () => structuredClone(sealed ?? snapshot()),
      };
    },
  };
}

export type StreamArtifactStore = ReturnType<typeof createStreamArtifactStore>;
export type StreamArtifactExecution = ReturnType<StreamArtifactStore['createExecution']>;
