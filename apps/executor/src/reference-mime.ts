import type { StreamArtifactExecution } from './stream-artifacts.ts';
import { validMimeType } from './media.ts';

export const REFERENCE_MEDIA_CAPABILITIES = {
  operations: ['composeMime', 'fromGmailAttachment'],
  maxAttachmentBytes: 1024 * 1024,
  maxMimeBytes: 2 * 1024 * 1024,
  maxAttachments: 8,
  maxTextBytes: 65536,
  timeoutMs: 15000,
  maxConcurrentHelpers: 1,
  maxConcurrentHelpersPerWorker: 2,
  maxInputBytes: 512 * 1024,
  scope: 'top-level-execute',
} as const;
export const MAX_ATTACHMENT_JSON_BYTES =
  Math.ceil(REFERENCE_MEDIA_CAPABILITIES.maxAttachmentBytes / 3) * 4 + 4096;

function invalid(): never {
  throw new Error('ARTIFACT_MEDIA_INVALID');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid();
  return result;
}
function header(value: unknown, max: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value))
    invalid();
  return value;
}
export function attachmentMetadata(value: unknown): { name: string; mimeType: string } {
  const metadata = object(value, ['name', 'mimeType']);
  const name = header(metadata.name, 240);
  if (!name || !validMimeType(metadata.mimeType)) invalid();
  return { name, mimeType: metadata.mimeType };
}

/** Gmail attachments.get is JSON/base64url; decode only inside the trusted executor. */
export function decodeGmailAttachment(value: unknown): Uint8Array {
  const body = object(value, ['data', 'size', 'attachmentId']);
  if (
    !Number.isSafeInteger(body.size) ||
    (body.size as number) < 0 ||
    (body.size as number) > REFERENCE_MEDIA_CAPABILITIES.maxAttachmentBytes ||
    typeof body.data !== 'string' ||
    body.data.length > Math.ceil(REFERENCE_MEDIA_CAPABILITIES.maxAttachmentBytes / 3) * 4 ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)
  )
    invalid();
  const unpadded = body.data.replace(/=+$/, '');
  const padding = body.data.length - unpadded.length;
  if (
    unpadded.length % 4 === 1 ||
    (padding && (body.data.length % 4 !== 0 || padding !== (4 - (unpadded.length % 4)) % 4))
  )
    invalid();
  const bytes = Buffer.from(unpadded, 'base64url');
  if (bytes.length !== body.size || bytes.toString('base64url') !== unpadded) invalid();
  return bytes;
}

/** Bounded trusted composition: sequential reads verify source integrity before storage/Google writes. */
export async function composeReferenceMime(
  value: unknown,
  store: StreamArtifactExecution,
  signal: AbortSignal,
) {
  const input = object(value, ['to', 'from', 'subject', 'text', 'attachments']);
  const address = (value: unknown) => {
    const result = header(value, 254);
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(result))
      invalid();
    return result;
  };
  const to = address(input.to);
  const from = input.from === undefined ? undefined : address(input.from);
  const subject = header(input.subject, 2048);
  if (
    subject.length > 512 ||
    typeof input.text !== 'string' ||
    Buffer.byteLength(input.text) > REFERENCE_MEDIA_CAPABILITIES.maxTextBytes ||
    !Array.isArray(input.attachments) ||
    !input.attachments.length ||
    input.attachments.length > REFERENCE_MEDIA_CAPABILITIES.maxAttachments
  )
    invalid();
  const parts = input.attachments.map((value) => {
    const part = object(value, ['artifact', 'name', 'mimeType']);
    if (typeof part.artifact !== 'string') invalid();
    return {
      artifact: part.artifact,
      ...attachmentMetadata({ name: part.name, mimeType: part.mimeType }),
    };
  });
  const encodedWords: string[] = [];
  let word = '';
  for (const char of subject) {
    if (Buffer.byteLength(word + char) > 42) {
      encodedWords.push('=?UTF-8?B?' + Buffer.from(word).toString('base64') + '?=');
      word = '';
    }
    word += char;
  }
  if (word) encodedWords.push('=?UTF-8?B?' + Buffer.from(word).toString('base64') + '?=');
  const folded = (bytes: Uint8Array) =>
    Buffer.from(bytes)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const boundary = 'codemode_' + crypto.randomUUID();
  const lines = [
    ...(from === undefined ? [] : ['From: ' + from]),
    'To: ' + to,
    'Subject: ' + encodedWords.join('\r\n '),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    folded(Buffer.from(input.text)),
  ];
  let total = 0;
  for (const part of parts) {
    signal.throwIfAborted();
    const source = await store.open(part.artifact, { signal });
    total += source.reference.size;
    if (
      total > REFERENCE_MEDIA_CAPABILITIES.maxAttachmentBytes ||
      source.reference.mimeType !== part.mimeType
    ) {
      await source.body.cancel();
      invalid();
    }
    const bytes = new Uint8Array(await new Response(source.body).arrayBuffer());
    signal.throwIfAborted();
    const name = encodeURIComponent(part.name).replace(
      /[!'()*]/g,
      (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
    );
    lines.push(
      '--' + boundary,
      'Content-Type: ' + part.mimeType,
      "Content-Disposition: attachment; filename*=UTF-8''" + name,
      'Content-Transfer-Encoding: base64',
      '',
      folded(bytes),
    );
  }
  lines.push('--' + boundary + '--', '');
  const mime = Buffer.from(lines.join('\r\n'));
  if (mime.length > REFERENCE_MEDIA_CAPABILITIES.maxMimeBytes) invalid();
  signal.throwIfAborted();
  return store.put(new Response(mime).body!, {
    mimeType: 'message/rfc822',
    name: 'message.eml',
    size: mime.length,
    signal,
  });
}
