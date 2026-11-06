import assert from 'node:assert/strict';

/** Decode the captured wire independently of the producer and its byte helpers. */
export function readMultipart(body: Uint8Array, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  assert.ok(boundary);
  const wire = Buffer.from(body);
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const first = wire.indexOf(marker);
  assert.equal(first, 0);
  const metadataStart = wire.indexOf(separator, first) + separator.length;
  const second = wire.indexOf(marker, metadataStart);
  const metadata = JSON.parse(wire.subarray(metadataStart, second - 2).toString('utf8'));
  const mediaHeaderStart = second + marker.length + 2;
  const mediaStart = wire.indexOf(separator, mediaHeaderStart) + separator.length;
  const end = wire.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
  assert.ok(end >= mediaStart);
  return {
    metadata,
    headers: wire.subarray(mediaHeaderStart, mediaStart - 4).toString('ascii'),
    bytes: wire.subarray(mediaStart, end),
  };
}
