import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';

let mf: Miniflare;
let directory: string;
let production: Miniflare;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'google-codemode-worker-'));
  const scriptPath = join(directory, 'worker.js');
  await build({
    entryPoints: ['tests/fixtures/workerd.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    mainFields: ['module', 'main'],
    alias: Object.fromEntries(
      builtinModules.filter((n) => !n.startsWith('node:')).map((n) => [n, 'node:' + n]),
    ),
    external: ['cloudflare:workers', 'node:*'],
    outfile: scriptPath,
  });
  const bundle = await readFile(scriptPath, 'utf8');
  const builtins = [
    ...new Set([...bundle.matchAll(/__require\("(node:[^"]+)"\)/g)].map((m) => m[1])),
  ];
  const shim =
    builtins.map((n, i) => `import * as builtin_${i} from ${JSON.stringify(n)};`).join('\n') +
    '\nfunction require(name){switch(name){' +
    builtins.map((n, i) => `case ${JSON.stringify(n)}: return builtin_${i};`).join('') +
    'default: throw new Error("Unknown require "+name)}}';
  await writeFile(scriptPath, shim + '\n' + bundle);
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'test',
          compatibilityDate: '2026-07-28',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'worker.js',
            modulesRoot: '/',
            modules: { 'worker.js': { type: 'esm', contents: shim + '\n' + bundle } },
          },
          env: { LOADER: { type: 'worker-loader' } },
        },
      },
    ],
  });
});
after(async () => {
  await mf?.dispose();
  await production?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function execute(code: string, query = '', extra: Record<string, unknown> = {}) {
  const response = await mf.dispatchFetch('http://localhost/' + query, {
    method: 'POST',
    body: JSON.stringify({ accessToken: 'TOKEN_CANARY_77881', code, ...extra }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  // Captured mock calls include no credential-bearing headers.
  assert.ok(!text.includes('TOKEN_CANARY_77881'), text);
  return JSON.parse(text);
}

test('real isolated Worker exposes native Discovery and preserves empty-page tokens', async () => {
  const out = await execute(
    `return (await google.gmail({version:'v1'}).users.messages.list({userId:'me',q:'hello world'})).data`,
  );
  assert.equal(out.execution.status, 'completed');
  assert.equal(out.execution.result.nextPageToken, 'empty-page-continues');
  assert.equal(out.calls.length, 1);
  assert.match(out.calls[0].url, /q=hello(?:%20|\+)world/);
});

test('ambiguous send is dispatched once, survives catch, fences queued sends, permits reads', async () => {
  const out = await execute(
    `const gmail=google.gmail({version:'v1'}); let errors=[];
    await Promise.all([1,2].map(async()=>{try{await gmail.users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}})}catch(e){errors.push({message:e.message,status:e.httpStatus})}}));
    return {errors,read:(await gmail.users.messages.list({userId:'me'})).data};`,
    '?lost',
  );
  assert.equal(out.execution.status, 'completed');
  assert.equal(out.execution.hasUnknownOutcome, true);
  assert.equal(out.calls.filter((c: { method: string }) => c.method === 'POST').length, 1);
  assert.equal(out.calls.filter((c: { method: string }) => c.method === 'GET').length, 1);
  assert.ok(
    out.execution.outcomes.some((o: { outcome: string; state?: string }) =>
      JSON.stringify(o).includes('unknown'),
    ),
  );
});

test('sandbox network and transport overrides fail before credentials can escape', async () => {
  const out = await execute(`let errors=[];
    try{await fetch('https://example.com')}catch(e){errors.push(e.message)}
    for(const params of [{userId:'me',rootUrl:'https://example.com/'},{userId:'me',auth:'other'}, {userId:'me',headers:{Authorization:'other'}}]){
      try{await google.gmail({version:'v1'}).users.messages.list(params)}catch(e){errors.push(e.message)}
    }return {errors,environment:typeof process,token:typeof accessToken};`);
  assert.equal(out.calls.length, 0);
  assert.equal(out.execution.result.errors.length, 4);
  assert.equal(out.execution.result.token, 'undefined');
});

test('snippet code and exposed invocation share data and read-only restrictions', async () => {
  const inline = await execute(`return await snippets.run('gmailInbox',{maxResults:2})`);
  const tool = await execute('ignored', '', {
    snippetName: 'gmailInbox',
    code: `return (await google.gmail({version:'v1'}).users.messages.list({userId:'me',labelIds:['INBOX'],maxResults:2})).data`,
    inputs: { maxResults: 2 },
  });
  assert.equal(inline.execution.status, 'completed', JSON.stringify(inline));
  assert.equal(tool.execution.status, 'completed', JSON.stringify(tool));
  assert.deepEqual(inline.execution.result, tool.execution.result);
  assert.equal(inline.calls[0].url, tool.calls[0].url);
});

test('structured errors survive Worker RPC and bodyless delete has native envelope', async () => {
  const rejected = await execute(
    `try{await google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}})}catch(e){return {status:e.httpStatus,message:e.message}}`,
    '?reject',
  );
  assert.equal(rejected.execution.result.status, 403);
  assert.equal(rejected.execution.hasUnknownOutcome, false);
  const removed = await execute(
    `return await google.gmail({version:'v1'}).users.messages.delete({userId:'me',id:'abc'})`,
  );
  assert.equal(removed.execution.status, 'completed');
  assert.equal(removed.execution.result.status, 204);
});

test('unawaited mutation is accounted for when execution closes', async () => {
  const out = await execute(
    `google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}}); await new Promise(r=>setTimeout(r,20));return 'finished'`,
    '?slow',
  );
  assert.equal(out.calls.length, 1);
  assert.equal(out.execution.hasUnknownOutcome, true);
});

test('modern MCP client reaches real Worker sandbox and exposed deployment snippet', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client(
    { name: 'worker-acceptance', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => {
      const request = new Request(input, init as RequestInit);
      const response = await mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      assert.equal(response.headers.get('mcp-session-id'), null);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      return response as unknown as Response;
    },
  });
  try {
    await client.connect(transport);
    const described = await client.callTool({
      name: 'describe',
      arguments: { path: 'gmail/v1/users.messages.list' },
    });
    assert.equal(
      (described.structuredContent as Record<string, unknown>)?.revision,
      'test-revision',
    );
    const executed = await client.callTool({
      name: 'execute',
      arguments: {
        accessToken: 'TOKEN_CANARY_77881',
        code: `return await snippets.run('gmailInbox',inputs)`,
        inputs: { maxResults: 2 },
      },
    });
    assert.equal(
      (executed.structuredContent as Record<string, unknown>)?.status,
      'completed',
      JSON.stringify(executed),
    );
    const snippet = await client.callTool({
      name: 'gmail_inbox',
      arguments: { accessToken: 'TOKEN_CANARY_77881', inputs: { maxResults: 2 } },
    });
    assert.equal(
      (snippet.structuredContent as Record<string, unknown>)?.status,
      'completed',
      JSON.stringify(snippet),
    );
    assert.deepEqual(
      (executed.structuredContent as Record<string, unknown>)?.result,
      (snippet.structuredContent as Record<string, unknown>)?.result,
    );
  } finally {
    await client.close();
  }
});

test('non-JSON and oversized program results preserve acknowledged mutations', async () => {
  for (const result of [
    `const cyclic={};cyclic.self=cyclic;return cyclic;`,
    `return 12n;`,
    `return 'x'.repeat(300000);`,
  ]) {
    const out = await execute(
      `await google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}});${result}`,
    );
    assert.equal(out.calls.length, 1);
    assert.ok(
      out.execution.outcomes.some((o: { outcome: string }) => o.outcome === 'acknowledged'),
      JSON.stringify(out),
    );
    assert.equal(out.execution.status, 'error');
  }
});

test('async execution timeout fences later dispatch and records active mutation uncertainty', async () => {
  const out = await execute(
    `try {await google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}})} finally {await google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}})}`,
    '?slow&timeout',
  );
  assert.equal(out.execution.status, 'error');
  assert.equal(out.execution.hasUnknownOutcome, true);
  assert.equal(out.calls.length, 1);
});

test('overflow fallback also redacts a caller-supplied credential echo in correlation', async () => {
  const out = await execute(`return 'x'.repeat(300000)`, '', { requestId: 'TOKEN_CANARY_77881' });
  assert.equal(out.execution.requestId, '[REDACTED]');
  assert.equal(out.execution.status, 'error');
});

test('actual Wrangler build boots and executes through the production MCP route', async () => {
  const bundle = await readFile('dist/worker.js', 'utf8');
  const outbound: string[] = [];
  const parameters = { userId: { type: 'string', required: true, location: 'path' } };
  const discovery = {
    name: 'gmail',
    version: 'v1',
    rootUrl: 'https://gmail.googleapis.com/',
    servicePath: '',
    resources: {
      users: {
        resources: {
          messages: {
            methods: {
              list: { path: 'gmail/v1/users/{userId}/messages', httpMethod: 'GET', parameters },
              send: {
                path: 'gmail/v1/users/{userId}/messages/send',
                httpMethod: 'POST',
                parameters,
              },
            },
          },
        },
      },
    },
  };
  production = new Miniflare({
    workers: [
      {
        config: {
          name: 'production-test',
          compatibilityDate: '2026-07-28',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'worker.js',
            modulesRoot: '/',
            modules: { 'worker.js': { type: 'esm', contents: bundle } },
          },
          env: { LOADER: { type: 'worker-loader' } },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              outbound.push(request.url);
              assert.equal(new URL(request.url).hostname, 'gmail.googleapis.com');
              if (new URL(request.url).pathname === '/$discovery/rest')
                return MiniflareResponse.json(discovery);
              assert.equal(request.headers.get('authorization'), 'Bearer TOKEN_CANARY_77881');
              return request.method === 'POST'
                ? new MiniflareResponse(null, {
                    status: 307,
                    headers: { location: 'https://example.invalid/credential-trap' },
                  })
                : MiniflareResponse.json({ messages: [] });
            },
          },
        },
      },
    ],
  });
  const call = (code: string) =>
    production.dispatchFetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'MCP-Method': 'tools/call',
        'MCP-Name': 'execute',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'execute',
          arguments: {
            accessToken: 'TOKEN_CANARY_77881',
            code,
            inputs: { number: 41 },
          },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
  const response = await call('return inputs.number + 1');
  assert.equal(response.status, 200, await response.clone().text());
  const out = (await response.json()) as any;
  assert.equal(out.result.structuredContent.result, 42, JSON.stringify(out));
  assert.equal(out.result.structuredContent.status, 'completed');
  // Native workerd fetch must accept the redirect policy at both production seams.
  // A redirected mutation stays unknown, fences another send, and permits a read.
  const native = await call(`
    const gmail=google.gmail({version:'v1'});
    for(let i=0;i<2;i++) {try {await gmail.users.messages.send({userId:'me'});} catch {}}
    return (await gmail.users.messages.list({userId:'me'})).data;
  `);
  const receipt = (await native.json()) as any;
  const result = receipt.result.structuredContent;
  assert.equal(result.status, 'completed', JSON.stringify(receipt));
  assert.deepEqual(result.result, { messages: [] });
  assert.equal(result.hasUnknownOutcome, true);
  assert.deepEqual(
    result.outcomes.map((o: { outcome: string }) => o.outcome),
    ['unknown', 'not_dispatched', 'acknowledged'],
  );
  assert.equal(result.outcomes[0].httpStatus, 307);
  assert.equal(outbound.length, 3);
  assert.equal(outbound.filter((u) => u.endsWith('/send')).length, 1);
});
