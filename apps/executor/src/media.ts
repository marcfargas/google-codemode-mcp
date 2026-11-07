import type { DiscoverySchema } from './discovery.ts';

export const MAX_UPLOAD_BYTES = 128 * 1024;
export const MAX_EXECUTION_UPLOAD_BYTES = 1024 * 1024;
export const MAX_UPLOAD_METADATA_BYTES = 64 * 1024;
export const MAX_UPLOAD_PARAMS_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_WIRE_BYTES = 256 * 1024;
export const MEDIA_SKILL_URI =
  'skill://google-codemode-mcp/google-workspace/references/media-transfers.md';

export const UPLOAD_SCHEMA: DiscoverySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mimeType: { type: 'string', required: true },
    body: {
      type: 'object',
      required: true,
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            encoding: { type: 'string', enum: ['base64', 'base64url'], required: true },
            data: { type: 'string', required: true },
            size: { type: 'integer', minimum: 0, maximum: MAX_UPLOAD_BYTES },
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            mimeType: { type: 'string' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: { artifact: { type: 'string', required: true } },
        },
      ],
    },
  },
};

export function uploadSchema(artifacts: boolean, gmail = false): DiscoverySchema {
  const schema = artifacts
    ? UPLOAD_SCHEMA
    : {
        ...UPLOAD_SCHEMA,
        properties: {
          ...UPLOAD_SCHEMA.properties,
          body: {
            ...(UPLOAD_SCHEMA.properties!.body.anyOf as DiscoverySchema[])[0],
            required: true,
          },
        },
      };
  return gmail
    ? {
        ...schema,
        properties: {
          ...schema.properties,
          mimeType: { type: 'string', enum: ['message/rfc822'], required: true },
        },
      }
    : schema;
}

export const GMAIL_DRAFT_MEDIA_REQUEST: DiscoverySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'object',
      additionalProperties: false,
      properties: { threadId: { type: 'string' } },
    },
  },
};

export function maxArtifactUploadBytes(method: { path?: string; mediaUpload?: unknown }): number {
  return method.path === 'gmail/v1/users.drafts.create'
    ? Number((method.mediaUpload as { maxSize: string }).maxSize)
    : 64 * 1024 * 1024;
}

export function validateMethodUpload(method: { path?: string }, params: Record<string, unknown>) {
  if (method.path !== 'gmail/v1/users.drafts.create') return;
  if ((params.media as { mimeType?: unknown })?.mimeType !== 'message/rfc822') invalid();
  const body = object(params.requestBody);
  exactKeys(body, ['message']);
  if (body.message !== undefined) {
    const message = object(body.message);
    exactKeys(message, ['threadId']);
    if (
      message.threadId !== undefined &&
      (typeof message.threadId !== 'string' ||
        !message.threadId ||
        message.threadId.length > 256 ||
        /[\x00-\x1f\x7f]/.test(message.threadId))
    )
      invalid();
  }
}

export function supportsUpload(method: {
  path?: string;
  httpMethod?: string;
  supportsMediaUpload?: boolean;
  mediaUpload?: unknown;
}): boolean {
  const native = method.mediaUpload as
    | { maxSize?: string; protocols?: { simple?: { path?: string; multipart?: boolean } } }
    | undefined;
  return (
    method.httpMethod?.toUpperCase() === 'POST' &&
    method.supportsMediaUpload === true &&
    native?.protocols?.simple?.multipart === true &&
    ((method.path === 'drive/v3/files.create' &&
      native.protocols.simple.path === '/upload/drive/v3/files') ||
      (method.path === 'gmail/v1/users.drafts.create' &&
        native.protocols.simple.path === '/upload/gmail/v1/users/{userId}/drafts' &&
        typeof native.maxSize === 'string' &&
        /^[1-9][0-9]*$/.test(native.maxSize) &&
        Number.isSafeInteger(Number(native.maxSize))))
  );
}

function invalid(): never {
  throw new Error('Invalid or oversized media upload');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const mimeToken = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const mimePattern = new RegExp(
  `^${mimeToken}/${mimeToken}(?: *; *${mimeToken}=(?:${mimeToken}|"(?:[ !#-\\[\\]-~]|\\\\[ -~])*"))*$`,
);

export function validMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    !/[^\x20-\x7e]/.test(value) &&
    mimePattern.test(value)
  );
}

/** References are resolved only by the trusted storage session, never as URLs. */
export function artifactUpload(params: Record<string, unknown>) {
  if (jsonBytes(params) > MAX_UPLOAD_PARAMS_BYTES) invalid();
  const metadata = object(params.requestBody);
  if (jsonBytes(metadata) > MAX_UPLOAD_METADATA_BYTES) invalid();
  const media = object(params.media);
  exactKeys(media, ['mimeType', 'body']);
  if (
    !validMimeType(media.mimeType) ||
    media.mimeType.toLowerCase().startsWith('application/vnd.google-apps.') ||
    (metadata.mimeType !== undefined && metadata.mimeType !== media.mimeType)
  )
    invalid();
  const body = object(media.body);
  exactKeys(body, ['artifact']);
  if (typeof body.artifact !== 'string') invalid();
  return { uri: body.artifact, mimeType: media.mimeType, metadataJson: JSON.stringify(metadata) };
}

/** Build Web multipart from trusted metadata and storage; no SDK buffering. */
export function streamUploadWire(
  contentType: string | null,
  upload: {
    metadataJson: string;
    mimeType: string;
    body: ReadableStream<Uint8Array>;
    size: number;
    signal?: AbortSignal;
  },
) {
  const boundary = /^multipart\/related; boundary=([A-Za-z0-9-]{1,70})$/.exec(
    contentType ?? '',
  )?.[1];
  if (!boundary) invalid();
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n${upload.metadataJson}\r\n` +
      `--${boundary}\r\ncontent-type: ${upload.mimeType}\r\n\r\n`,
  );
  const footer = encoder.encode(`\r\n--${boundary}--`);
  const reader = upload.body.getReader();
  let first = true;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (first) {
          first = false;
          controller.enqueue(prefix);
          return;
        }
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        controller.enqueue(footer);
        controller.close();
        reader.releaseLock();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const size = prefix.length + upload.size + footer.length;
  const fixed = new FixedLengthStream(size);
  const completion = source.pipeTo(fixed.writable, { signal: upload.signal });
  // Fetch can reject before it consumes the body; observe rejection immediately.
  void completion.catch(() => undefined);
  return { size, body: fixed.readable, completion };
}

/** Validate JSON input completely before constructing trusted SDK streams. */
export async function prepareUpload(params: Record<string, unknown>): Promise<{
  bytes: Uint8Array;
  mimeType: string;
}> {
  if (jsonBytes(params) > MAX_UPLOAD_PARAMS_BYTES) invalid();
  const metadata = object(params.requestBody);
  if (jsonBytes(metadata) > MAX_UPLOAD_METADATA_BYTES) invalid();
  const media = object(params.media);
  exactKeys(media, ['mimeType', 'body']);
  if (!validMimeType(media.mimeType)) invalid();
  const mimeType = media.mimeType;
  if (
    mimeType.toLowerCase().startsWith('application/vnd.google-apps.') ||
    (metadata.mimeType !== undefined && metadata.mimeType !== mimeType)
  )
    invalid();
  const body = object(media.body);
  exactKeys(body, ['encoding', 'data', 'size', 'sha256', 'mimeType']);
  if (body.mimeType !== undefined && body.mimeType !== mimeType) invalid();
  if (body.encoding !== 'base64' && body.encoding !== 'base64url') invalid();
  if (typeof body.data !== 'string' || body.data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4)
    invalid();
  const pattern = body.encoding === 'base64' ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]*={0,2}$/;
  if (!pattern.test(body.data)) invalid();
  const unpadded = body.data.replace(/=+$/, '');
  const padding = body.data.length - unpadded.length;
  if (
    unpadded.length % 4 === 1 ||
    (padding > 0 && (body.data.length % 4 !== 0 || padding !== (4 - (unpadded.length % 4)) % 4))
  )
    invalid();
  const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  if (binary.length > MAX_UPLOAD_BYTES || btoa(binary).replace(/=+$/, '') !== normalized) invalid();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (body.size !== undefined && (!Number.isInteger(body.size) || body.size !== bytes.length))
    invalid();
  if (body.sha256 !== undefined) {
    if (typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256)) invalid();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('') !== body.sha256)
      invalid();
  }
  return { bytes, mimeType };
}

/** Collect SDK multipart bytes under a hard cap before the real fetch. */
export async function uploadWireBody(body: unknown): Promise<Uint8Array> {
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function')
    invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of body as AsyncIterable<unknown>) {
      const bytes =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : invalid();
      length += bytes.byteLength;
      if (length > MAX_UPLOAD_WIRE_BYTES) invalid();
      chunks.push(bytes);
    }
  } catch {
    (body as { destroy?: () => void }).destroy?.();
    invalid();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Workerd omits PassThrough's custom flush; accept only that exact SDK defect. */
export function normalizeUploadWire(
  wire: Uint8Array,
  contentType: string | null,
  upload: { metadataJson: string; mimeType: string; bytes: Uint8Array },
): Uint8Array {
  const boundary = /^multipart\/related; boundary=([A-Za-z0-9-]{1,70})$/.exec(
    contentType ?? '',
  )?.[1];
  if (!boundary) invalid();
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n${upload.metadataJson}\r\n` +
      `--${boundary}\r\ncontent-type: ${upload.mimeType}\r\n\r\n`,
  );
  const footer = encoder.encode(`\r\n--${boundary}--`);
  const length = prefix.length + upload.bytes.length + footer.length;
  if (length > MAX_UPLOAD_WIRE_BYTES) invalid();
  if (wire.length !== length && wire.length !== length - footer.length) invalid();
  const expected = new Uint8Array(length);
  expected.set(prefix);
  expected.set(upload.bytes, prefix.length);
  expected.set(footer, prefix.length + upload.bytes.length);
  for (let index = 0; index < wire.length; index++) if (wire[index] !== expected[index]) invalid();
  return wire.length === length ? wire : expected;
}
