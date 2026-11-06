import OAuthProvider, {
  AuthorizationError,
  OAuthError,
  authorizationErrorRedirect,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { canonicalOrigin, digest, isAllowed, verifyAccess } from './identity.ts';
import type { AccessIdentity, AuthContext, AuthProps, GatewayEnv } from './types.ts';

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
];
const MCP_SCOPES = ['google-workspace', 'offline_access'];
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const SKEW_SECONDS = 60;

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

function page(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirect(location: string, headers: Headers): Response {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  const reader = body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error('Response too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function googleTokens(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  }).catch(() => {
    throw new OAuthError('temporarily_unavailable', {
      description: 'Google authorization unavailable',
      statusCode: 503,
    });
  });
  try {
    const result = JSON.parse(await boundedText(response.body, 65536));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    if (!response.ok) {
      throw new OAuthError(
        result.error === 'invalid_grant' ? 'invalid_grant' : 'temporarily_unavailable',
        {
          description: 'Google authorization failed',
          statusCode: result.error === 'invalid_grant' ? 400 : 503,
        },
      );
    }
    return result;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError('temporarily_unavailable', {
      description: 'Google authorization unavailable',
      statusCode: 503,
    });
  }
}

async function googleSubject(token: unknown, env: GatewayEnv, nonce?: string): Promise<string> {
  if (typeof token !== 'string' || token.length > 16384)
    throw new OAuthError('invalid_grant', { description: 'Google authorization invalid' });
  try {
    const { payload } = await jwtVerify(token, GOOGLE_KEYS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_OAUTH_CLIENT_ID,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    if (
      !payload.sub ||
      typeof payload.iat !== 'number' ||
      payload.iat > Date.now() / 1000 + 60 ||
      payload.email_verified !== true ||
      typeof payload.email !== 'string' ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (payload.azp !== undefined && payload.azp !== env.GOOGLE_OAUTH_CLIENT_ID) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== env.GOOGLE_OAUTH_CLIENT_ID)
    )
      throw new Error();
    return payload.sub;
  } catch {
    throw new OAuthError('invalid_grant', { description: 'Google authorization invalid' });
  }
}

function credentialResponse(
  result: Record<string, unknown>,
  previous?: AuthProps['google'],
): AuthProps['google'] {
  const refreshToken = result.refresh_token ?? previous?.refreshToken;
  const scopes = typeof result.scope === 'string' ? result.scope.split(' ') : undefined;
  if (
    result.token_type !== 'Bearer' ||
    typeof result.access_token !== 'string' ||
    !result.access_token ||
    result.access_token.length > 16384 ||
    typeof refreshToken !== 'string' ||
    !refreshToken ||
    refreshToken.length > 16384 ||
    typeof result.expires_in !== 'number' ||
    !Number.isInteger(result.expires_in) ||
    result.expires_in <= SKEW_SECONDS ||
    result.expires_in > 86400 ||
    ((!previous || scopes) && !GOOGLE_SCOPES.slice(2).every((scope) => scopes?.includes(scope)))
  )
    throw new OAuthError('invalid_grant', { description: 'Google authorization invalid' });
  return {
    subject: previous?.subject ?? '',
    accessToken: result.access_token,
    refreshToken,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}

export async function refreshGrant({
  props: value,
  env,
  grantType,
}: Pick<
  TokenExchangeCallbackOptions<GatewayEnv>,
  'props' | 'env' | 'grantType'
>): Promise<TokenExchangeCallbackResult> {
  const props = value as AuthProps;
  if (
    !props?.identity ||
    !props.google ||
    !isAllowed(props.identity, env) ||
    typeof props.google.subject !== 'string' ||
    !props.google.subject ||
    typeof props.google.expiresAt !== 'number' ||
    !Number.isFinite(props.google.expiresAt) ||
    typeof props.google.refreshToken !== 'string' ||
    !props.google.refreshToken
  )
    throw new OAuthError('invalid_grant', { description: 'Google authorization invalid' });
  let google = props.google;
  if (grantType === 'refresh_token' || google.expiresAt <= Date.now() + 120000) {
    const result = await googleTokens(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: google.refreshToken,
      }),
    );
    google = credentialResponse(result, google);
    if (
      result.id_token !== undefined &&
      (await googleSubject(result.id_token, env)) !== google.subject
    )
      throw new OAuthError('invalid_grant', { description: 'Google authorization invalid' });
  }
  return {
    newProps: { ...props, google },
    accessTokenTTL: Math.min(
      3600,
      Math.floor((google.expiresAt - Date.now()) / 1000) - SKEW_SECONDS,
    ),
  };
}

interface UpstreamState {
  identity: AccessIdentity;
  verifier: string;
  nonce: string;
}

export async function authBrowserHandler(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== canonicalOrigin(env) || !['/authorize', '/callback'].includes(url.pathname))
    return page('Not found', 404);
  if (
    (url.pathname === '/callback' && request.method !== 'GET') ||
    (url.pathname === '/authorize' && !['GET', 'POST'].includes(request.method))
  )
    return page('Method not allowed', 405);
  const identity = await verifyAccess(request, env);
  if (!identity) return page('Cloudflare Access admission required', 403);
  const oauth = env.OAUTH_PROVIDER!;
  try {
    if (url.pathname === '/callback') {
      const resumed = await oauth.finishUpstream<UpstreamState>(request);
      if (
        resumed.data.identity.issuer !== identity.issuer ||
        resumed.data.identity.subject !== identity.subject
      )
        return page('Authorization identity changed', 403);
      if (url.searchParams.has('error'))
        return redirect(
          authorizationErrorRedirect(resumed.request, 'access_denied'),
          resumed.headers,
        );
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) return page('Invalid Google callback');
      const result = await googleTokens(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          code,
          code_verifier: resumed.data.verifier,
          redirect_uri: `${url.origin}/callback`,
        }),
      );
      const google = credentialResponse(result);
      google.subject = await googleSubject(result.id_token, env, resumed.data.nonce);
      const completed = await oauth.completeAuthorization({
        request: resumed.request,
        userId: await digest(
          JSON.stringify(['google-codemode-caller-v1', identity.issuer, identity.subject]),
        ),
        metadata: {},
        scope: resumed.request.scope,
        props: { identity, google } satisfies AuthProps,
      });
      return redirect(completed.redirectTo, resumed.headers);
    }
    if (request.method === 'GET') {
      const authorization = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authorization);
      const consent = await oauth.beginConsent(authorization);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize Google Workspace</title><h1>Authorize ${escape(details.clientName)}</h1><p>Client domain: ${escape(details.clientDomain ?? 'Unverified client name')}</p><p>Redirect host: ${escape(details.redirectHost)}</p><p>Redirect: ${escape(details.redirectUri)}</p>${details.redirectIsLoopback ? '<p>Any local process could be listening at this address.</p>' : ''}<p>Access: ${escape(MCP_SCOPES.join(', '))}</p><p>Google scopes: ${escape(GOOGLE_SCOPES.join(', '))}</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form></html>`,
        { headers: consent.headers },
      );
    }
    if (request.headers.get('origin') !== url.origin) return page('Invalid consent origin', 403);
    if (Number(request.headers.get('content-length') ?? 0) > 8192)
      return page('Consent form too large', 413);
    let body: string;
    try {
      body = await boundedText(request.body, 8192);
    } catch {
      return page('Consent form too large', 413);
    }
    const form = new URLSearchParams(body);
    const handle = form.get('handle') ?? '';
    if (form.get('decision') === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      return redirect(denied.redirectTo, denied.headers);
    }
    if (form.get('decision') !== 'allow') return page('Invalid consent decision');
    const approved = await oauth.approveConsent(request, handle, { scope: MCP_SCOPES });
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const upstream = await oauth.beginUpstream(approved.request, {
      data: { identity, verifier, nonce } satisfies UpstreamState,
      headers: approved.headers,
    });
    const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    target.search = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: `${url.origin}/callback`,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: upstream.state,
      nonce,
      code_challenge: btoa(String.fromCharCode(...new Uint8Array(challenge)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
      code_challenge_method: 'S256',
    }).toString();
    return redirect(target.href, upstream.headers);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof OAuthError)
      return page('Authorization failed. Restart the connection.');
    return page('Authorization unavailable', 503);
  }
}

export function createProvider(
  env: GatewayEnv,
  apiHandler: (
    request: Request,
    env: GatewayEnv,
    context: AuthContext,
  ) => Response | Promise<Response>,
) {
  const origin = canonicalOrigin(env);
  return new OAuthProvider<GatewayEnv>({
    apiRoute: '/mcp',
    apiHandler: {
      fetch: (request, bindings, context) => apiHandler(request, bindings, context as AuthContext),
    },
    defaultHandler: { fetch: authBrowserHandler },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: MCP_SCOPES,
    requiredScopes: ['google-workspace'],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3540,
    tokenExchangeCallback: refreshGrant,
    onError: () => undefined,
  });
}
