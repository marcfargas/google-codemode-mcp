import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL as NodeURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { handleMcp, MCP_VERSION, WORKSPACE_SKILL, type ProtocolApp } from '../../src/protocol.ts';

function fixture() {
  const calls: { kind: string; args: unknown; name?: string }[] = [];
  const app: ProtocolApp = {
    snippets: [
      {
        name: 'search',
        description: 'Search Gmail messages.',
        code: 'return inputs;',
        services: ['gmail/v1'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        tool: { name: 'gmail_search' },
      },
      {
        name: 'internal',
        description: 'Available only in Code Mode.',
        code: 'return {};',
        services: ['gmail/v1'],
        scopes: [],
        inputSchema: { type: 'object' },
      },
    ],
    async describe(args) {
      calls.push({ kind: 'describe', args });
      return { path: args.path ?? '', services: ['gmail/v1'] };
    },
    async execute(args) {
      calls.push({ kind: 'execute', args });
      return { value: args.inputs ?? null, mutationOutcomes: [] };
    },
    async runSnippet(name, args) {
      calls.push({ kind: 'snippet', name, args });
      return { value: args.inputs ?? null, mutationOutcomes: [] };
    },
  };
  return { app, calls };
}

const metadata = {
  'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

function rpcRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: { headers?: Record<string, string>; meta?: unknown; version?: string } = {},
) {
  const name = params.name ?? params.uri;
  return new Request('https://workspace.example/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': options.version ?? MCP_VERSION,
      'MCP-Method': method,
      ...(typeof name === 'string' ? { 'MCP-Name': name } : {}),
      ...options.headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: options.meta === undefined ? metadata : options.meta },
    }),
  });
}

test('official pinned client discovers, calls tools, and verifies the bundled skill through independent POSTs', async () => {
  const { app, calls } = fixture();
  const requests: { method: string; rpc: any; headers: Headers }[] = [];
  const responses: { status: number; headers: Headers; rpc: any }[] = [];
  const transport = new StreamableHTTPClientTransport(new URL('https://workspace.example/mcp'), {
    fetch: async (input, init) => {
      const request = new Request(input, init as RequestInit);
      requests.push({
        method: request.method,
        rpc: await request.clone().json(),
        headers: request.headers,
      });
      const response = await handleMcp(request, app);
      responses.push({
        status: response.status,
        headers: response.headers,
        rpc: await response.clone().json(),
      });
      return response;
    },
  });
  const client = new Client(
    { name: 'protocol-test', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: { pin: MCP_VERSION } } },
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['describe', 'execute', 'gmail_search'],
    );
    const described = await client.callTool({
      name: 'describe',
      arguments: { path: 'gmail/v1/users.messages.list' },
    });
    assert.deepEqual(described.structuredContent, {
      path: 'gmail/v1/users.messages.list',
      services: ['gmail/v1'],
    });
    const executed = await client.callTool({
      name: 'execute',
      arguments: {
        accessToken: 'test-secret',
        code: 'return inputs;',
        inputs: { query: 'is:unread' },
        requestId: 'execution-1',
      },
    });
    assert.deepEqual(executed.structuredContent, {
      value: { query: 'is:unread' },
      mutationOutcomes: [],
    });
    assert.ok(!JSON.stringify(executed).includes('test-secret'));
    await client.callTool({
      name: 'gmail_search',
      arguments: { accessToken: 'test-secret', inputs: { query: 'in:inbox' } },
    });
    assert.deepEqual(calls, [
      { kind: 'describe', args: { path: 'gmail/v1/users.messages.list' } },
      {
        kind: 'execute',
        args: {
          accessToken: 'test-secret',
          code: 'return inputs;',
          inputs: { query: 'is:unread' },
          requestId: 'execution-1',
        },
      },
      {
        kind: 'snippet',
        name: 'search',
        args: { accessToken: 'test-secret', inputs: { query: 'in:inbox' } },
      },
    ]);

    const skills = new SkillsClient(client);
    assert.equal(skills.supported, true);
    const listing = await skills.list();
    assert.equal(listing.skills.length, 1);
    const { skill } = await skills.get(listing.skills[0].uri);
    const file = await skills.read(skill);
    assert.equal(file.verified, true);
    assert.equal(file.text, WORKSPACE_SKILL);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === skill.uri));

    assert.equal(requests[0].rpc.method, 'server/discover');
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.notEqual(request.rpc.method, 'initialize');
      assert.equal(request.headers.get('MCP-Protocol-Version'), MCP_VERSION);
      assert.equal(request.headers.get('MCP-Method'), request.rpc.method);
      const name = request.rpc.params.name ?? request.rpc.params.uri;
      if (['tools/call', 'resources/read'].includes(request.rpc.method)) {
        assert.equal(request.headers.get('MCP-Name'), name);
      }
      assert.equal(request.headers.get('Mcp-Session-Id'), null);
      assert.equal(
        request.rpc.params._meta['io.modelcontextprotocol/protocolVersion'],
        MCP_VERSION,
      );
      assert.deepEqual(request.rpc.params._meta['io.modelcontextprotocol/clientCapabilities'], {});
    }
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
      assert.equal(response.headers.get('Mcp-Session-Id'), null);
    }
    for (let index = 0; index < requests.length; index++) {
      if (requests[index].rpc.method === 'tools/call') {
        assert.equal(responses[index].rpc.result.resultType, 'complete');
      }
      if (requests[index].rpc.method === 'tools/list') {
        assert.equal(responses[index].rpc.result.ttlMs, 0);
        assert.equal(responses[index].rpc.result.cacheScope, 'private');
      }
    }
  } finally {
    await client.close();
  }
});

test('deployed skill content stays identical to the distributable file', async () => {
  assert.equal(
    await readFile(new NodeURL('../../skills/google-workspace/SKILL.md', import.meta.url), 'utf8'),
    WORKSPACE_SKILL,
  );
});

test('non-POST, initialization, old versions, malformed metadata and routing headers are rejected', async () => {
  const { app, calls } = fixture();
  for (const method of ['GET', 'DELETE', 'OPTIONS']) {
    const response = await handleMcp(new Request('https://workspace.example/mcp', { method }), app);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  }
  const missingName = rpcRequest('tools/call', { name: 'describe', arguments: {} });
  missingName.headers.delete('MCP-Name');
  const invalid = [
    { request: missingName, code: -32020 },
    {
      request: new Request('https://workspace.example/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'old', version: '1' },
          },
        }),
      }),
      code: -32022,
    },
    { request: rpcRequest('tools/list', {}, { meta: {} }), code: -32602 },
    {
      request: rpcRequest('tools/list', {}, { headers: { 'MCP-Method': 'tools/call' } }),
      code: -32020,
    },
    {
      request: rpcRequest(
        'tools/list',
        {},
        {
          version: '2099-01-01',
          meta: { ...metadata, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
        },
      ),
      code: -32022,
    },
  ];
  for (const { request, code } of invalid) {
    const response = await handleMcp(request, app);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
    assert.equal(((await response.json()) as any).error.code, code);
  }
  assert.deepEqual(calls, []);

  const modernInitialize = await handleMcp(
    rpcRequest('initialize', {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: 'modern-init', version: '1' },
    }),
    app,
  );
  assert.match(modernInitialize.headers.get('Content-Type') ?? '', /application\/json/);
  assert.ok(((await modernInitialize.json()) as any).error);
});

test('invalid arguments never reach the app and subscriptions cannot open a stream', async () => {
  const { app, calls } = fixture();
  for (const [name, args] of [
    ['execute', { code: 'return 1;' }],
    ['execute', { accessToken: 'test-secret', code: '' }],
    ['gmail_search', { accessToken: 'test-secret', inputs: { query: 1 } }],
  ] as const) {
    const response = await handleMcp(rpcRequest('tools/call', { name, arguments: args }), app);
    const body = (await response.json()) as any;
    assert.equal(body.result.isError, true);
    assert.ok(!JSON.stringify(body).includes('test-secret'));
  }
  assert.deepEqual(calls, []);
  const response = await handleMcp(
    rpcRequest('subscriptions/listen', { notifications: { resources: { listChanged: true } } }),
    app,
  );
  assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
  assert.equal(((await response.json()) as any).error.code, -32603);
});
