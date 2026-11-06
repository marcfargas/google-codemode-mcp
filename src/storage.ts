import { createHash } from 'node:crypto';

export const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const PART_BYTES = 5 * 1024 * 1024;
let activeWriters = 0;

/** Bytes stay in the trusted process; adapters expose no provider-specific objects. */
export interface Storage {
  read(
    key: string,
    range?: { offset: number; length: number },
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
  } | null>;
  write(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: { size?: number; signal?: AbortSignal },
  ): Promise<{ size: number; sha256: string }>;
  delete(key: string): Promise<void>;
}

export function createR2Storage(
  bucket: Pick<R2Bucket, 'get' | 'put' | 'delete' | 'createMultipartUpload'>,
): Storage {
  return {
    async read(key, range) {
      const object = await bucket.get(key, range ? { range } : undefined);
      return object ? { body: object.body, size: object.size } : null;
    },
    async write(key, body, options = {}) {
      const { size, signal } = options;
      if (
        size !== undefined &&
        (!Number.isSafeInteger(size) || size < 0 || size > MAX_STREAM_BYTES)
      )
        throw new Error('ARTIFACT_LIMIT');
      if (activeWriters >= 2) {
        await body.cancel().catch(() => undefined);
        throw new Error('ARTIFACT_LIMIT');
      }
      const reader = body.getReader();
      activeWriters++;
      const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
      signal?.addEventListener('abort', abort, { once: true });
      let upload: R2MultipartUpload | undefined;
      let received = 0;
      let used = 0;
      const part = new Uint8Array(
        size === undefined ? PART_BYTES : Math.max(1, Math.min(size, PART_BYTES)),
      );
      const parts: R2UploadedPart[] = [];
      const hash = createHash('sha256');
      const check = () => signal?.throwIfAborted();
      const flush = async () => {
        check();
        upload ??= await bucket.createMultipartUpload(key);
        check();
        parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, used)));
        check();
        used = 0;
      };
      try {
        check();
        while (true) {
          const { done, value } = await reader.read();
          check();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_STREAM_BYTES || (size !== undefined && received > size))
            throw new Error('ARTIFACT_LIMIT');
          hash.update(value);
          for (let offset = 0; offset < value.length;) {
            // Keep one bounded part for both known- and unknown-length bodies.
            // Deferring the flush also permits a single conditional put for small objects.
            if (used === part.length) await flush();
            const count = Math.min(part.length - used, value.length - offset);
            part.set(value.subarray(offset, offset + count), used);
            offset += count;
            used += count;
          }
        }
        if (size !== undefined && received !== size) throw new Error('ARTIFACT_INTEGRITY');
        let written: R2Object | null;
        if (upload) {
          if (used) await flush();
          check();
          written = await upload.complete(parts);
        } else {
          check();
          written = await bucket.put(key, part.subarray(0, used), {
            onlyIf: { etagDoesNotMatch: '*' },
          });
          if (!written) throw new Error('ARTIFACT_COLLISION');
        }
        check();
        if (written.size !== received) throw new Error('ARTIFACT_INTEGRITY');
        return { size: received, sha256: hash.digest('hex') };
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        await upload?.abort().catch(() => undefined);
        // Completion may have succeeded before cancellation or a lost response.
        // Collision is the sole case where the key belongs to an existing object.
        if (!(error instanceof Error && error.message === 'ARTIFACT_COLLISION'))
          await bucket.delete(key).catch(() => undefined);
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
        activeWriters--;
      }
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
