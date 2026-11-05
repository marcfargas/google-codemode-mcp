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
      additionalProperties: false,
      properties: {
        encoding: { type: 'string', enum: ['base64', 'base64url'], required: true },
        data: { type: 'string', required: true },
        size: { type: 'integer', minimum: 0, maximum: MAX_UPLOAD_BYTES },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        mimeType: { type: 'string' },
      },
    },
  },
};

export function supportsUpload(method: {
  path?: string;
  httpMethod?: string;
  supportsMediaUpload?: boolean;
  mediaUpload?: unknown;
}): boolean {
  const native = method.mediaUpload as
    { protocols?: { simple?: { path?: string; multipart?: boolean } } } | undefined;
  return (
    method.path === 'drive/v3/files.create' &&
    method.httpMethod?.toUpperCase() === 'POST' &&
    method.supportsMediaUpload === true &&
    native?.protocols?.simple?.multipart === true &&
    native.protocols.simple.path === '/upload/drive/v3/files'
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
