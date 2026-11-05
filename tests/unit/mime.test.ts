import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { composeMimeSnippet } from '../../src/mime.ts';
import { validateSnippetInput, validateSnippets } from '../../src/snippets.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function input(bytes: Uint8Array, encoding = 'base64url') {
  return {
    from: 'sender@example.test',
    to: 'recipient@example.test',
    subject: 'Résumé 🌍 '.repeat(20),
    text: 'A text body with Unicode: café 🌍\nSecond line.',
    attachments: [
      {
        name: 'résumé 🌍.bin',
        mimeType: 'application/octet-stream',
        encoding,
        data: Buffer.from(bytes).toString(encoding as BufferEncoding),
        size: bytes.length,
        sha256: sha256(bytes),
      },
    ],
  };
}
async function compose(value: ReturnType<typeof input>) {
  validateSnippetInput(composeMimeSnippet, value);
  return new AsyncFunction('inputs', composeMimeSnippet.code)(value) as Promise<string>;
}
// Receiver-side parsing uses Node byte decoders, independent of the sandbox encoder.
function parse(raw: string) {
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const message: string = Buffer.from(raw, 'base64url').toString('ascii');
  assert.ok(!/(^|[^\r])\n/.test(message));
  assert.ok(message.split('\r\n').every((line) => line.length <= 998));
  const [headers] = message.split('\r\n\r\n');
  const boundary = headers.match(/boundary="([^"]+)"/)![1];
  const parts = message
    .split('--' + boundary)
    .slice(1, -1)
    .map((part) => {
      const start = part.indexOf('\r\n\r\n');
      const header = part.slice(2, start);
      const encoded = part.slice(start + 4).trim();
      assert.ok(encoded.split('\r\n').every((line) => line.length <= 76));
      assert.match(encoded, /^[A-Za-z0-9+/=\r\n]*$/);
      return { header, bytes: Buffer.from(encoded, 'base64') };
    });
  return { headers, parts };
}

test('pure MIME snippet preserves all byte values, Unicode metadata and MIME parameters', async () => {
  validateSnippets([composeMimeSnippet]);
  assert.deepEqual(composeMimeSnippet.services, []);
  assert.deepEqual(composeMimeSnippet.scopes, []);
  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
  for (const encoding of ['base64', 'base64url']) {
    const value = input(bytes, encoding);
    value.attachments[0].mimeType = 'application/octet-stream; charset="binary"';
    const parsed = parse(await compose(value));
    assert.deepEqual(parsed.parts[1].bytes, Buffer.from(bytes));
    assert.equal(parsed.parts[0].bytes.toString('utf8'), value.text);
    assert.match(
      parsed.parts[1].header,
      /Content-Type: application\/octet-stream; charset="binary"/,
    );
    const name = parsed.parts[1].header.match(/filename\*=UTF-8''([^\r\n]+)/)![1];
    assert.equal(decodeURIComponent(name), value.attachments[0].name);
    const words = [...parsed.headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    assert.ok(words.every((word) => word[0].length <= 75));
    assert.equal(
      words.map((word) => Buffer.from(word[1], 'base64').toString('utf8')).join(''),
      value.subject,
    );
  }
});

test('MIME handles zero bytes and the exact aggregate limit without truncation', async () => {
  for (const length of [0, 131072]) {
    const bytes = new Uint8Array(length).fill(255);
    const parsed = parse(await compose(input(bytes)));
    assert.deepEqual(parsed.parts[1].bytes, Buffer.from(bytes));
  }
  const value = input(new Uint8Array(131072));
  value.attachments.push(input(new Uint8Array(1)).attachments[0]);
  await assert.rejects(compose(value), /Invalid or oversized/);
});

test('MIME refuses header injection, false integrity and invalid encodings', async () => {
  const changes = [
    (v: ReturnType<typeof input>) => {
      v.to = 'a@example.test\r\nBcc: hidden@example.test';
    },
    (v: ReturnType<typeof input>) => {
      v.from = 'x\n@example.test';
    },
    (v: ReturnType<typeof input>) => {
      v.subject = 'hello\r\nBcc: hidden@example.test';
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].name = 'x\r\nInjected: yes';
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].mimeType = 'text/plain\r\nInjected: yes';
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].sha256 = '0'.repeat(64);
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].size = 2;
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].data = 'AB';
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].data = 'AA=';
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].data = 'AA A';
    },
    (v: ReturnType<typeof input>) => {
      v.attachments[0].name = '🌍'.repeat(61);
    },
    (v: ReturnType<typeof input>) => {
      v.text = '🌍'.repeat(20000);
    },
  ];
  for (const change of changes) {
    const value = input(Uint8Array.of(255));
    change(value);
    await assert.rejects(compose(value));
  }
});
