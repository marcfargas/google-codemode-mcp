import { AwsClient } from 'aws4fetch';
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
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

function signingConfigured(env: RuntimeEnv) {
  return (
    /^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID ?? '') &&
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET ?? '') &&
    !!env.R2_ACCESS_KEY_ID &&
    !!env.R2_SECRET_ACCESS_KEY
  );
}

export function clientUploadCapabilities(env: RuntimeEnv) {
  return {
    enabled: !!env.ARTIFACTS && signingConfigured(env),
    tool: 'artifact_upload',
    actions: ['grant', 'complete'],
    maxBytes: MAX_STREAM_BYTES,
    grantTtlSeconds: ttl,
    transfer: 'client-direct-signed-r2',
  };
}

function validMetadata(
  body: Record<string, unknown>,
): body is ImportMetadata & Record<string, unknown> {
  return (
    !Object.keys(body).some((key) => !['size', 'sha256', 'mimeType', 'name'].includes(key)) &&
    Number.isSafeInteger(body.size) &&
    (body.size as number) >= 0 &&
    (body.size as number) <= MAX_STREAM_BYTES &&
    typeof body.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(body.sha256) &&
    validMimeType(body.mimeType) &&
    (body.name === undefined ||
      (typeof body.name === 'string' &&
        Buffer.byteLength(body.name) <= 256 &&
        !/[\x00-\x1f\x7f]/.test(body.name)))
  );
}

export type UploadAction =
  ({ action: 'grant' } & ImportMetadata) | { action: 'complete'; uri: string };

export function uploadAction(value: unknown): UploadAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { action, ...args } = value as Record<string, unknown>;
  if (action === 'grant' && validMetadata(args)) return { action, ...args };
  if (
    action === 'complete' &&
    Object.keys(args).join() === 'uri' &&
    typeof args.uri === 'string' &&
    /^artifact:\/\/google-codemode-mcp\/v2\/[A-Za-z0-9_-]{43}$/.test(args.uri)
  )
    return { action, uri: args.uri };
}

export const uploadTool = {
  name: 'artifact_upload',
  description:
    'Authorize a direct local-file upload to private storage, then complete it after PUT. Send only size, SHA-256 and MIME metadata through MCP; PUT bytes directly to the returned signed URL with its exact headers. Repeat complete with the same URI to reconcile a lost completion response before grant expiry.',
  inputSchema: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: {
          action: { const: 'grant' },
          size: { type: 'integer', minimum: 0, maximum: MAX_STREAM_BYTES },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          mimeType: { type: 'string', maxLength: 256 },
          name: { type: 'string', maxLength: 256 },
        },
        required: ['action', 'size', 'sha256', 'mimeType'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          action: { const: 'complete' },
          uri: { type: 'string', pattern: '^artifact://google-codemode-mcp/v2/[A-Za-z0-9_-]{43}$' },
        },
        required: ['action', 'uri'],
        additionalProperties: false,
      },
    ],
  } as JsonSchemaType,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export async function handleUploadMcp(request: Request, env: RuntimeEnv, owner: string) {
  const validator = new CfWorkerJsonSchemaValidator();
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: 'google-codemode-mcp', version: '0.1.0' },
        { supportedProtocolVersions: ['2026-07-28'], jsonSchemaValidator: validator },
      );
      server.registerTool(
        uploadTool.name,
        {
          ...uploadTool,
          inputSchema: fromJsonSchema<UploadAction>(uploadTool.inputSchema, validator),
        },
        async (args) => {
          const action = uploadAction(args);
          if (!action) throw new Error('Invalid artifact_upload arguments');
          try {
            let value;
            if (action.action === 'grant') {
              const { action: _, ...metadata } = action;
              value = await grantUpload(env, owner, metadata);
            } else value = await completeArtifactUpload(env, owner, action.uri);
            return {
              content: [
                { type: 'text', text: JSON.stringify(value) },
                ...(action.action === 'complete'
                  ? [
                      {
                        type: 'resource_link' as const,
                        uri: value.uri,
                        name: 'Uploaded artifact',
                        mimeType: 'application/json',
                      },
                    ]
                  : []),
              ],
              structuredContent: value,
            };
          } catch {
            return { isError: true, content: [{ type: 'text', text: 'Artifact unavailable' }] };
          }
        },
      );
      return server;
    },
    {
      legacy: 'reject',
      responseMode: 'json',
      keepAliveMs: 0,
      maxSubscriptions: 0,
      maxRequestBodySize: 8192,
    },
  );
  try {
    const response = await handler.fetch(request);
    return new Response(await boundedText(response, 16384), response);
  } finally {
    await handler.close();
  }
}

export async function grantUpload(env: RuntimeEnv, owner: string, metadata: ImportMetadata) {
  if (!clientUploadCapabilities(env).enabled || !validMetadata({ ...metadata }))
    throw unavailable();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const uri = prefix + 'v2/' + secret;
  const headers = {
    'Content-Length': String(metadata.size),
    'Content-Type': metadata.mimeType,
    'If-None-Match': '*',
  };
  const signed = await presign(env, await objectKey(uri), 'PUT', ttl, headers);
  const expiresAt = Date.now() + ttl * 1000;
  await env.OAUTH_KV.put(
    `upload:${await digest(uri)}`,
    JSON.stringify({ owner, metadata, expiresAt }),
    { expirationTtl: ttl },
  );
  return {
    uri,
    uploadUrl: signed.url,
    method: 'PUT',
    headers,
    expiresAt,
    completeEndpoint: '/mcp/artifacts/complete',
    completion: { tool: uploadTool.name, arguments: { action: 'complete', uri } },
  };
}

export async function completeArtifactUpload(env: RuntimeEnv, owner: string, uri: string) {
  if (!clientUploadCapabilities(env).enabled) throw unavailable();
  await objectKey(uri);
  const grant = await env.OAUTH_KV.get<{
    owner: string;
    metadata: ImportMetadata;
    expiresAt: number;
  }>(`upload:${await digest(uri)}`, 'json');
  if (!grant || grant.owner !== owner || grant.expiresAt <= Date.now()) throw unavailable();
  // Retain the short-lived grant so a lost finalize response can be reconciled.
  return env.EXECUTOR.completeUpload(uri, owner, grant.metadata);
}

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
  if (!signingConfigured(env)) throw unavailable();
  params.set('X-Amz-Expires', String(seconds));
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
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
      if (!validMetadata(body)) throw unavailable();
      return Response.json(await grantUpload(env, owner, body), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (
      path === '/mcp/artifacts/complete' &&
      Object.keys(body).join() === 'uri' &&
      typeof body.uri === 'string'
    ) {
      return Response.json(await completeArtifactUpload(env, owner, body.uri), {
        headers: { 'cache-control': 'no-store' },
      });
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
