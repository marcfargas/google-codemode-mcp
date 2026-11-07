import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare, Response as MFResponse } from 'miniflare';
import { build } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const props = {
  identity: {
    issuer: 'https://fixture.cloudflareaccess.com',
    subject: 'human',
    email: 'owner@example.com',
  },
  google: {
    subject: 'google-account',
    accessToken: 'synthetic-google-access',
    refreshToken: 'NEVER-IN-EXECUTOR',
    expiresAt: Date.now() + 3600000,
  },
};
const document = {
  name: 'drive',
  version: 'v3',
  revision: 'gateway-fixture',
  rootUrl: 'https://www.googleapis.com/',
  servicePath: 'drive/v3/',
  schemas: {
    File: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
  },
  resources: {
    files: {
      methods: {
        get: {
          path: 'files/{fileId}',
          httpMethod: 'GET',
          supportsMediaDownload: true,
          parameters: {
            fileId: { type: 'string', location: 'path', required: true },
            alt: { type: 'string', location: 'query' },
          },
          response: { $ref: 'File' },
        },
        create: {
          path: 'files',
          httpMethod: 'POST',
          supportsMediaUpload: true,
          mediaUpload: {
            protocols: { simple: { path: '/upload/drive/v3/files', multipart: true } },
          },
          request: { $ref: 'File' },
          response: { $ref: 'File' },
        },
      },
    },
  },
};

test('gateway and executor preserve discovery, trusted ownership, isolated credentials, signed transfers and no-replay behavior', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256' };
  const fixture = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import gateway from './apps/gateway/src/worker.ts';
    import { proxy } from './apps/gateway/src/worker.ts';
    export default {async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/frontdoor') return gateway.fetch(new Request('https://workspace.example/mcp', request),env,ctx);
      if (new URL(request.url).pathname === '/alias-authorize') return gateway.fetch(new Request('https://preview.example/authorize?client_id=example', request),env,ctx);
      const props = structuredClone(env.TEST_PROPS);
      if (request.headers.has('x-other-user')) props.identity.subject = 'other-human';
      if (request.headers.has('x-other-google')) props.google.subject = 'other-google';
      if (request.headers.has('x-rotated-token')) props.google.accessToken = 'synthetic-google-rotated';
      if (request.headers.has('x-expired-google')) props.google.expiresAt = 0;
      if (request.headers.has('x-disabled-signing')) env = {...env, R2_SECRET_ACCESS_KEY:undefined};
      const original = env.EXECUTOR;
      env = {...env, EXECUTOR:{
        mcp: async (forwarded, owner) => {
          for (const header of forwarded.headers.keys()) if (!['content-type','mcp-protocol-version','mcp-method','mcp-name'].includes(header)) throw new Error('header crossed boundary');
          if (/HOST-ONLY|NEVER-IN-EXECUTOR/.test(await forwarded.clone().text())) throw new Error('credential crossed boundary');
          const result = await original.mcp(forwarded,owner);
          if (request.headers.has('x-tool-collision')) {
            const body = await result.json();
            body.result.tools.push({name:'artifact_upload'});
            return Response.json(body);
          }
          if (new URL(request.url).searchParams.has('lose')) throw new Error('lost response');
          return result;
        },
        completeUpload: async (...args) => {
          if (JSON.stringify(args).length > 1024 || /HOST-ONLY|NEVER-IN-EXECUTOR/.test(JSON.stringify(args))) throw new Error('non-metadata completion RPC');
          const result = await original.completeUpload(...args);
          if (new URL(request.url).searchParams.has('lose-complete')) throw new Error('lost completion response');
          return result;
        },
      }};
      return proxy(request,env,{...ctx,props,auth:{scope:request.headers.has('x-no-scope')?[]:['google-workspace']}});
    }};`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:workers'],
  });
  const data = Buffer.alloc(2 * 1024 * 1024, 83);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const localBytes = Buffer.from(Array.from({ length: 262144 }, (_, index) => index % 251));
  const localSha256 = createHash('sha256').update(localBytes).digest('hex');
  let writes = 0;
  const gatewayEnv = {
    GATEWAY_ORIGIN: 'https://workspace.example',
    CF_ACCESS_TEAM_DOMAIN: 'fixture.cloudflareaccess.com',
    CF_ACCESS_AUD: 'fixture',
    ALLOWED_EMAILS: 'owner@example.com',
    ENVIRONMENT: 'test',
    GOOGLE_OAUTH_CLIENT_ID: 'web-client',
    GOOGLE_OAUTH_CLIENT_SECRET: 'NEVER-IN-EXECUTOR',
    REQUIRE_ACCESS_ON_MCP: 'false',
    R2_ACCOUNT_ID: '0'.repeat(32),
    R2_BUCKET: 'private-artifacts',
    R2_ACCESS_KEY_ID: 'fixture-key',
    R2_SECRET_ACCESS_KEY: 'NEVER-IN-EXECUTOR',
  };
  const manifest = (contents: string) => ({
    mainModule: 'worker.js',
    modulesRoot: '/',
    modules: { 'worker.js': { type: 'esm' as const, contents } },
  });
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'gateway',
          compatibilityDate: '2026-07-28',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
          manifest: manifest(fixture.outputFiles[0].text),
          env: {
            ...Object.fromEntries(
              Object.entries(gatewayEnv).map(([key, value]) => [
                key,
                { type: 'text' as const, value },
              ]),
            ),
            TEST_PROPS: { type: 'json', value: props },
            OAUTH_KV: { type: 'kv', id: 'oauth' },
            ARTIFACTS: { type: 'r2', name: 'artifacts' },
            EXECUTOR: { type: 'worker', worker: 'executor', exportName: 'Executor' },
          },
        },
      },
      {
        config: {
          name: 'executor',
          compatibilityDate: '2026-07-28',
          compatibilityFlags: ['nodejs_compat'],
          manifest: manifest(await readFile('dist/worker.js', 'utf8')),
          env: {
            LOADER: { type: 'worker-loader' },
            ARTIFACTS: { type: 'r2', name: 'artifacts' },
            GATEWAY_ONLY: { type: 'text', value: 'true' },
            CF_ACCESS_TEAM_DOMAIN: { type: 'text', value: 'fixture.cloudflareaccess.com' },
            CF_ACCESS_AUD: { type: 'text', value: 'fixture' },
            ALLOWED_EMAILS: { type: 'text', value: 'owner@example.com' },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              if (request.url === props.identity.issuer + '/cdn-cgi/access/certs')
                return MFResponse.json({ keys: [jwk] });
              if (request.url.includes('$discovery') || request.url.includes('/discovery/'))
                return MFResponse.json(document);
              assert.match(
                request.headers.get('authorization') ?? '',
                /^Bearer synthetic-google-(access|rotated)$/,
              );
              for (const header of ['cookie', 'cf-access-jwt-assertion', 'x-owner-scope'])
                assert.equal(request.headers.has(header), false);
              assert.ok(!(await request.clone().text()).includes('NEVER-IN-EXECUTOR'));
              if (request.method === 'POST') {
                if (request.url.includes('/upload/drive/v3/files')) {
                  const wire = Buffer.from(await request.arrayBuffer());
                  const boundary = request.headers.get('content-type')!.split('boundary=')[1];
                  const prefix = Buffer.from(
                    `--${boundary}\r\ncontent-type: application/json\r\n\r\n{"name":"local-upload.bin"}\r\n` +
                      `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
                  );
                  assert.deepEqual(
                    wire,
                    Buffer.concat([prefix, localBytes, Buffer.from(`\r\n--${boundary}--`)]),
                  );
                  assert.equal(request.headers.get('content-length'), String(wire.length));
                }
                writes++;
                return MFResponse.json({ id: 'created' });
              }
              return new MFResponse(data, {
                headers: {
                  'content-length': String(data.length),
                  'content-type': 'application/octet-stream',
                },
              });
            },
          },
        },
      },
    ],
  });
  try {
    const call = async (
      method: string,
      params: Record<string, unknown> = {},
      extra: Record<string, string> = {},
      query = '',
    ) => {
      const result = await mf.dispatchFetch('https://workspace.example/mcp' + query, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': method,
          'mcp-name': String(params.name ?? params.uri ?? ''),
          authorization: 'Bearer HOST-ONLY',
          cookie: 'HOST-ONLY',
          'cf-access-jwt-assertion': 'HOST-ONLY',
          ...extra,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      return result.headers.get('content-type')?.includes('application/json')
        ? (result.json() as Promise<any>)
        : { httpStatus: result.status };
    };
    const publicExecutor = await mf.getWorker('executor');
    assert.equal((await publicExecutor.fetch('https://executor.example/mcp')).status, 403);
    const assertion = await new SignJWT({ type: 'app', email: props.identity.email })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .setIssuer(props.identity.issuer)
      .setSubject('human')
      .setAudience('fixture')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const admitted = await publicExecutor.fetch('https://executor.example/mcp', {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': assertion,
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    assert.equal(admitted.status, 200);
    assert.equal((await mf.dispatchFetch('https://workspace.example/frontdoor')).status, 401);
    const alias = await mf.dispatchFetch('https://workspace.example/alias-authorize', {
      redirect: 'manual',
    });
    assert.equal(
      alias.headers.get('location'),
      'https://workspace.example/authorize?client_id=example',
    );
    const tools = await call('tools/list');
    assert.ok(tools.result.tools.some((tool: any) => tool.name === 'execute'));
    assert.ok(tools.result.tools.some((tool: any) => tool.name === 'artifact_upload'));
    for (const tool of tools.result.tools)
      assert.equal(tool.inputSchema.properties?.accessToken, undefined);
    assert.ok(
      !((await admitted.json()) as any).result.tools.some(
        (tool: any) => tool.name === 'artifact_upload',
      ),
    );
    assert.equal((await call('tools/list', {}, { 'x-tool-collision': '1' })).error.code, -32603);
    const disabledTools = await call('tools/list', {}, { 'x-disabled-signing': '1' });
    assert.ok(!disabledTools.result.tools.some((tool: any) => tool.name === 'artifact_upload'));
    const root = await call('tools/call', { name: 'describe', arguments: {} });
    assert.ok(root.result.structuredContent.services);
    assert.equal(root.result.structuredContent.artifacts.clientUpload.enabled, true);
    assert.deepEqual(JSON.parse(root.result.content[0].text), root.result.structuredContent);
    const artifacts = await call('tools/call', {
      name: 'describe',
      arguments: { path: 'artifacts' },
    });
    assert.equal(artifacts.result.structuredContent.clientUpload.tool, 'artifact_upload');
    assert.deepEqual(
      JSON.parse(artifacts.result.content[0].text),
      artifacts.result.structuredContent,
    );
    const disabledArtifacts = await call(
      'tools/call',
      { name: 'describe', arguments: { path: 'artifacts' } },
      { 'x-disabled-signing': '1' },
    );
    assert.equal(disabledArtifacts.result.structuredContent.clientUpload.enabled, false);
    const skills = await call('resources/read', {
      uri: 'skill://google-codemode-mcp/google-workspace/SKILL.md',
    });
    assert.match(skills.result.contents[0].text, /Describe each method/);
    const code = `const {data} = await google.drive({version:'v3'}).files.get({fileId:'owned',alt:'media'});await artifacts.putJson({hello:'world'});return data;`;
    assert.equal(
      (await call('tools/call', { name: 'execute', arguments: { code, accessToken: 'override' } }))
        .error.code,
      -32602,
    );
    const result = await call('tools/call', { name: 'execute', arguments: { code } });
    const receipt = result.result.structuredContent;
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    const reference = receipt.artifacts.references.find((ref: any) => ref.uri.includes('/v2/'));
    assert.equal(reference.size, data.length);
    assert.equal(reference.sha256, sha256);
    assert.ok(!JSON.stringify(result).includes(data.subarray(0, 100).toString('base64')));
    const url = new URL(
      result.result._meta.artifactDownloads.find((ref: any) => ref.uri === reference.uri)
        .downloadUrl,
    );
    assert.equal(url.hostname, '0'.repeat(32) + '.r2.cloudflarestorage.com');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
    assert.ok(url.searchParams.has('X-Amz-Signature'));
    const resource = await call(
      'resources/read',
      { uri: reference.uri },
      { 'x-rotated-token': '1' },
    );
    assert.ok(JSON.parse(resource.result.contents[0].text).downloadUrl);
    const denied = await call('resources/read', { uri: reference.uri }, { 'x-other-user': '1' });
    assert.ok(denied.error || denied.result.isError);
    const bounded = receipt.artifacts.references.find((ref: any) => ref.uri.includes('/v1/'));
    assert.ok(
      JSON.parse(
        (await call('resources/read', { uri: bounded.uri }, { 'x-rotated-token': '1' })).result
          .contents[0].text,
      ).downloadUrl,
    );
    assert.ok((await call('resources/read', { uri: bounded.uri }, { 'x-other-user': '1' })).error);
    const write = `return (await google.drive({version:'v3'}).files.create({requestBody:{name:'one'}})).data;`;
    const lost = await call(
      'tools/call',
      { name: 'execute', arguments: { code: write } },
      {},
      '?lose',
    );
    assert.match(lost.error.message, /effects may be unknown/);
    assert.equal(writes, 1);
    const grantArgs = {
      action: 'grant',
      size: localBytes.length,
      sha256: localSha256,
      mimeType: 'application/octet-stream',
      name: 'local-upload.bin',
    };
    const uploadCall = (arguments_: Record<string, unknown>, extra = {}, query = '') =>
      call('tools/call', { name: 'artifact_upload', arguments: arguments_ }, extra, query);
    for (const arguments_ of [
      { ...grantArgs, body: 'never accept bytes' },
      { ...grantArgs, size: 67108865 },
      { ...grantArgs, sha256: 'bad-hash' },
      { ...grantArgs, mimeType: 'invalid MIME' },
      { ...grantArgs, owner: 'caller-owner' },
      { action: 'complete', uri: 'https://untrusted.example/file' },
      { action: 'complete', uri: 'artifact://google-codemode-mcp/v2/' + 'A'.repeat(43), size: 0 },
      { ...grantArgs, accessToken: 'caller-credential' },
    ])
      assert.equal((await uploadCall(arguments_)).error.code, -32602);
    assert.equal((await uploadCall(grantArgs, { 'x-no-scope': '1' })).httpStatus, 403);
    assert.equal(
      (await uploadCall(grantArgs, { origin: 'https://browser.example' })).httpStatus,
      403,
    );
    assert.equal(
      (await uploadCall(grantArgs, { 'mcp-protocol-version': '2025-03-26' })).error.code,
      -32600,
    );
    assert.ok((await uploadCall(grantArgs, { 'mcp-name': 'execute' })).error);
    const noEnvelope = await mf.dispatchFetch('https://workspace.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'artifact_upload',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'artifact_upload', arguments: grantArgs },
      }),
    });
    assert.ok(((await noEnvelope.json()) as any).error);
    assert.ok((await uploadCall(grantArgs, { 'x-disabled-signing': '1' })).result.isError);
    const mcpGrantResult = await uploadCall(grantArgs, { 'x-expired-google': '1' });
    const mcpGrant = mcpGrantResult.result.structuredContent;
    assert.deepEqual(JSON.parse(mcpGrantResult.result.content[0].text), mcpGrant);
    assert.equal(mcpGrant.headers['Content-Length'], '262144');
    assert.equal(mcpGrant.headers['If-None-Match'], '*');
    assert.deepEqual(mcpGrant.completion, {
      tool: 'artifact_upload',
      arguments: { action: 'complete', uri: mcpGrant.uri },
    });
    const completeArgs = { action: 'complete', uri: mcpGrant.uri };
    assert.ok((await uploadCall(completeArgs)).result.isError); // PUT has not happened.
    const bucket = await mf.getR2Bucket('ARTIFACTS', 'executor');
    const mcpKey = new URL(mcpGrant.uploadUrl).pathname.split('/private-artifacts/')[1];
    await bucket.put(mcpKey, localBytes);
    for (const extra of [{ 'x-other-user': '1' }, { 'x-other-google': '1' }])
      assert.ok((await uploadCall(completeArgs, extra)).result.isError);
    const lostComplete = await uploadCall(completeArgs, {}, '?lose-complete');
    assert.equal(lostComplete.result.isError, true);
    assert.equal(lostComplete.result.content[0].text, 'Artifact unavailable');
    const completed = await uploadCall(completeArgs, { 'x-expired-google': '1' });
    const imported = completed.result.structuredContent;
    assert.equal(imported.complete, true);
    assert.equal(imported.size, localBytes.length);
    assert.equal(imported.sha256, localSha256);
    assert.ok(
      completed.result.content.some(
        (item: any) => item.type === 'resource_link' && item.uri === mcpGrant.uri,
      ),
    );
    const reconciled = await uploadCall(completeArgs, { 'x-rotated-token': '1' });
    assert.deepEqual(reconciled.result.structuredContent, imported);
    const transfer = await call('tools/call', {
      name: 'execute',
      arguments: {
        inputs: { uri: imported.uri },
        code: `return (await google.drive({version:'v3'}).files.create({requestBody:{name:'local-upload.bin'},media:{mimeType:'application/octet-stream',body:{artifact:inputs.uri}}})).data;`,
      },
    });
    assert.equal(transfer.result.structuredContent.status, 'completed', JSON.stringify(transfer));
    assert.equal(writes, 2);
    assert.ok(
      !JSON.stringify([mcpGrantResult, completed, transfer]).includes(
        localBytes.subarray(0, 100).toString('base64'),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify([mcpGrantResult, completed, transfer]),
      /synthetic-google|HOST-ONLY|NEVER-IN-EXECUTOR/,
    );
    const kv = await mf.getKVNamespace('OAUTH_KV', 'gateway');
    const grantKey = 'upload:' + createHash('sha256').update(mcpGrant.uri).digest('hex');
    const storedGrant = JSON.parse((await kv.get(grantKey))!);
    await kv.put(grantKey, JSON.stringify({ ...storedGrant, expiresAt: 0 }));
    assert.ok((await uploadCall(completeArgs)).result.isError);
    assert.equal(
      JSON.parse((await call('resources/read', { uri: imported.uri })).result.contents[0].text)
        .sha256,
      localSha256,
    );
    // Client upload issues a bounded, create-only signature; finalization validates
    // stored bytes inside the executor instead of carrying them through RPC.
    const upload = await mf.dispatchFetch('https://workspace.example/mcp/artifacts/upload', {
      method: 'POST',
      body: JSON.stringify({
        size: data.length,
        sha256,
        mimeType: 'application/octet-stream',
        name: 'upload.bin',
      }),
    });
    const grant: any = await upload.json();
    const signed = new URL(grant.uploadUrl);
    assert.ok(signed.searchParams.get('X-Amz-SignedHeaders')?.includes('content-length'));
    assert.ok(signed.searchParams.get('X-Amz-SignedHeaders')?.includes('if-none-match'));
    const stagingKey = signed.pathname.split('/private-artifacts/')[1];
    await bucket.put(stagingKey, data);
    const complete = await mf.dispatchFetch('https://workspace.example/mcp/artifacts/complete', {
      method: 'POST',
      body: JSON.stringify({ uri: grant.uri }),
    });
    assert.equal(complete.status, 200);
    assert.equal(((await complete.json()) as any).sha256, sha256);
    assert.equal((await call('resources/read', { uri: grant.uri })).result.contents.length, 1);
    assert.ok((await call('resources/read', { uri: grant.uri }, { 'x-other-user': '1' })).error);
    const badUpload = await mf.dispatchFetch('https://workspace.example/mcp/artifacts/upload', {
      method: 'POST',
      body: JSON.stringify({ size: data.length, sha256, mimeType: 'application/octet-stream' }),
    });
    const badGrant: any = await badUpload.json();
    const badKey = new URL(badGrant.uploadUrl).pathname.split('/private-artifacts/')[1];
    await bucket.put(badKey, Buffer.alloc(data.length, 84));
    const refused = await mf.dispatchFetch('https://workspace.example/mcp/artifacts/complete', {
      method: 'POST',
      body: JSON.stringify({ uri: badGrant.uri }),
    });
    assert.equal(refused.status, 404);
    assert.equal(await bucket.head(badKey.replace(/\/data$/, '/manifest')), null);
  } finally {
    await mf.dispose();
  }
});
