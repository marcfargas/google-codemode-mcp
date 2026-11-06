import { AwsClient } from 'aws4fetch';
import { createArtifactStore, type ArtifactReference } from '../../executor/src/artifacts.ts';
import { createR2Storage, MAX_STREAM_BYTES } from '../../executor/src/storage.ts';
import { createStreamArtifactStore } from '../../executor/src/stream-artifacts.ts';
import { validMimeType } from '../../executor/src/media.ts';
import type { ImportMetadata } from '../../executor/src/storage-import.ts';
import { digest } from './identity.ts';
import type { GatewayEnv } from './types.ts';

export interface RuntimeEnv extends GatewayEnv {
  EXECUTOR: {
    mcp(request: Request, owner: string): Promise<Response>;
    completeUpload(
      uri: string,
      owner: string,
      metadata: ImportMetadata,
    ): Promise<ArtifactReference>;
  };
  ARTIFACTS?: R2Bucket;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  REQUIRE_ACCESS_ON_MCP?: string;
}
const prefix = 'artifact://google-codemode-mcp/';
const ttl = 600;
const unavailable = () => new Error('Artifact unavailable');

async function objectKey(uri: string) {
  const match = /^artifact:\/\/google-codemode-mcp\/(v[12])\/([A-Za-z0-9_-]{43})$/.exec(uri);
  if (!match || Buffer.from(match[2], 'base64url').toString('base64url') !== match[2])
    throw unavailable();
  return `artifacts/${match[1]}/${await digest(match[2])}${match[1] === 'v2' ? '/data' : ''}`;
}

export async function download(env: RuntimeEnv, owner: string, uri: string) {
  if (!env.ARTIFACTS || !uri.startsWith(prefix)) throw unavailable();
  const key = await objectKey(uri);
  const store = uri.startsWith(prefix + 'v2/')
    ? createStreamArtifactStore(createR2Storage(env.ARTIFACTS), { owner })
    : createArtifactStore(env.ARTIFACTS, { owner });
  const resource = await store.readResource(uri);
  const content = resource.contents[0];
  if (!('text' in content)) throw unavailable();
  const reference = JSON.parse(content.text) as ArtifactReference;
  const seconds = Math.min(ttl, Math.floor((reference.expiresAt - Date.now()) / 1000));
  if (seconds < 1) throw unavailable();
  const name = reference.name ?? `artifact-${reference.sha256.slice(0, 12)}`;
  const params = new URLSearchParams({
    'response-content-type': 'application/octet-stream',
    'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
  });
  const signed = await presign(env, key, 'GET', seconds, {}, params);
  return { ...reference, downloadUrl: signed.url, downloadExpiresAt: Date.now() + seconds * 1000 };
}

async function presign(
  env: RuntimeEnv,
  key: string,
  method: string,
  seconds: number,
  headers: Record<string, string> = {},
  params = new URLSearchParams(),
) {
  if (
    !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID ?? '') ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET ?? '') ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  )
    throw unavailable();
  params.set('X-Amz-Expires', String(seconds));
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    retries: 0,
  });
  return client.sign(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}?${params}`,
    {
      method,
      headers,
      aws: { signQuery: true, allHeaders: true },
    },
  );
}

export async function artifactRequest(
  request: Request,
  env: RuntimeEnv,
  owner: string,
): Promise<Response> {
  try {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const text = await boundedText(request, 8192);
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw unavailable();
    const path = new URL(request.url).pathname;
    if (
      path === '/mcp/artifacts/download' &&
      Object.keys(body).join() === 'uri' &&
      typeof body.uri === 'string'
    )
      return Response.json(await download(env, owner, body.uri), {
        headers: { 'cache-control': 'no-store' },
      });
    if (path === '/mcp/artifacts/upload') {
      const { size, sha256, mimeType, name } = body;
      if (
        Object.keys(body).some((key) => !['size', 'sha256', 'mimeType', 'name'].includes(key)) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_STREAM_BYTES ||
        typeof sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !validMimeType(mimeType) ||
        (name !== undefined &&
          (typeof name !== 'string' ||
            Buffer.byteLength(name) > 256 ||
            /[\x00-\x1f\x7f]/.test(name)))
      )
        throw unavailable();
      const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      const uri = prefix + 'v2/' + secret;
      const metadata = { size, sha256, mimeType, ...(name === undefined ? {} : { name }) };
      const headers = {
        'Content-Length': String(size),
        'Content-Type': mimeType,
        'If-None-Match': '*',
      };
      const signed = await presign(env, await objectKey(uri), 'PUT', ttl, headers);
      const expiresAt = Date.now() + ttl * 1000;
      await env.OAUTH_KV.put(
        `upload:${await digest(uri)}`,
        JSON.stringify({ owner, metadata, expiresAt }),
        { expirationTtl: ttl },
      );
      return Response.json(
        {
          uri,
          uploadUrl: signed.url,
          method: 'PUT',
          headers,
          expiresAt,
          completeEndpoint: '/mcp/artifacts/complete',
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    if (
      path === '/mcp/artifacts/complete' &&
      Object.keys(body).join() === 'uri' &&
      typeof body.uri === 'string'
    ) {
      const grant = await env.OAUTH_KV.get<{
        owner: string;
        metadata: ImportMetadata;
        expiresAt: number;
      }>(`upload:${await digest(body.uri)}`, 'json');
      if (!grant || grant.owner !== owner || grant.expiresAt <= Date.now()) throw unavailable();
      const reference = await env.EXECUTOR.completeUpload(body.uri, owner, grant.metadata);
      // Retain the short-lived grant so a lost finalize response can be reconciled.
      return Response.json(reference, { headers: { 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  } catch {
    return new Response('Artifact unavailable', {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  }
}

export async function boundedText(request: Request | Response, limit = 1048576): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Message too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
