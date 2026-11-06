import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';

test('verified admission and stable ownership survive token rotation; upstream refresh failures stay distinct', async () => {
  const issuer = 'https://auth-fixture.cloudflareaccess.com';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256' };
  const env = {
    GATEWAY_ORIGIN: 'https://workspace.example',
    CF_ACCESS_TEAM_DOMAIN: issuer,
    CF_ACCESS_AUD: 'gateway',
    ALLOWED_EMAILS: 'owner@example.com',
    ENVIRONMENT: 'test',
    GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client',
    GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret',
  };
  const props = {
    identity: { issuer, subject: 'human', email: 'owner@example.com' },
    google: {
      subject: 'google-human',
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600000,
    },
  };
  let tokenResult: Record<string, unknown> = {
    access_token: 'new',
    token_type: 'Bearer',
    expires_in: 1800,
  };
  let tokenStatus = 200;
  let tokenCalls = 0;
  let nonce = '';
  let googleChallenge = '';
  let authCodeCalls = 0;
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { createProvider, refreshGrant } from './apps/gateway/src/auth.ts';
      import { ownerFor, verifyAccess } from './apps/gateway/src/identity.ts';
      export default { async fetch(request, env, ctx) {
        try {
          const path = new URL(request.url).pathname;
          if (path === '/access') return Response.json(await verifyAccess(request, env));
          if (!['/owner','/refresh'].includes(path)) return createProvider(env, async (req, bindings, context) =>
            Response.json({identity:context.props.identity, subject:context.props.google.subject,
              bound:context.props.google.accessToken === 'granted-access'})).fetch(request, env, ctx);
          const body = await request.json();
          return Response.json(path === '/owner' ? await ownerFor(body, env)
            : await refreshGrant({props:body, env, grantType:'refresh_token'}));
        } catch (error) { return Response.json({code:error.code ?? 'invalid_owner',message:error.message}, {status:400}); }
      }};`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers'],
  });
  const worker = new Miniflare({
    workers: [
      {
        config: {
          name: 'gateway-auth-test',
          compatibilityDate: '2026-07-28',
          compatibilityFlags: ['global_fetch_strictly_public'],
          manifest: {
            mainModule: 'worker.js',
            modulesRoot: '/',
            modules: {
              'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text },
            },
          },
          env: {
            ...Object.fromEntries(
              Object.entries(env).map(([key, value]) => [key, { type: 'text', value }]),
            ),
            OAUTH_KV: { type: 'kv', id: 'gateway-oauth' },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              if (
                request.url === `${issuer}/cdn-cgi/access/certs` ||
                request.url === 'https://www.googleapis.com/oauth2/v3/certs'
              )
                return MiniflareResponse.json({ keys: [jwk] });
              assert.equal(request.url, 'https://oauth2.googleapis.com/token');
              const body = new URLSearchParams(await request.text());
              assert.equal(body.get('client_secret'), env.GOOGLE_OAUTH_CLIENT_SECRET);
              if (body.get('grant_type') === 'authorization_code') {
                authCodeCalls++;
                assert.equal(
                  createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
                  googleChallenge,
                );
                assert.equal(body.get('redirect_uri'), 'https://workspace.example/callback');
                const idToken = await new SignJWT({
                  nonce,
                  email: 'google@example.com',
                  email_verified: true,
                })
                  .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
                  .setIssuer('https://accounts.google.com')
                  .setAudience(env.GOOGLE_OAUTH_CLIENT_ID)
                  .setSubject('google-human')
                  .setIssuedAt()
                  .setExpirationTime('1h')
                  .sign(privateKey);
                return MiniflareResponse.json({
                  access_token: 'granted-access',
                  refresh_token: 'granted-refresh',
                  token_type: 'Bearer',
                  expires_in: 3600,
                  id_token: idToken,
                  scope:
                    'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive.file',
                });
              }
              assert.equal(body.get('refresh_token'), 'refresh');
              tokenCalls++;
              return MiniflareResponse.json(tokenResult, { status: tokenStatus });
            },
          },
        },
      },
    ],
  });
  try {
    const call = async (path: string, body: unknown) => {
      const response = await worker.dispatchFetch(`https://workspace.example/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      return response.json() as Promise<any>;
    };
    const assertion = (overrides: Record<string, unknown> = {}, subject = 'human') =>
      new SignJWT({
        type: 'app',
        email: props.identity.email,
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience('gateway')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    const admit = async (token: string) =>
      (
        await worker.dispatchFetch('https://workspace.example/access', {
          headers: { 'cf-access-jwt-assertion': token },
        })
      ).json();
    assert.deepEqual(await admit(await assertion()), props.identity);
    assert.equal(await admit(await assertion({ email: 'other@example.com' })), null);
    assert.equal(await admit(await assertion({ type: 'service' })), null);
    assert.equal(await admit('forged'), null);
    const owner = await call('owner', props);
    assert.equal(
      await call('owner', { ...props, google: { ...props.google, accessToken: 'rotated' } }),
      owner,
    );
    assert.notEqual(
      await call('owner', { ...props, google: { ...props.google, subject: 'another-account' } }),
      owner,
    );
    const refreshed = await call('refresh', props);
    assert.ok(refreshed.newProps, JSON.stringify({ refreshed, tokenCalls }));
    assert.equal(refreshed.newProps.google.accessToken, 'new');
    assert.equal(refreshed.newProps.google.refreshToken, 'refresh');
    assert.ok(refreshed.accessTokenTTL <= 1740 && refreshed.accessTokenTTL >= 1738);
    assert.equal(await call('owner', refreshed.newProps), owner);
    tokenStatus = 400;
    tokenResult = { error: 'invalid_grant' };
    assert.equal((await call('refresh', props)).code, 'invalid_grant');
    tokenStatus = 503;
    tokenResult = { error: 'temporarily_unavailable' };
    assert.equal((await call('refresh', props)).code, 'temporarily_unavailable');
    assert.equal(
      (
        await call('refresh', {
          ...props,
          identity: { ...props.identity, email: 'removed@example.com' },
        })
      ).code,
      'invalid_grant',
    );
    assert.equal(tokenCalls, 3, 'removed identity is rejected before any upstream refresh');

    const cfa = await assertion();
    const browser = async (
      path: string,
      cookies: Map<string, string>,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) => {
      const response = await worker.dispatchFetch(new URL(path, env.GATEWAY_ORIGIN).href, {
        ...init,
        redirect: 'manual',
        headers: {
          'cf-access-jwt-assertion': cfa,
          cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(init.method === 'POST'
            ? { origin: env.GATEWAY_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }
            : {}),
          ...init.headers,
        },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const split = pair.indexOf('=');
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return response;
    };
    const registered = await worker.dispatchFetch('https://workspace.example/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: '<script>host</script>',
        redirect_uris: ['https://host.example/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const verifier = 'host-fixture-pkce-verifier-'.repeat(3);
    const authorization = (resource = 'https://workspace.example/mcp') =>
      '/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://host.example/callback',
        resource,
        scope: 'google-workspace offline_access',
        state: 'host-state',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
    const invalidResource = await browser(authorization('https://other.example/mcp'), new Map());
    assert.match(
      invalidResource.headers.get('location') ?? (await invalidResource.text()),
      /invalid_target/,
    );
    const begin = async () => {
      const cookies = new Map<string, string>();
      const consent = await browser(authorization(), cookies);
      assert.equal(consent.status, 200);
      const html = await consent.text();
      assert.ok(html.includes('&lt;script&gt;host&lt;/script&gt;') && !html.includes('<script>'));
      const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
      const body = new URLSearchParams({ handle, decision: 'allow' }).toString();
      assert.equal((await browser('/authorize', new Map(), { method: 'POST', body })).status, 400);
      const allowed = await browser('/authorize', cookies, { method: 'POST', body });
      assert.equal(allowed.status, 302);
      const google = new URL(allowed.headers.get('location')!);
      assert.equal(google.origin, 'https://accounts.google.com');
      assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
      nonce = google.searchParams.get('nonce')!;
      googleChallenge = google.searchParams.get('code_challenge')!;
      return {
        cookies,
        callback:
          '/callback?' +
          new URLSearchParams({ state: google.searchParams.get('state')!, code: 'synthetic-code' }),
      };
    };
    const switched = await begin();
    assert.equal(
      (
        await browser(switched.callback, switched.cookies, {
          headers: { 'cf-access-jwt-assertion': await assertion({}, 'other-human') },
        })
      ).status,
      403,
    );
    assert.equal(authCodeCalls, 0, 'changed principal is rejected before Google exchange');
    const badNonce = await begin();
    nonce = 'incorrect-nonce';
    assert.equal((await browser(badNonce.callback, badNonce.cookies)).status, 400);
    const valid = await begin();
    assert.equal((await browser(valid.callback, new Map())).status, 400);
    const complete = await browser(valid.callback, valid.cookies);
    assert.equal(complete.status, 302);
    const returned = new URL(complete.headers.get('location')!);
    assert.equal(returned.searchParams.get('state'), 'host-state');
    const tokenBody = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: returned.searchParams.get('code')!,
      redirect_uri: 'https://host.example/callback',
      resource: 'https://workspace.example/mcp',
    };
    const exchange = (codeVerifier: string) =>
      worker.dispatchFetch('https://workspace.example/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...tokenBody, code_verifier: codeVerifier }).toString(),
      });
    assert.equal((await exchange('wrong-verifier'.repeat(5))).status, 400);
    const issued = await exchange(verifier);
    assert.equal(issued.status, 200);
    const issuedText = await issued.text();
    assert.ok(!issuedText.includes('granted-access') && !issuedText.includes('granted-refresh'));
    const token = JSON.parse(issuedText);
    const api = await worker.dispatchFetch('https://workspace.example/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    assert.deepEqual(await api.json(), {
      identity: props.identity,
      subject: 'google-human',
      bound: true,
    });
    const kv = await worker.getKVNamespace('OAUTH_KV');
    for (const key of (await kv.list()).keys) {
      const value = await kv.get(key.name);
      assert.ok(
        !value?.includes('granted-access') && !value?.includes('granted-refresh'),
        'stored Google credentials are encrypted',
      );
    }
  } finally {
    await worker.dispose();
  }
});
