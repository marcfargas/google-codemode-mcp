import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscoveryCatalog } from '../../src/discovery.ts';
import type { DiscoveryDocument } from '../../src/discovery.ts';
import { createDispatcher } from '../../src/dispatcher.ts';

const token = 'synthetic-token-never-return';
function fixture(): DiscoveryDocument {
  return {
    name: 'gmail',
    version: 'v1',
    revision: 'fixture-1',
    rootUrl: 'https://gmail.googleapis.com/',
    servicePath: '',
    parameters: { fields: { type: 'string' } },
    schemas: {
      Message: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          labels: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
      },
    },
    resources: {
      users: {
        resources: {
          messages: {
            methods: {
              list: {
                path: 'gmail/v1/users/{userId}/messages',
                httpMethod: 'GET',
                parameters: {
                  userId: { type: 'string', required: true, location: 'path' },
                  maxResults: { type: 'integer', minimum: '1', maximum: '500' },
                  labelIds: { type: 'string', repeated: true },
                },
                parameterOrder: ['userId'],
                response: { $ref: 'Message' },
                scopes: ['gmail.readonly', 'gmail.modify'],
              },
              send: {
                path: 'gmail/v1/users/{userId}/messages/send',
                httpMethod: 'POST',
                parameters: { userId: { type: 'string', required: true, location: 'path' } },
                parameterOrder: ['userId'],
                request: { $ref: 'Message' },
                response: { $ref: 'Message' },
              },
              remove: {
                path: 'gmail/v1/users/{userId}/messages/{id}',
                httpMethod: 'DELETE',
                parameters: {
                  userId: { type: 'string', required: true, location: 'path' },
                  id: { type: 'string', required: true, location: 'path' },
                },
                parameterOrder: ['userId', 'id'],
              },
            },
          },
        },
      },
    },
  };
}
const list = 'gmail/v1/users.messages.list';
const send = 'gmail/v1/users.messages.send';
const remove = 'gmail/v1/users.messages.remove';
const catalog = () => new DiscoveryCatalog({ document: fixture() });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', etag: 'fixture-etag' },
  });

test('Discovery is lazy, progressive, and resolves methods absent from a handwritten catalog', async () => {
  let fetched = 0;
  const document = fixture();
  document.resources!.users.resources!.messages.methods!.newlyDiscovered = {
    path: 'gmail/v1/dynamic',
    httpMethod: 'POST',
    parameters: {},
  };
  const dynamic = new DiscoveryCatalog({
    fetch: async () => {
      fetched++;
      return json(document);
    },
  });
  const root = await dynamic.describe();
  assert.deepEqual(root, {
    services: [
      { name: 'gmail', versions: ['v1'], paths: ['gmail/v1'] },
      { name: 'drive', versions: ['v3'], paths: ['drive/v3'] },
    ],
    next: 'Read the skill URI through MCP Resources, then follow service and resource paths with describe to each needed method for its signature and schemas before execute.',
    skill: 'skill://google-codemode-mcp/google-workspace/SKILL.md',
    conventions: 'skill://google-codemode-mcp/google-workspace/references/conventions.md',
  });
  assert.deepEqual((await dynamic.describe('gmail')).paths, ['gmail/v1']);
  assert.equal(fetched, 0);
  const versionPath = (root.services as { paths: string[] }[])[0].paths[0];
  const version = await dynamic.describe(versionPath);
  const resource = await dynamic.describe((version.resources as string[])[0]);
  const nested = await dynamic.describe((resource.resources as string[])[0]);
  const method = await dynamic.describe((nested.methods as { path: string }[])[0].path);
  assert.match(method.signature as string, /Promise/);
  assert.equal(method.view, 'brief');
  assert.deepEqual(JSON.parse(JSON.stringify(method.response)), { schemaPath: 'gmail/v1#Message' });
  for (const invalid of ['gmail.users.messages.get', 'sheets/v4', 'gmail/v1/nonexistent'])
    await assert.rejects(dynamic.describe(invalid), /follow its returned paths/);
  assert.deepEqual((await dynamic.describe('gmail/v1')).resources, ['gmail/v1/users']);
  assert.deepEqual((await dynamic.describe('gmail/v1/users')).resources, [
    'gmail/v1/users.messages',
  ]);
  assert.equal((await dynamic.resolve('gmail/v1/users.messages.newlyDiscovered')).mutation, true);
  assert.equal((await dynamic.describe(list)).authorization, 'unknown');
  assert.equal((await dynamic.describe(list)).scopesSemantics, 'alternatives');
  assert.equal(fetched, 1);
  await assert.rejects(dynamic.resolve('gmail/v1/constructor'));
});

test('untrusted Discovery origins and schemas with invalid params never dispatch', async () => {
  const document = fixture();
  document.rootUrl = 'https://example.com/';
  await assert.rejects(new DiscoveryCatalog({ document }).document(), /Untrusted/);
  let requests = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'validation',
    transport: async () => {
      requests++;
      return json({});
    },
  });
  for (const params of [
    {},
    { userId: 'me', maxResults: 0 },
    { userId: 'me', maxResults: '10' },
    { userId: 'me', auth: 'evil' },
    { userId: 'me', auth_: 'evil' },
    { userId: 'me', headers_: { Authorization: 'evil' } },
    { userId: 'me', rootUrl: 'https://example.com/' },
    { userId: 'me', callback: 'evil' },
    { userId: 'me', media: { body: 'evil' } },
    { userId: 'me', alt: 'media' },
    { userId: 'me', responseType: 'stream' },
    { userId: 'me', resource: {} },
    { userId: 'me', access_token: 'evil' },
  ]) {
    const result = await dispatcher.call(list, params);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.outcome, 'not_dispatched');
  }
  assert.equal(requests, 0);
});

test('described parameters and declarations expose exactly the supported top-level contract', async () => {
  const document = fixture();
  const excluded = [
    'key',
    'access_token',
    'AUTH',
    'Headers',
    'media',
    'alt',
    'uploadType',
    'fields_',
  ];
  for (const name of excluded) document.parameters![name] = { type: 'string' };
  const original = structuredClone(document);
  const dynamic = new DiscoveryCatalog({ document });
  const described = await dynamic.describe(list, { view: 'full' });
  const parameters = described.parameters as Record<string, unknown>;
  assert.equal(described.supported, true);
  assert.deepEqual(Object.keys(parameters).sort(), ['fields', 'labelIds', 'maxResults', 'userId']);
  assert.deepEqual(described.parameterOrder, ['userId']);
  assert.deepEqual(
    described.excludedParameters,
    excluded.map((name) => ({
      name,
      reason: name === 'fields_' ? 'sdk_alias' : 'credentials_or_transport',
      required: false,
    })),
  );
  for (const name of excluded) {
    assert.doesNotMatch(described.declarations as string, new RegExp(`"${name}"`));
  }
  assert.match(described.declarations as string, /"fields"\?: string/);
  assert.equal(described.revision, 'fixture-1');
  assert.deepEqual(
    described.scopes,
    original.resources!.users.resources!.messages.methods!.list.scopes,
  );

  const requested: string[] = [];
  const dispatcher = createDispatcher({
    catalog: dynamic,
    accessToken: token,
    requestId: 'projection',
    transport: async (url) => {
      requested.push(String(url));
      return json({ messages: [] });
    },
  });
  assert.equal((await dispatcher.call(list, { userId: 'me', fields: 'messages(id)' })).ok, true);
  assert.match(requested[0], /fields=messages/);
  for (const name of [...excluded, 'auth__', 'HEADERS_', 'maxResults_']) {
    const result = await dispatcher.call(list, { userId: 'me', [name]: 'blocked' });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.error.outcome, 'not_dispatched', name);
  }
  assert.equal(requested.length, 1);
  assert.deepEqual(document, original, 'Caller projection must not mutate the native document');
});

test('oversized method descriptions keep complete execution guidance within the first 1800 UTF-8 bytes', async () => {
  const document = fixture();
  const largeDescription = '詳細 🌍 native documentation '.repeat(2_000);
  document.parameters!.fields.description = largeDescription;
  const native = document.resources!.users.resources!.messages.methods!.send;
  native.description = largeDescription;
  // Native extension names must retain the existing computed-field precedence.
  native.signature = 'native signature is superseded';
  native.next = 'native next is superseded';
  native.runtime = { native: 'superseded' };
  document.schemas!.Message.properties!.largeNested = {
    type: 'object',
    properties: { child: { type: 'string', description: largeDescription } },
  };
  const original = structuredClone(document);
  const dynamic = new DiscoveryCatalog({ document });
  const described = await dynamic.describe(send, { view: 'full' });
  const brief = JSON.parse(JSON.stringify(await dynamic.describe(send)));
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 2_500);
  assert.match(brief.summary, /…$/);
  assert.equal(brief.signature, described.signature);
  assert.deepEqual(brief.runtime, described.runtime);
  assert.deepEqual(brief.requestBody, { schemaPath: 'gmail/v1#Message' });
  assert.deepEqual(brief.response, brief.requestBody);
  assert.deepEqual(await dynamic.describe(brief.full.path, { view: brief.full.view }), described);
  const inventory = await dynamic.describe(brief.requestBody.schemaPath);
  assert.ok(Buffer.byteLength(JSON.stringify(inventory)) < 1_000);
  const child = await dynamic.describe('gmail/v1#Message/properties/largeNested/properties/child');
  assert.deepEqual(child.schema, { type: 'string', description: largeDescription });
  const resolved = await dynamic.resolve(send);
  const computed = [
    'revision',
    'source',
    'declarations',
    'skill',
    'documentation',
    'signature',
    'next',
    'unsupportedReason',
    'authorization',
    'scopesSemantics',
    'runtime',
    'mediaResponseSchema',
    'requestSchema',
    'responseSchema',
  ];
  for (const key of Object.keys(resolved))
    if (!computed.includes(key)) assert.deepEqual(described[key], resolved[key], key);
  assert.equal(described.description, largeDescription);
  assert.equal(
    described.signature,
    'users.messages.send(params): Promise<{ data, status, headers }>',
  );
  assert.deepEqual(described.runtime, {
    json: true,
    maxParameterBytes: 2097152,
    mediaUpload: false,
    mediaDownload: false,
  });
  assert.match(described.next as string, /describe every distinct Google method/);
  for (const indentation of [undefined, 2]) {
    const text = JSON.stringify(described, null, indentation);
    assert.ok(Buffer.byteLength(text) > 100_000, 'exercise host persistence-size output');
    const prefix = Buffer.from(text).subarray(0, 1800).toString('utf8');
    for (const key of [
      'path',
      'signature',
      'next',
      'supported',
      'mutation',
      'httpMethod',
      'runtime',
      'documentation',
      'skill',
    ]) {
      const field = JSON.stringify({ [key]: described[key] }, null, indentation)
        .slice(1, -1)
        .trim();
      assert.ok(
        prefix.includes(field),
        `${key} must be wholly visible in a truncated ${indentation ? 'pretty' : 'compact'} preview`,
      );
    }
  }
  assert.deepEqual(described.requestSchema, described.responseSchema);
  const schema = described.requestSchema as {
    definitions: Record<string, { properties: Record<string, unknown> }>;
  };
  assert.deepEqual(
    schema.definitions.Message.properties.largeNested,
    original.schemas!.Message.properties!.largeNested,
  );
  assert.match(described.declarations as string, /"largeNested"\?:/);
  assert.deepEqual(document, original, 'presentation order must not mutate native Discovery');
});

test('brief shares inherited callable parameters and preserves method-specific overrides', async () => {
  const document = fixture();
  document.parameters!.auth = { type: 'string' };
  document.parameters!.prettyPrint = { type: 'boolean', default: 'true' };
  document.resources!.users.resources!.messages.methods!.list.parameters!.fields = {
    type: 'string',
    pattern: '^messages',
  };
  const dynamic = new DiscoveryCatalog({ document });
  const brief = JSON.parse(JSON.stringify(await dynamic.describe(list)));
  assert.deepEqual(brief.commonParameters, {
    path: 'gmail/v1/@parameters',
    names: ['prettyPrint'],
  });
  assert.equal(brief.parameters.fields.pattern, '^messages');
  assert.deepEqual(brief.parameters.labelIds, { type: 'array', items: { type: 'string' } });
  const common = await dynamic.describe(brief.commonParameters.path);
  assert.deepEqual(Object.keys(common.parameters as object).sort(), ['fields', 'prettyPrint']);
  assert.equal(common.revision, brief.revision);
  assert.equal(common.source, brief.source);
});

test('schema details keep original formats and follow escaped own properties without expanding references', async () => {
  const document = fixture();
  const node = { type: 'string', format: 'date-time', description: 'RFC 3339.' };
  document.schemas!.Message.properties!['some/~date'] = node;
  document.schemas!.Message.properties!.children = { type: 'array', items: { $ref: 'Message' } };
  const dynamic = new DiscoveryCatalog({ document });
  const brief = JSON.parse(JSON.stringify(await dynamic.describe('gmail/v1#Message')));
  assert.equal(brief.schema.fields['some/~date'].format, 'date-time');
  assert.deepEqual(brief.schema.fields.children.items, { schemaPath: 'gmail/v1#Message' });
  const escaped = await dynamic.describe('gmail/v1#Message/properties/some~1~0date');
  assert.deepEqual(escaped.schema, node);
  assert.equal(escaped.revision, brief.revision);
  const children = await dynamic.describe('gmail/v1#Message/properties/children/items');
  assert.deepEqual(children.schema, { $ref: 'Message' });
  assert.deepEqual(children.references, ['gmail/v1#Message']);
  for (const path of [
    'gmail/v1#constructor',
    'gmail/v1#Message/properties/__proto__',
    'gmail/v1#Message/properties/constructor',
    'gmail/v1#Message/properties/some~2date',
    'gmail/v1#Message/properties/children/items/properties/raw',
    'gmail/v1#Message/properties/' + 'q'.repeat(513),
  ])
    await assert.rejects(dynamic.describe(path), /Google schema/);
});

test('Gmail draft brief retains the capability-specific multipart contract', async () => {
  const document = fixture();
  document.resources!.users.resources!.drafts = {
    methods: {
      create: {
        path: 'gmail/v1/users/{userId}/drafts',
        httpMethod: 'POST',
        parameters: { userId: { type: 'string', required: true, location: 'path' } },
        supportsMediaUpload: true,
        mediaUpload: {
          maxSize: '36700160',
          protocols: {
            simple: { path: '/upload/gmail/v1/users/{userId}/drafts', multipart: true },
          },
        },
        request: { $ref: 'Message' },
        response: { $ref: 'Message' },
      },
    },
  };
  const dynamic = new DiscoveryCatalog({ document });
  const path = 'gmail/v1/users.drafts.create';
  for (const streamMedia of [false, true]) {
    const brief = JSON.parse(JSON.stringify(await dynamic.describe(path, { streamMedia })));
    const full = await dynamic.describe(path, { streamMedia, view: 'full' });
    assert.deepEqual(brief.runtime, full.runtime);
    assert.equal(brief.runtime.artifactUpload, streamMedia);
    assert.deepEqual(brief.runtime.uploadMimeTypes, ['message/rfc822']);
    assert.deepEqual(brief.parameters.media, (full.parameters as Record<string, unknown>).media);
    assert.deepEqual(brief.parameters.media.properties.mimeType.enum, ['message/rfc822']);
    assert.equal(JSON.stringify(brief.parameters.media).includes('"artifact"'), streamMedia);
    assert.equal(brief.requestBody.schemaPath, 'gmail/v1#Message');
  }
});

test('transport-looking request-body fields remain native data rather than top-level overrides', async () => {
  const document = fixture();
  document.schemas!.Message.properties = {
    auth: { type: 'string', required: true },
    media: { type: 'object', additionalProperties: { type: 'string' } },
    headers_: { type: 'string' },
  };
  document.parameters!.auth = { type: 'string' };
  const dynamic = new DiscoveryCatalog({ document });
  const described = await dynamic.describe(send, { view: 'full' });
  assert.ok(!Object.hasOwn(described.parameters as object, 'auth'));
  assert.match(described.declarations as string, /"auth": string/);
  assert.match(described.declarations as string, /"headers_"\?: string/);
  const body = { auth: 'application-data', media: { body: 'native-data' }, headers_: 'also-data' };
  let observed: unknown;
  const dispatcher = createDispatcher({
    catalog: dynamic,
    accessToken: token,
    requestId: 'body-fields',
    transport: async (_url, init) => {
      observed = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
      return json({ id: 'sent' });
    },
  });
  assert.equal((await dispatcher.call(send, { userId: 'me', requestBody: body })).ok, true);
  assert.deepEqual(observed, body);
});

test('a policy-excluded required native parameter makes the method explicitly unsupported', async () => {
  const document = fixture();
  document.resources!.users.resources!.messages.methods!.list.parameters!.AUTH = {
    type: 'string',
    required: true,
  };
  document.resources!.users.resources!.messages.methods!.list.parameterOrder = ['userId', 'AUTH'];
  const dynamic = new DiscoveryCatalog({ document });
  const described = await dynamic.describe(list);
  assert.equal(described.supported, false);
  assert.equal((described.runtime as { json: boolean }).json, false);
  assert.match(described.unsupportedReason as string, /required native parameter/);
  assert.equal(described.signature, undefined);
  assert.equal(described.declarations, undefined);
  assert.deepEqual(described.excludedParameters, [
    {
      name: 'AUTH',
      reason: 'credentials_or_transport',
      required: true,
    },
  ]);
  let requests = 0;
  const dispatcher = createDispatcher({
    catalog: dynamic,
    accessToken: token,
    requestId: 'required-exclusion',
    transport: async () => {
      requests++;
      return json({});
    },
  });
  for (const params of [{ userId: 'me' }, { userId: 'me', AUTH: 'blocked' }]) {
    const result = await dispatcher.call(list, params);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.outcome, 'not_dispatched');
  }
  assert.equal(requests, 0);
});

test('transient Discovery errors can recover and selected schemas exclude unrelated definitions', async () => {
  let attempts = 0;
  const document = fixture();
  document.schemas!.Unrelated = { type: 'object' };
  document.schemas!.Message.properties!.child = { $ref: 'Message' };
  const dynamic = new DiscoveryCatalog({
    fetch: async () =>
      ++attempts === 1 ? new Response('unavailable', { status: 503 }) : json(document),
  });
  await assert.rejects(dynamic.resolve(list));
  const described = await dynamic.describe(send, { view: 'full' });
  assert.deepEqual(Object.keys((described.requestSchema as { definitions: object }).definitions), [
    'Message',
  ]);
  assert.equal(attempts, 2);
});

test('native request preserves query arrays/body and returns only safe data and metadata', async () => {
  const observed: { url: string; init?: RequestInit }[] = [];
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'native',
    transport: async (url, init) => {
      observed.push({ url: String(url), init });
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
      assert.equal(init?.redirect, 'manual');
      return json({ raw: token, nested: { safe: true } });
    },
  });
  const result = await dispatcher.call(list, {
    userId: 'me',
    labelIds: ['INBOX', 'UNREAD'],
    fields: 'messages(id)',
  });
  assert.equal(result.ok, true);
  assert.match(observed[0].url, /labelIds=INBOX&labelIds=UNREAD/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.deepEqual(
    dispatcher.outcomes.map((outcome) => outcome.outcome),
    ['acknowledged'],
  );
  const body = { raw: 'base64url', labels: { extensible: 'yes' }, futureField: true };
  assert.equal((await dispatcher.call(send, { userId: 'me', requestBody: body })).ok, true);
  assert.deepEqual(JSON.parse(String(observed[1].init?.body)), body);
});

test('authoritative rejection is sanitized and does not prevent a later mutation', async () => {
  let requests = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'reject',
    transport: async () =>
      ++requests === 1
        ? json(
            { error: { message: token, errors: [{ reason: 'forbidden' }, { reason: token }] } },
            403,
          )
        : json({ id: 'sent' }),
  });
  const failed = await dispatcher.call(send, { userId: 'me', requestBody: {} });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.outcome, 'rejected');
    assert.deepEqual(failed.error.reasons, ['forbidden']);
  }
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(token));
  assert.equal((await dispatcher.call(send, { userId: 'me', requestBody: {} })).ok, true);
  assert.equal(dispatcher.hasUnknownOutcome, false);
});

test('ambiguous mutation is attempted once, fences queued mutations, and permits reads', async () => {
  const requested: string[] = [];
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'unknown',
    transport: async (url, init) => {
      requested.push(init?.method ?? '');
      return init?.method === 'GET'
        ? json({ messages: [] })
        : json({ error: { message: token } }, 503);
    },
  });
  const results = await Promise.all([
    dispatcher.call(remove, { userId: 'me', id: 'first' }),
    dispatcher.call(send, { userId: 'me', requestBody: {} }),
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, false);
  assert.deepEqual(
    dispatcher.outcomes.map((outcome) => outcome.outcome),
    ['unknown', 'not_dispatched'],
  );
  assert.equal(dispatcher.hasUnknownOutcome, true);
  assert.deepEqual(requested, ['DELETE']);
  assert.equal((await dispatcher.call(list, { userId: 'me' })).ok, true);
  assert.deepEqual(requested, ['DELETE', 'GET']);
});

test('transport failure and timeout are uncertain and late success cannot change the receipt', async () => {
  const reset = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'reset',
    transport: async () => {
      throw new TypeError(`reset ${token}`);
    },
  });
  assert.equal((await reset.call(send, { userId: 'me' })).ok, false);
  assert.equal(reset.hasUnknownOutcome, true);
  let complete!: (response: Response) => void;
  const delayed = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'timeout',
    limits: { callTimeoutMs: 5 },
    transport: async () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const result = await delayed.call(send, { userId: 'me' });
  assert.equal(result.ok, false);
  assert.equal(delayed.outcomes[0].outcome, 'unknown');
  complete(json({ id: 'late' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(delayed.outcomes[0].outcome, 'unknown');
});

test('close records uncertainty immediately, aborts in-flight work, and leaves late success uncertain', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'close',
    transport: async (_url, init) => {
      signal = init?.signal;
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const pending = dispatcher.call(send, { userId: 'me' });
  await ready;
  dispatcher.close();
  assert.equal(dispatcher.hasUnknownOutcome, true);
  assert.equal(signal?.aborted, true);
  complete(json({ id: 'late' }));
  assert.equal((await pending).ok, false);
  assert.equal(dispatcher.outcomes[0].outcome, 'unknown');
  assert.equal((await dispatcher.call(list, { userId: 'me' })).ok, false);
});

test('trusted snippet policy rejects mutations/service escapes before dispatch and ledger is bounded', async () => {
  let requests = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'policy',
    limits: { maxCalls: 2 },
    transport: async () => {
      requests++;
      return json({});
    },
  });
  assert.equal((await dispatcher.call(send, { userId: 'me' }, { readOnly: true })).ok, false);
  assert.equal((await dispatcher.call(list, { userId: 'me' }, { services: ['drive'] })).ok, false);
  assert.equal((await dispatcher.call(list, { userId: 'me' })).ok, false);
  assert.equal(requests, 0);
  assert.equal(dispatcher.outcomes.length, 3);
  assert.equal(dispatcher.outcomes.at(-1)?.path, list);
  assert.equal(dispatcher.outcomes.at(-1)?.outcome, 'not_dispatched');
  assert.equal(dispatcher.outcomesComplete, true, 'The first limit attempt still has a receipt');
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await dispatcher.call(send, { userId: 'me' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'CALL_LIMIT');
  }
  assert.equal(dispatcher.outcomes.length, 3, 'Repeated limit attempts cannot grow the ledger');
  assert.equal(dispatcher.outcomesComplete, false, 'Omitted attempted paths cannot look complete');
  assert.equal(requests, 0);
});

test('native path traversal is rejected before fetch and request bodies remain schema validated', async () => {
  let calls = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'paths',
    transport: async () => {
      calls++;
      return json({});
    },
  });
  for (const userId of ['..', '../outside', '%2e%2e', '%2F..']) {
    const result = await dispatcher.call(list, { userId });
    assert.equal(result.ok, false, userId);
  }
  assert.equal((await dispatcher.call(send, { userId: 'me', requestBody: { raw: 42 } })).ok, false);
  assert.equal(
    (await dispatcher.call(send, { userId: 'me', requestBody: { labels: { x: 42 } } })).ok,
    false,
  );
  assert.equal(calls, 0);
});

test('bodyless native mutation acknowledges null data; response cap preserves acknowledgement', async () => {
  const empty = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'empty',
    transport: async () => new Response(null, { status: 204 }),
  });
  const result = await empty.call(remove, { userId: 'me', id: 'gone' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.data, null);
  const capped = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'cap',
    limits: { maxResponseBytes: 5 },
    transport: async () => json({ id: 'accepted' }),
  });
  assert.equal((await capped.call(send, { userId: 'me' })).ok, false);
  assert.equal(capped.outcomes[0].outcome, 'acknowledged');
});

test('chunked Google bodies stop before decode limit and retain acknowledged mutation', async () => {
  let chunks = 0,
    canceled = false;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'stream-cap',
    limits: { maxResponseBytes: 16 },
    transport: async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            chunks++;
            stream.enqueue(new TextEncoder().encode('x'.repeat(32)));
            if (chunks === 10) stream.close();
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200 },
      ),
  });
  const result = await dispatcher.call(send, { userId: 'me', requestBody: { raw: 'base64url' } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'RESPONSE_LIMIT');
  assert.equal(dispatcher.outcomes[0].outcome, 'acknowledged');
  assert.equal(canceled, true);
  assert.ok(chunks < 10);
});

test('generated declarations parse for reserved Google names and retain selected native params', async () => {
  const { createSourceFile, ScriptTarget, ScriptKind } = await import('typescript');
  const native = fixture();
  native.resources!.users.resources!.messages.methods!.delete =
    native.resources!.users.resources!.messages.methods!.remove;
  const described = await new DiscoveryCatalog({ document: native }).describe(
    'gmail/v1/users.messages.delete',
    { view: 'full' },
  );
  const declarations = described.declarations as string;
  const parsed = createSourceFile(
    'selected.ts',
    declarations,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  assert.deepEqual(
    (parsed as typeof parsed & { parseDiagnostics: unknown[] }).parseDiagnostics,
    [],
  );
  assert.match(declarations, /"delete"\(params: Params\)/);
  assert.match(declarations, /"userId": string/);
  assert.doesNotMatch(declarations, /newlyDiscovered/);
});

function paginationFixture() {
  const document = fixture();
  const methods = document.resources!.users.resources!.messages.methods!;
  methods.list.parameters!.q = { type: 'string' };
  methods.list.parameters!.pageToken = { type: 'string' };
  methods.get = { ...methods.remove, httpMethod: 'GET', response: { $ref: 'Message' } };
  return new DiscoveryCatalog({ document });
}

test('list outcomes retain actual page requests and native continuation independently of returned data', async () => {
  const urls: URL[] = [];
  const dispatcher = createDispatcher({
    catalog: paginationFixture(),
    accessToken: token,
    requestId: 'pagination',
    transport: async (url) => {
      const requested = new URL(String(url));
      urls.push(requested);
      return json(
        requested.searchParams.has('pageToken')
          ? { messages: [{ id: 'second' }] }
          : { messages: [{ id: 'first' }], nextPageToken: 'native-page-two' },
      );
    },
  });
  const query = 'subject:fixture';
  const first = await dispatcher.call(list, { userId: 'me', q: query, maxResults: 1 });
  assert.equal(first.ok, true);
  if (first.ok) (first.value.data as Record<string, unknown>).nextPageToken = 'forged';
  const second = await dispatcher.call(list, {
    userId: 'me',
    q: query,
    maxResults: 1,
    pageToken: 'native-page-two',
  });
  assert.equal(second.ok, true);
  assert.deepEqual(
    dispatcher.outcomes.map((outcome) => outcome.pagination),
    [
      { query, maxResults: 1, nextPageToken: 'native-page-two' },
      { query, maxResults: 1, requestedPageToken: 'native-page-two' },
    ],
  );
  assert.equal(urls[0].searchParams.get('q'), query);
  assert.equal(urls[1].searchParams.get('pageToken'), 'native-page-two');
  await dispatcher.call(send, { userId: 'me' });
  assert.equal(dispatcher.outcomes[2].pagination, undefined);
  await dispatcher.call(list, { userId: 'me', maxResults: 501 });
  assert.equal(dispatcher.outcomes[3].pagination, undefined);
});

test('unrepresentable pagination is omitted entirely without fabricating a final page or exposing secrets', async () => {
  for (const nextPageToken of ['', null, 42, 'x'.repeat(2049), 'bad\npage', token]) {
    const dispatcher = createDispatcher({
      catalog: paginationFixture(),
      accessToken: token,
      requestId: 'unsafe-page',
      transport: async () => json({ messages: [], nextPageToken }),
    });
    assert.equal((await dispatcher.call(list, { userId: 'me', maxResults: 1 })).ok, true);
    assert.equal(dispatcher.outcomes[0].pagination, undefined);
    assert.ok(!JSON.stringify(dispatcher.outcomes).includes(token));
  }
  for (const params of [{ q: 'x'.repeat(4097) }, { q: token }, { pageToken: 'x'.repeat(2049) }]) {
    const dispatcher = createDispatcher({
      catalog: paginationFixture(),
      accessToken: token,
      requestId: 'unsafe-request',
      transport: async () => json({ messages: [] }),
    });
    assert.equal((await dispatcher.call(list, { userId: 'me', ...params })).ok, true);
    assert.equal(dispatcher.outcomes[0].pagination, undefined);
  }
});

test('get outcomes identify only validated dispatched reads, including native rejections', async () => {
  const dispatcher = createDispatcher({
    catalog: paginationFixture(),
    accessToken: token,
    requestId: 'get-resource',
    transport: async (url) =>
      String(url).includes('missing')
        ? json({ error: { message: 'Not Found' } }, 404)
        : json({ id: 'present' }),
  });
  const get = 'gmail/v1/users.messages.get';
  await dispatcher.call(get, { userId: 'me', id: 'present' });
  await dispatcher.call(get, { userId: 'me', id: 'missing' });
  await dispatcher.call(get, { userId: 'me' });
  await dispatcher.call(get, { userId: 'me', id: 'x'.repeat(257) });
  await dispatcher.call(get, { userId: 'me', id: token });
  assert.deepEqual(
    dispatcher.outcomes.map(({ outcome, resourceId }) => ({ outcome, resourceId })),
    [
      { outcome: 'acknowledged', resourceId: 'present' },
      { outcome: 'rejected', resourceId: 'missing' },
      { outcome: 'not_dispatched', resourceId: undefined },
      { outcome: 'acknowledged', resourceId: undefined },
      { outcome: 'acknowledged', resourceId: undefined },
    ],
  );
});
