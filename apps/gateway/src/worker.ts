import { createProvider } from './auth.ts';
import { canonicalOrigin, isAllowed, ownerFor, verifyAccess } from './identity.ts';
import { artifactRequest, boundedText, download, type RuntimeEnv } from './artifacts.ts';
import type { AuthContext, GatewayEnv } from './types.ts';

const version = '2026-07-28';
function rpcError(id: unknown, code: number, message: string) {
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    {
      headers: { 'cache-control': 'no-store' },
    },
  );
}

export async function proxy(
  request: Request,
  env: RuntimeEnv,
  context: AuthContext,
): Promise<Response> {
  if (
    !context.props?.identity ||
    !context.props.google ||
    !isAllowed(context.props.identity, env) ||
    !context.auth.scope.includes('google-workspace')
  )
    return new Response('Forbidden', { status: 403 });
  if (env.REQUIRE_ACCESS_ON_MCP !== 'false') {
    const identity = await verifyAccess(request, env);
    if (
      !identity ||
      identity.issuer !== context.props.identity.issuer ||
      identity.subject !== context.props.identity.subject
    )
      return new Response('Cloudflare Access admission required', { status: 403 });
  }
  const owner = await ownerFor(context.props, env);
  if (new URL(request.url).pathname.startsWith('/mcp/artifacts/'))
    return artifactRequest(request, env, owner);
  if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.headers.has('origin'))
    return new Response('Browser MCP requests are not supported', { status: 403 });
  let message: any;
  try {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error();
    message = JSON.parse(await boundedText(request));
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    )
      throw new Error();
  } catch {
    return rpcError(null, -32700, 'Invalid bounded JSON-RPC request');
  }
  const args = message.params?.arguments;
  if (args && (Object.hasOwn(args, 'accessToken') || Object.hasOwn(args, 'ownerScope')))
    return rpcError(
      message.id,
      -32602,
      'Credential and owner arguments are supplied by the gateway',
    );
  if (message.method === 'tools/call' && message.params?.name !== 'describe') {
    if (context.props.google.expiresAt <= Date.now() + 1000)
      return new Response('Google grant expired; refresh the MCP token', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      });
    message.params.arguments = { ...(args ?? {}), accessToken: context.props.google.accessToken };
  }
  // Only protocol headers cross this seam; no bearer, cookies, Access assertions,
  // forwarded destinations or caller-supplied identity reach the executor.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const name of ['MCP-Protocol-Version', 'MCP-Method', 'MCP-Name']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (headers.get('MCP-Protocol-Version') !== version)
    return rpcError(message.id, -32600, `MCP revision ${version} required`);
  let response: Response;
  try {
    response = await env.EXECUTOR.mcp(
      new Request('https://executor.internal/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      }),
      owner,
    );
  } catch {
    // In particular, never replay a tools/call after a lost response.
    return rpcError(
      message.id,
      -32603,
      'Executor response unavailable; effects may be unknown. Reconcile before repeating a mutation.',
    );
  }
  let result: any;
  try {
    result = JSON.parse(await boundedText(response, 4 * 1024 * 1024));
  } catch {
    return rpcError(
      message.id,
      -32603,
      'Executor response unavailable; effects may be unknown. Reconcile before repeating a mutation.',
    );
  }
  if (message.method === 'tools/list' && Array.isArray(result.result?.tools)) {
    for (const tool of result.result.tools) {
      if (tool.inputSchema?.properties) delete tool.inputSchema.properties.accessToken;
      if (Array.isArray(tool.inputSchema?.required))
        tool.inputSchema.required = tool.inputSchema.required.filter(
          (key: string) => key !== 'accessToken',
        );
    }
  }
  // URL failure cannot turn an acknowledged Google write into an apparent failure.
  // Keep its native receipt, and annotate only manifests this caller can access.
  const links =
    result.result?.content?.filter(
      (item: any) => item.type === 'resource_link' && typeof item.uri === 'string',
    ) ?? [];
  const downloads: unknown[] = [];
  for (const link of links.slice(0, 8)) {
    try {
      const reference = await download(env, owner, link.uri);
      downloads.push(reference);
      result.result.content.push({
        type: 'resource_link',
        uri: reference.downloadUrl,
        name: reference.name ?? 'Download artifact',
        mimeType: 'application/octet-stream',
      });
    } catch {
      /* Native references and outcomes remain usable without URL issuance. */
    }
  }
  if (downloads.length)
    result.result._meta = { ...result.result._meta, artifactDownloads: downloads };
  if (message.method === 'resources/read' && typeof message.params?.uri === 'string') {
    try {
      const reference = await download(env, owner, message.params.uri);
      const content = result.result?.contents?.[0];
      if (typeof content?.text === 'string')
        content.text = JSON.stringify({
          ...JSON.parse(content.text),
          downloadUrl: reference.downloadUrl,
          downloadExpiresAt: reference.downloadExpiresAt,
        });
    } catch {
      /* Skill resources and unavailable artifact URLs pass through intact. */
    }
  }
  return Response.json(result, {
    status: response.status,
    headers: { 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      // Preview aliases use the configured canonical OAuth issuer/callback.
      // Admission remains identical, and tokens remain bound to that resource.
      const canonical = new URL(request.url);
      const origin = canonicalOrigin(env);
      if (canonical.origin !== origin && ['/authorize', '/callback'].includes(canonical.pathname)) {
        if (request.method !== 'GET')
          return new Response('Use the canonical authorization origin', { status: 403 });
        return Response.redirect(origin + canonical.pathname + canonical.search, 302);
      }
      const rewritten = new Request(origin + canonical.pathname + canonical.search, request);
      const provider = createProvider(env, (req, bindings: GatewayEnv, context) =>
        proxy(req, bindings as RuntimeEnv, context),
      );
      return await provider.fetch(rewritten, env, ctx);
    } catch {
      return new Response('Gateway unavailable', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
  },
};
