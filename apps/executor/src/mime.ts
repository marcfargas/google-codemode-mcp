import type { SnippetDefinition } from './snippets.ts';

/** Pure deployment snippet: no Google dispatch or extra tool exposure. */
export const composeMimeSnippet: SnippetDefinition = {
  name: 'composeMime',
  description:
    'Build a bounded base64url MIME message from text and byte envelopes; does not send it. Read the media-transfers skill reference for encoding and limits.',
  services: [],
  scopes: [],
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', minLength: 3, maxLength: 254 },
      from: { type: 'string', minLength: 3, maxLength: 254 },
      subject: { type: 'string', maxLength: 512 },
      text: { type: 'string', maxLength: 65536 },
      attachments: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 240 },
            mimeType: { type: 'string', minLength: 3, maxLength: 256 },
            encoding: { enum: ['base64', 'base64url'] },
            data: { type: 'string', maxLength: 174764 },
            size: { type: 'integer', minimum: 0, maximum: 131072 },
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          },
          required: ['name', 'mimeType', 'encoding', 'data'],
          additionalProperties: false,
        },
      },
    },
    required: ['to', 'subject', 'text', 'attachments'],
    additionalProperties: false,
  },
  code: String.raw`
const utf8 = new TextEncoder();
function fail() { throw new Error('Invalid or oversized MIME input'); }
function header(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function address(value) {
  header(value);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) fail();
  return value;
}
function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function folded(value) { return value.match(/.{1,76}/g)?.join('\r\n') ?? ''; }
function encodedWords(value) {
  header(value);
  const chunks = []; let chunk = '', size = 0;
  for (const char of value) {
    const count = utf8.encode(char).length;
    if (size + count > 42) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += char; size += count;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(part => '=?UTF-8?B?' + base64(utf8.encode(part)) + '?=').join('\r\n ');
}
function bytes(part) {
  const encoded = part.data;
  const pattern = part.encoding === 'base64url' ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!pattern.test(encoded) || encoded.length > 174764) fail();
  const unpadded = encoded.replace(/=+$/, '');
  if (unpadded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) fail();
  const standard = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  let binary;
  try { binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4)); } catch { fail(); }
  if (binary.length > 131072 || btoa(binary).replace(/=+$/, '') !== standard) fail();
  if (part.size !== undefined && part.size !== binary.length) fail();
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
address(inputs.to);
if (inputs.from !== undefined) address(inputs.from);
header(inputs.subject);
const text = utf8.encode(inputs.text);
if (text.length > 65536) fail();
const boundary = 'codemode_' + crypto.randomUUID();
const lines = [
  ...(inputs.from === undefined ? [] : ['From: ' + inputs.from]),
  'To: ' + inputs.to,
  'Subject: ' + encodedWords(inputs.subject),
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="' + boundary + '"',
  '', '--' + boundary,
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64', '', folded(base64(text))
];
let total = 0;
for (const part of inputs.attachments) {
  header(part.name); header(part.mimeType);
  if (utf8.encode(part.name).length > 240 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; *[A-Za-z0-9_-]+=(?:[A-Za-z0-9_.+-]+|"[\x20-\x21\x23-\x5b\x5d-\x7e]*"))*$/.test(part.mimeType)) fail();
  const content = bytes(part);
  total += content.length;
  if (total > 131072) fail();
  if (part.sha256 !== undefined) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
    if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== part.sha256) fail();
  }
  const name = encodeURIComponent(part.name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  lines.push('--' + boundary, 'Content-Type: ' + part.mimeType,
    "Content-Disposition: attachment; filename*=UTF-8''" + name,
    'Content-Transfer-Encoding: base64', '', folded(base64(content)));
}
lines.push('--' + boundary + '--', '');
return btoa(lines.join('\r\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
`,
};
