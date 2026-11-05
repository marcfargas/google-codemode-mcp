import assert from 'node:assert/strict';
import { readMultipart } from './multipart.ts';

export async function withSyntheticDrive(
  options: {
    failSecondCreate?: 'http' | 'missing-id';
    failDelete?: string;
    expireReadiness?: boolean;
    versions?: (string | undefined)[];
    metadataDrift?: string;
    contentDriftAt?: number;
  },
  exercise: (fixture: {
    calls: { path: string; method: string; fields: string | null; media: boolean }[];
    manifests: any[];
    stored: Map<string, { metadata: Record<string, unknown>; bytes: Buffer }>;
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let now = originalNow();
  Date.now = () => now;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    now += delay;
    return originalSetTimeout(callback, 0, ...args);
  }) as typeof setTimeout;
  const stored = new Map<string, { metadata: Record<string, unknown>; bytes: Buffer }>();
  const calls: { path: string; method: string; fields: string | null; media: boolean }[] = [];
  const manifests: any[] = [];
  let creates = 0;
  let metadataReads = 0;
  let mediaReads = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      path: url.pathname,
      method,
      fields: url.searchParams.get('fields'),
      media: url.searchParams.get('alt') === 'media',
    });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-google-token');
    if (url.pathname === '/drive/v3/about')
      return Response.json({ user: { emailAddress: 'test@example.invalid' } });
    if (url.pathname === '/upload/drive/v3/files') {
      creates++;
      if (creates === 2 && options.failSecondCreate === 'http')
        return Response.json({ error: {} }, { status: 503 });
      if (creates === 2 && options.failSecondCreate === 'missing-id') return Response.json({});
      const { metadata, bytes } = readMultipart(
        Buffer.from(init!.body as Uint8Array),
        new Headers(init?.headers).get('Content-Type')!,
      );
      const id = `synthetic-owned-${creates}`;
      stored.set(id, { metadata, bytes });
      return Response.json({ id });
    }
    if (url.pathname === '/drive/v3/files') {
      if (options.expireReadiness) {
        now += 30_001;
        return Response.json({ files: [], incompleteSearch: false });
      }
      return Response.json({
        files: [...stored].map(([id, file]) => ({ id, name: file.metadata.name })),
        incompleteSearch: false,
      });
    }
    const id = url.pathname.split('/').at(-1)!;
    const file = stored.get(id);
    assert.ok(file, 'fixture accesses only a known owned identity');
    if (method === 'DELETE')
      return options.failDelete === id
        ? Response.json({ error: {} }, { status: 503 })
        : new Response(null, { status: 204 });
    if (url.searchParams.get('alt') === 'media') {
      mediaReads++;
      return new Response(
        options.contentDriftAt && mediaReads >= options.contentDriftAt
          ? Buffer.from('corrupt')
          : file.bytes,
      );
    }
    metadataReads++;
    const metadata: Record<string, unknown> = {
      ...file.metadata,
      id,
      trashed: false,
      parents: ['root'],
      version: options.versions
        ? options.versions[Math.min(metadataReads - 1, options.versions.length - 1)]
        : '7',
    };
    if (options.metadataDrift && metadataReads >= 1)
      metadata[options.metadataDrift] =
        options.metadataDrift === 'parents'
          ? null
          : options.metadataDrift === 'trashed'
            ? true
            : 'changed';
    return Response.json(metadata);
  }) as typeof fetch;
  try {
    await exercise({ calls, manifests, stored });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
}
