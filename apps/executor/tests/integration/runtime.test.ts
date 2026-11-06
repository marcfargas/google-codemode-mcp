import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Miniflare } from 'miniflare';
import { bundleFixture, createBuiltWorker } from '../support/worker-client.ts';

let mf: Miniflare;
let production: Miniflare;
before(async () => {
  mf = await createBuiltWorker({
    bundle: await bundleFixture('apps/executor/tests/fixtures/workerd.ts'),
  });
});
after(async () => {
  await mf?.dispose();
  await production?.dispose();
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

test('isolated Drive ledger records native pages independently from forged program output', async () => {
  const out = await execute(
    `await google.drive({version:'v3'}).files.list({q:'name contains \\'fixture\\'',pageSize:1,fields:'files(id,name),nextPageToken,incompleteSearch'});return {outcomes:[{pagination:{returnedIds:['forged'],nextPageToken:'forged'}}]};`,
  );
  assert.equal(out.execution.status, 'completed');
  assert.deepEqual(out.execution.outcomes[0].pagination, {
    query: "name contains 'fixture'",
    pageSize: 1,
    fields: 'files(id,name),nextPageToken,incompleteSearch',
    returnedIds: ['native-owned'],
    nextPageToken: 'native+/=',
    incompleteSearch: false,
  });
  assert.deepEqual(out.execution.result.outcomes[0].pagination.returnedIds, ['forged']);
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

test('isolated Drive proxy refuses every second argument before creating an outcome', async () => {
  const out = await execute(`const files=google.drive({version:'v3'}).files;const errors=[];
    for(const method of ['get','update']){
      for(const options of [{headers:{'If-Match':'stale-etag'}},undefined,()=>{}]){
        try{await files[method]({fileId:'fixture',...(method==='update'?{requestBody:{name:'must-not-rename'}}:{})},options)}
        catch(e){errors.push(e.message)}
      }
    }return errors;`);
  assert.equal(out.execution.status, 'completed');
  assert.deepEqual(out.calls, []);
  assert.deepEqual(out.execution.outcomes, []);
  assert.deepEqual(
    out.execution.result,
    Array(6).fill('Only native parameters are supported; transport options are forbidden'),
  );
});

test('isolated Drive dispatcher records forbidden first-argument fields as not dispatched', async () => {
  const out = await execute(`const errors=[];
    for(const [key,value] of Object.entries({
      headers:{'If-Match':'stale-etag'},headers_:{'If-Match':'stale-etag'},
      options:{headers:{'If-Match':'stale-etag'}},ifMatch:'stale-etag'
    })){
      try{await google.drive({version:'v3'}).files.update({fileId:'fixture',requestBody:{name:'must-not-rename'},[key]:value})}
      catch(e){errors.push({code:e.code,outcome:e.outcome})}
    }return errors;`);
  assert.equal(out.execution.status, 'completed');
  assert.deepEqual(out.calls, []);
  assert.deepEqual(
    out.execution.result,
    Array(4).fill({ code: 'INVALID_PARAMS', outcome: 'not_dispatched' }),
  );
  assert.deepEqual(
    out.execution.outcomes.map((entry: { path: string; mutation: boolean; outcome: string }) => ({
      path: entry.path,
      mutation: entry.mutation,
      outcome: entry.outcome,
    })),
    Array(4).fill({ path: 'drive/v3/files.update', mutation: true, outcome: 'not_dispatched' }),
  );
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
  production = await createBuiltWorker({
    outbound: async (request) => {
      outbound.push(request.url);
      assert.equal(new URL(request.url).hostname, 'gmail.googleapis.com');
      if (new URL(request.url).pathname === '/$discovery/rest') return Response.json(discovery);
      assert.equal(request.headers.get('authorization'), 'Bearer TOKEN_CANARY_77881');
      return request.method === 'POST'
        ? new Response(null, {
            status: 307,
            headers: { location: 'https://example.invalid/credential-trap' },
          })
        : Response.json({ messages: [] });
    },
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

const pageQuery = (pages: unknown[]) => '?pages=' + encodeURIComponent(JSON.stringify(pages));
const collect = (params: unknown, limits: unknown, drive = false) =>
  `return pagination.collect(google.${drive ? "drive({version:'v3'}).files" : "gmail({version:'v1'}).users.messages"}.list,${JSON.stringify(params)},${JSON.stringify(limits)});`;

test('pagination follows opaque tokens across empty pages and retains native pages and receipts', async () => {
  const pages = [
    { messages: [{ id: 'a' }], nextPageToken: 'opaque+/= 東京' },
    { nextPageToken: 'last' },
    { messages: [{ id: 'b' }] },
  ];
  const out = await execute(
    collect(
      { userId: 'me', q: 'unchanged', maxResults: 1, labelIds: ['one'] },
      { maxPages: 5, maxBytes: 5000 },
    ),
    pageQuery(pages),
  );
  assert.equal(out.execution.status, 'completed');
  assert.deepEqual(out.execution.result, {
    pages,
    exhausted: true,
    stoppedBy: 'end',
    resumePageToken: null,
    incompleteSearch: null,
  });
  assert.equal(out.execution.outcomes.length, 3);
  assert.deepEqual(
    out.calls.map((call: any) => new URL(call.url).searchParams.get('pageToken')),
    [null, 'opaque+/= 東京', 'last'],
  );
  for (const call of out.calls) {
    assert.equal(new URL(call.url).searchParams.get('q'), 'unchanged');
    assert.equal(new URL(call.url).searchParams.get('labelIds'), 'one');
  }
});

test('pagination page and UTF-8 byte bounds preserve exact resume positions without truncating pages', async () => {
  const first = { messages: [{ id: 'é🌍' }], nextPageToken: 'second' };
  const second = { messages: [{ id: 'large'.repeat(100) }] };
  const limited = await execute(
    collect({ userId: 'me', pageToken: 'initial' }, { maxPages: 1, maxBytes: 5000 }),
    pageQuery([first, second]),
  );
  assert.equal(limited.calls.length, 1);
  assert.equal(new URL(limited.calls[0].url).searchParams.get('pageToken'), 'initial');
  assert.equal(limited.execution.result.stoppedBy, 'maxPages');
  assert.equal(limited.execution.result.resumePageToken, 'second');
  const cap = Buffer.byteLength(
    JSON.stringify({
      pages: [first],
      exhausted: false,
      stoppedBy: 'maxPages',
      resumePageToken: 'second',
      incompleteSearch: false,
    }),
  );
  for (const [maxBytes, accepted, resume, calls] of [
    [cap, [first], 'second', 2],
    [cap - 1, [], null, 1],
  ] as const) {
    const out = await execute(
      collect({ userId: 'me' }, { maxPages: 5, maxBytes }),
      pageQuery([first, second]),
    );
    assert.equal(out.execution.status, 'completed');
    assert.deepEqual(out.execution.result.pages, accepted);
    assert.equal(out.execution.result.stoppedBy, 'maxBytes');
    assert.equal(out.execution.result.resumePageToken, resume);
    assert.equal(out.calls.length, calls);
    assert.ok(Buffer.byteLength(JSON.stringify(out.execution.result)) <= maxBytes);
  }
});

test('pagination rejects unsupported methods, unsafe params, masks and limits before dispatch', async () => {
  for (const expression of [
    "pagination.collect(google.gmail({version:'v1'}).users.messages.send,{userId:'me'},{maxPages:2,maxBytes:5000})",
    'pagination.collect(()=>{}, {}, {maxPages:2,maxBytes:5000})',
    "pagination.collect(google.gmail({version:'v1'}).users.messages.list,{get userId(){throw Error('getter ran')}},{maxPages:2,maxBytes:5000})",
    ...[
      [{ fields: 'files(id,nextPageToken,incompleteSearch)' }, { maxPages: 2, maxBytes: 5000 }],
      [{ fields: 'files(id)),nextPageToken,incompleteSearch' }, { maxPages: 2, maxBytes: 5000 }],
      [{ fields: 'files(id),nextPageToken' }, { maxPages: 2, maxBytes: 5000 }],
      [{ pageToken: '' }, { maxPages: 2, maxBytes: 5000 }],
      [{}, { maxPages: 51, maxBytes: 5000 }],
      [{}, { maxPages: 2, maxBytes: 1 }],
      [1, { maxPages: 2, maxBytes: 5000 }],
    ].map(([params, limits]) =>
      collect(params, limits, true)
        .replace(/^return /, '')
        .replace(/;$/, ''),
    ),
  ]) {
    const out = await execute(
      `try{await ${expression};return 'unexpected'}catch(e){return e.message}`,
    );
    assert.equal(out.calls.length, 0, expression);
    assert.equal(out.execution.outcomes.length, 0);
    assert.notEqual(out.execution.result, 'unexpected');
    assert.notEqual(out.execution.result, 'getter ran');
  }
});

test('pagination native errors, malformed metadata and cycles retain bounded partial pages', async () => {
  const first = { messages: [], nextPageToken: 'second' };
  for (const [bad, stoppedBy, code] of [
    [{ fixtureError: true }, 'error', undefined],
    [{ nextPageToken: 'second' }, 'cycle', 'PAGINATION_CYCLE'],
    [{ nextPageToken: '' }, 'invalid', 'PAGINATION_INVALID'],
    [{ nextPageToken: 4 }, 'invalid', 'PAGINATION_INVALID'],
    [{ nextPageToken: null }, 'invalid', 'PAGINATION_INVALID'],
    [[], 'invalid', 'PAGINATION_INVALID'],
  ] as const) {
    const out = await execute(
      `try{${collect({ userId: 'me' }, { maxPages: 5, maxBytes: 5000 }).replace('return ', 'return await ')}}catch(e){return {code:e.code,status:e.httpStatus,partial:e.partial}}`,
      pageQuery([first, bad]),
    );
    assert.equal(out.calls.length, 2);
    assert.deepEqual(out.execution.result.partial, {
      pages: [first],
      exhausted: false,
      stoppedBy,
      resumePageToken: 'second',
      incompleteSearch: null,
    });
    if (code) assert.equal(out.execution.result.code, code);
    else assert.equal(out.execution.result.status, 403);
  }
});

test('Drive exhaustion preserves sticky incompleteSearch and permits balanced native field masks', async () => {
  for (const [values, expected] of [
    [[false, false], false],
    [[false, undefined], null],
    [[undefined, false], null],
    [[true, false], true],
    [[false, true], true],
  ] as const) {
    const pages = values.map((value, i) => ({
      files: [],
      ...(value === undefined ? {} : { incompleteSearch: value }),
      ...(i === 0 ? { nextPageToken: 'next' } : {}),
    }));
    const out = await execute(
      collect(
        { fields: 'files(id,name),nextPageToken,incompleteSearch' },
        { maxPages: 3, maxBytes: 5000 },
        true,
      ),
      pageQuery(pages),
    );
    assert.equal(out.execution.status, 'completed');
    assert.equal(out.execution.result.exhausted, true);
    assert.equal(out.execution.result.incompleteSearch, expected);
  }
});
