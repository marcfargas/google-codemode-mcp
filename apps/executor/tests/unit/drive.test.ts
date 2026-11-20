import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DiscoveryCatalog, MAX_DOWNLOAD_BYTES } from '../../src/discovery.ts';
import type { DiscoveryDocument } from '../../src/discovery.ts';
import { createDispatcher } from '../../src/dispatcher.ts';
import { SERVICES } from '../../src/services.ts';
import { validateSnippets } from '../../src/snippets.ts';

const token = 'synthetic-drive-secret';
const list = 'drive/v3/files.list';
const get = 'drive/v3/files.get';
const update = 'drive/v3/files.update';
const exportFile = 'drive/v3/files.export';
// Reduced from official Drive v3 Discovery revision 20261102. HTTP verbs,
// root/service paths and media flags match the native document.
function drive(): DiscoveryDocument {
  const fileId = { type: 'string', required: true, location: 'path' };
  return {
    name: 'drive',
    version: 'v3',
    revision: 'fixture-drive-20261102',
    rootUrl: 'https://www.googleapis.com/',
    servicePath: 'drive/v3/',
    parameters: {
      alt: { type: 'string', enum: ['json', 'media', 'proto'], location: 'query' },
      fields: { type: 'string', location: 'query' },
      key: { type: 'string' },
      access_token: { type: 'string' },
    },
    schemas: {
      File: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
      FileList: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { $ref: 'File' } },
          nextPageToken: { type: 'string' },
          incompleteSearch: { type: 'boolean' },
          kind: { type: 'string' },
        },
      },
      Operation: { type: 'object', properties: { name: { type: 'string' } } },
    },
    methods: { rootDiagnostic: { httpMethod: 'GET', path: 'diagnostic' } },
    resources: {
      files: {
        methods: {
          list: {
            httpMethod: 'GET',
            path: 'files',
            parameters: {
              q: { type: 'string', location: 'query' },
              pageSize: { type: 'integer', location: 'query' },
              pageToken: { type: 'string', location: 'query' },
            },
            response: { $ref: 'FileList' },
          },
          get: {
            httpMethod: 'GET',
            path: 'files/{fileId}',
            parameters: { fileId },
            parameterOrder: ['fileId'],
            response: { $ref: 'File' },
            supportsMediaDownload: true,
            useMediaDownloadService: true,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
          },
          update: {
            httpMethod: 'PATCH',
            path: 'files/{fileId}',
            parameters: { fileId },
            parameterOrder: ['fileId'],
            request: { $ref: 'File' },
            response: { $ref: 'File' },
            supportsMediaUpload: true,
          },
          export: {
            httpMethod: 'GET',
            path: 'files/{fileId}/export',
            parameters: { fileId, mimeType: { type: 'string', required: true, location: 'query' } },
            parameterOrder: ['fileId', 'mimeType'],
            supportsMediaDownload: true,
            useMediaDownloadService: true,
          },
          download: {
            httpMethod: 'POST',
            path: 'files/{fileId}/download',
            parameters: { fileId },
            parameterOrder: ['fileId'],
            response: { $ref: 'Operation' },
          },
        },
      },
    },
  };
}
const gmail = (): DiscoveryDocument => ({
  name: 'gmail',
  version: 'v1',
  rootUrl: 'https://gmail.googleapis.com/',
  servicePath: '',
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            list: {
              httpMethod: 'GET',
              path: 'gmail/v1/users/me/messages',
              response: { type: 'object' },
            },
          },
        },
      },
    },
  },
});
const catalog = () =>
  new DiscoveryCatalog({ documents: { 'drive/v3': drive(), 'gmail/v1': gmail() } });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('registry selects lazy native documents, root resources, dynamic methods and all provenance', async () => {
  const requested: string[] = [];
  const documents = { 'drive/v3': drive(), 'gmail/v1': gmail() };
  documents['drive/v3'].resources!.files.methods!.newlyDiscovered = {
    path: 'new',
    httpMethod: 'GET',
  };
  const dynamic = new DiscoveryCatalog({
    fetch: async (url) => {
      requested.push(String(url));
      return json(
        String(url) === SERVICES['drive/v3'].discoveryUrl
          ? documents['drive/v3']
          : documents['gmail/v1'],
      );
    },
  });
  const initialProvenance = dynamic.provenance;
  assert.equal(initialProvenance, null);
  assert.deepEqual(await dynamic.describe('drive'), {
    service: 'drive',
    versions: ['v3'],
    paths: ['drive/v3'],
  });
  assert.equal(requested.length, 0);
  const root = await dynamic.describe('drive/v3');
  assert.deepEqual(root.resources, ['drive/v3/files']);
  assert.deepEqual(root.methods, [
    { path: 'drive/v3/rootDiagnostic', mutation: false, description: undefined },
  ]);
  assert.equal((await dynamic.resolve('drive/v3/files.newlyDiscovered')).httpMethod, 'GET');
  assert.equal((await dynamic.resolve(update)).httpMethod, 'PATCH');
  assert.equal((await dynamic.document()).name, 'gmail');
  assert.equal((await dynamic.document('drive/v3')).name, 'drive');
  assert.deepEqual(requested, [
    SERVICES['drive/v3'].discoveryUrl,
    SERVICES['gmail/v1'].discoveryUrl,
  ]);
  assert.deepEqual(
    dynamic.provenance?.map(({ service, source }) => ({ service, source })),
    [
      { service: 'drive', source: SERVICES['drive/v3'].discoveryUrl },
      { service: 'gmail', source: SERVICES['gmail/v1'].discoveryUrl },
    ],
  );
  assert.ok((await dynamic.describe('drive/v3#File')).schema);
  await assert.rejects(dynamic.resolve('drive/v2/files.get'));
  const bad = drive();
  bad.rootUrl = 'https://gmail.googleapis.com/';
  await assert.rejects(new DiscoveryCatalog({ document: bad }).document('drive/v3'), /Untrusted/);
});

test('descriptions and generated declarations expose metadata and bounded byte selection truthfully', async () => {
  const dynamic = catalog();
  for (const streamMedia of [false, true]) {
    const brief = JSON.parse(JSON.stringify(await dynamic.describe(get, { streamMedia })));
    const expanded = await dynamic.describe(get, { streamMedia, view: 'full' });
    assert.deepEqual(brief.parameters.alt.enum, ['json', 'media']);
    assert.deepEqual(brief.commonParameters.names, ['fields']);
    assert.equal(brief.runtime.mediaResult, streamMedia ? 'artifact-reference' : 'inline-base64');
    assert.deepEqual(brief.runtime, {
      ...(expanded.runtime as object),
      mediaResult: streamMedia ? 'artifact-reference' : 'inline-base64',
    });
    assert.deepEqual(brief.response, { schemaPath: 'drive/v3#File' });
  }
  const described = await dynamic.describe(get, { view: 'full' });
  assert.deepEqual((described.parameters as Record<string, { enum?: string[] }>).alt.enum, [
    'json',
    'media',
  ]);
  assert.deepEqual(described.runtime, {
    maxParameterBytes: 2097152,
    json: true,
    mediaDownload: true,
    mediaUpload: false,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    mediaSelection: "alt: 'media'",
  });
  assert.equal(described.source, SERVICES['drive/v3'].discoveryUrl);
  assert.equal(
    described.documentation,
    'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get',
  );
  assert.ok(described.mediaResponseSchema);
  assert.match(described.declarations as string, /alt: 'media'.*GoogleMediaBytes/);
  const exported = await dynamic.describe(exportFile, { view: 'full' });
  assert.equal((exported.runtime as { json: boolean }).json, false);
  assert.match(
    exported.declarations as string,
    /"export"\(params: Params\): Promise<\{data: GoogleMediaBytes/,
  );
  assert.equal((await dynamic.describe(update, { view: 'full' })).mediaResponseSchema, undefined);
  const { createSourceFile, ScriptTarget, ScriptKind } = await import('typescript');
  for (const path of [get, update, exportFile, 'drive/v3/rootDiagnostic']) {
    const parsed = createSourceFile(
      'selected.ts',
      (await dynamic.describe(path, { view: 'full' })).declarations as string,
      ScriptTarget.Latest,
      true,
      ScriptKind.TS,
    );
    assert.deepEqual(
      (parsed as typeof parsed & { parseDiagnostics: unknown[] }).parseDiagnostics,
      [],
    );
  }
});

test('every method in the Drive and Gmail Discovery fixtures fits the brief budget in both media modes', async () => {
  const dynamic = catalog();
  const pending = ['drive/v3', 'gmail/v1'];
  while (pending.length) {
    const resource = await dynamic.describe(pending.pop());
    pending.push(...(resource.resources as string[]));
    for (const { path } of resource.methods as { path: string }[]) {
      for (const streamMedia of [false, true]) {
        const brief = await dynamic.describe(path, { streamMedia });
        assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 5_000, path);
      }
    }
  }
});

test('metadata GET and native PATCH retain JSON bodies and actual Drive paths', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  let name = 'old';
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'patch',
    transport: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body as string | undefined,
      });
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      if (init?.method === 'PATCH') name = JSON.parse(init.body as string).name;
      return json({ id: 'fixture', name });
    },
  });
  const first = await dispatcher.call(get, { fileId: 'fixture', alt: 'json', fields: 'id,name' });
  assert.equal(first.ok, true);
  if (first.ok) assert.deepEqual(first.value.data, { id: 'fixture', name: 'old' });
  assert.equal(
    (await dispatcher.call(update, { fileId: 'fixture', requestBody: { name: 'renamed' } })).ok,
    true,
  );
  const readback = await dispatcher.call(get, { fileId: 'fixture' });
  assert.equal(readback.ok, true);
  if (readback.ok) assert.deepEqual(readback.value.data, { id: 'fixture', name: 'renamed' });
  assert.match(calls[0].url, /^https:\/\/www.googleapis.com\/drive\/v3\/files\/fixture\?/);
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].body!), { name: 'renamed' });
  assert.equal(dispatcher.outcomes[1].mutation, true);
});

test('Drive pagination requires explicit calls and preserves empty pages, opaque tokens and incomplete search', async () => {
  const pages = [
    { files: [{ id: 'first' }], nextPageToken: 'page-2', incompleteSearch: false },
    { files: [], nextPageToken: 't+/=1', incompleteSearch: false },
    { files: [{ id: 'last' }], incompleteSearch: true },
  ];
  const calls: URL[] = [];
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'drive-pages',
    transport: async (url) => {
      calls.push(new URL(String(url)));
      assert.ok(calls.length <= pages.length, 'unexpected automatic page fetch');
      return json(pages[calls.length - 1]);
    },
  });
  const params = { q: 'trashed = false', pageSize: 1 };
  const first = await dispatcher.call(list, params);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);
  if (!first.ok) return;
  assert.deepEqual(first.value.data, pages[0]);
  const second = await dispatcher.call(list, {
    ...params,
    pageToken: (first.value.data as { nextPageToken: string }).nextPageToken,
  });
  assert.equal(second.ok, true);
  assert.equal(calls.length, 2);
  if (!second.ok) return;
  assert.deepEqual(second.value.data, pages[1]);
  const third = await dispatcher.call(list, {
    ...params,
    pageToken: (second.value.data as { nextPageToken: string }).nextPageToken,
  });
  assert.equal(third.ok, true);
  assert.equal(calls.length, 3);
  if (third.ok) assert.deepEqual(third.value.data, pages[2]);
  assert.deepEqual(
    calls.map((url) => url.searchParams.get('pageToken')),
    [null, 'page-2', 't+/=1'],
  );
  assert.match(calls[2].search, /pageToken=t%2B%2F%3D1/);
  for (const url of calls) {
    assert.equal(url.pathname, '/drive/v3/files');
    assert.equal(url.searchParams.get('pageSize'), '1');
    assert.equal(url.searchParams.get('q'), params.q);
  }
  assert.equal(dispatcher.outcomes.length, 3);
});

test('Drive metadata response headers preserve an ETag only when Google supplies one', async () => {
  for (const etag of ['"synthetic-etag"', undefined]) {
    const dispatcher = createDispatcher({
      catalog: catalog(),
      accessToken: token,
      requestId: 'drive-etag',
      transport: async () =>
        new Response(JSON.stringify({ id: 'fixture' }), {
          headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
        }),
    });
    const result = await dispatcher.call(get, { fileId: 'fixture' });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(Object.hasOwn(result.value.headers, 'etag'), etag !== undefined);
    assert.equal(result.value.headers.etag, etag);
    assert.deepEqual(result.value.data, { id: 'fixture' });
  }
});

test('Drive descriptions and declaration parameter shapes invent no conditional or transport options', async () => {
  const ts = await import('typescript');
  for (const [path, expected] of [
    [get, ['alt', 'fields', 'fileId']],
    [update, ['fields', 'fileId', 'requestBody']],
  ] as const) {
    const described = await catalog().describe(path, { view: 'full' });
    assert.deepEqual(
      Object.keys(described.parameters as object).sort(),
      expected.filter((key) => key !== 'requestBody').sort(),
    );
    const parsed = ts.createSourceFile(
      'selected.ts',
      described.declarations as string,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const params = parsed.statements.find(
      (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'Params',
    );
    assert.ok(params && ts.isTypeAliasDeclaration(params) && ts.isTypeLiteralNode(params.type));
    const members = params.type.members.map((member) => {
      assert.ok(ts.isPropertySignature(member) && member.name && ts.isStringLiteral(member.name));
      return member.name.text;
    });
    assert.deepEqual(members.sort(), [...expected].sort());
    const method = parsed.statements.find(ts.isVariableStatement);
    assert.ok(method);
    const declaration = method.declarationList.declarations[0];
    assert.ok(declaration.type && ts.isTypeLiteralNode(declaration.type));
    for (const signature of declaration.type.members) {
      assert.ok(ts.isMethodSignature(signature));
      assert.equal(signature.parameters.length, 1);
    }
  }
});

test('native byte mode preserves arbitrary, empty and JSON-MIME bytes with independent digests', async () => {
  for (const [bytes, mimeType] of [
    [new Uint8Array([0, 255, 128, 1, 0, 13, 10]), 'application/octet-stream'],
    [new Uint8Array(), 'application/octet-stream'],
    [new TextEncoder().encode(' { "name": "ñ" }\n'), 'application/json'],
  ] as const) {
    const dispatcher = createDispatcher({
      catalog: catalog(),
      accessToken: token,
      requestId: 'bytes',
      transport: async (url) => {
        assert.equal(new URL(String(url)).searchParams.get('alt'), 'media');
        return new Response(bytes, { headers: { 'content-type': mimeType } });
      },
    });
    const result = await dispatcher.call(get, { fileId: 'fixture', alt: 'media' });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    const data = result.value.data as {
      encoding: string;
      data: string;
      size: number;
      mimeType: string;
      sha256: string;
    };
    assert.equal(data.encoding, 'base64');
    assert.deepEqual(Buffer.from(data.data, 'base64'), Buffer.from(bytes));
    assert.equal(data.size, bytes.length);
    assert.equal(data.mimeType, mimeType);
    assert.equal(data.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

test('native export without response schema always returns bytes and operation download stays JSON', async () => {
  const expected = new TextEncoder().encode('Exported ä\n');
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'export',
    transport: async (url) =>
      String(url).includes('/export')
        ? new Response(expected, { headers: { 'content-type': 'text/plain' } })
        : json({ name: 'operations/native' }),
  });
  const exported = await dispatcher.call(exportFile, { fileId: 'fixture', mimeType: 'text/plain' });
  assert.equal(exported.ok, true);
  if (exported.ok)
    assert.deepEqual(
      Buffer.from((exported.value.data as { data: string }).data, 'base64'),
      Buffer.from(expected),
    );
  const operation = await dispatcher.call('drive/v3/files.download', { fileId: 'fixture' });
  assert.equal(operation.ok, true);
  if (operation.ok) assert.deepEqual(operation.value.data, { name: 'operations/native' });
});

test('byte stream enforces exact raw bound despite missing or dishonest Content-Length', async () => {
  const exact = new Uint8Array(MAX_DOWNLOAD_BYTES).fill(120);
  for (const contentLength of [undefined, '1', String(MAX_DOWNLOAD_BYTES * 2)]) {
    const dispatcher = createDispatcher({
      catalog: catalog(),
      accessToken: token,
      requestId: 'boundary',
      transport: async () =>
        new Response(exact, { headers: contentLength ? { 'content-length': contentLength } : {} }),
    });
    const result = await dispatcher.call(get, { fileId: 'fixture', alt: 'media' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.value.data as { size: number }).size, MAX_DOWNLOAD_BYTES);
  }
  let canceled = false,
    emitted = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'overrun',
    transport: async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            emitted++;
            stream.enqueue(new Uint8Array(32768));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { 'content-length': '1' } },
      ),
  });
  const result = await dispatcher.call(get, { fileId: 'fixture', alt: 'media' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'RESPONSE_LIMIT');
  assert.equal(dispatcher.outcomes[0].outcome, 'acknowledged');
  assert.equal(canceled, true);
  assert.ok(emitted < 10);
});

test('credential bytes fail before base64 encoding and never corrupt successful files', async () => {
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'echo',
    transport: async () => new Response(new TextEncoder().encode(`prefix${token}suffix`)),
  });
  const result = await dispatcher.call(get, { fileId: 'fixture', alt: 'media' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'CREDENTIAL_ECHO');
  assert.equal(dispatcher.outcomes[0].outcome, 'acknowledged');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(Buffer.from(token).toString('base64')));
});

test('media HTTP errors decode bounded reason metadata while redirects and transport stay uncertain', async () => {
  for (const [status, body, reason] of [
    [
      403,
      JSON.stringify({
        error: { errors: [{ reason: 'insufficientPermissions' }, { reason: token }] },
      }),
      'insufficientPermissions',
    ],
    [404, 'not-json Google error', undefined],
    [302, 'redirect', undefined],
  ] as const) {
    let calls = 0;
    const dispatcher = createDispatcher({
      catalog: catalog(),
      accessToken: token,
      requestId: 'media-error',
      transport: async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, 'manual');
        return new Response(body, {
          status,
          headers: { 'content-type': 'application/json', location: 'https://outside.example' },
        });
      },
    });
    const result = await dispatcher.call(get, { fileId: 'fixture', alt: 'media' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.outcome, status === 302 ? 'unknown' : 'rejected');
      assert.deepEqual(result.error.reasons, reason ? [reason] : undefined);
    }
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes(token));
  }
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'transport',
    transport: async () => {
      throw new Error(token);
    },
  });
  const result = await dispatcher.call(get, { fileId: 'fixture', alt: 'media' });
  assert.equal(result.ok, false);
  assert.equal(dispatcher.outcomes[0].outcome, 'unknown');
  assert.ok(!JSON.stringify(result).includes(token));
});

test('canonical media selection never permits credential, transport, alias or upload arguments', async () => {
  let calls = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'blocked',
    transport: async () => {
      calls++;
      return json({});
    },
  });
  for (const params of [
    { alt: 'proto' },
    { alt: 'MEDIA' },
    { Alt: 'media' },
    { alt_: 'media' },
    { responseType: 'arraybuffer' },
    { options: { responseType: 'arraybuffer' } },
    { media: { body: 'upload' } },
    { uploadType: 'media' },
    { AUTH: token },
    { headers_: {} },
    { fileId: '../outside', alt: 'media' },
  ]) {
    const result = await dispatcher.call(get, { fileId: 'fixture', ...params });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.outcome, 'not_dispatched');
  }
  assert.equal((await dispatcher.call(update, { fileId: 'fixture', alt: 'media' })).ok, false);
  assert.equal(
    (await dispatcher.call(exportFile, { fileId: 'fixture', mimeType: 'text/plain', alt: 'json' }))
      .ok,
    false,
  );
  assert.equal(calls, 0);
});

test('snippet registry permits trusted services while resolved-call policies cannot widen across them', async () => {
  const definition = {
    name: 'driveRead',
    description: 'fixture',
    code: 'return null;',
    inputSchema: { type: 'object' },
    services: ['drive/v3'],
    scopes: [],
    readOnly: true,
  };
  assert.equal(validateSnippets([definition])[0].services[0], 'drive/v3');
  assert.throws(
    () => validateSnippets([{ ...definition, services: ['sheets/v4'] }]),
    /Unsupported/,
  );
  let calls = 0;
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'policy',
    transport: async () => {
      calls++;
      return json({});
    },
  });
  for (const [path, params, services] of [
    [get, { fileId: 'fixture' }, ['gmail/v1']],
    ['gmail/v1/users.messages.list', {}, ['drive/v3']],
  ] as const) {
    const result = await dispatcher.call(path, params, { services });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'POLICY_DENIED');
  }
  const denied = await dispatcher.call(
    update,
    { fileId: 'fixture', requestBody: { name: 'x' } },
    { services: ['drive/v3'], readOnly: true },
  );
  assert.equal(denied.ok, false);
  assert.equal(calls, 0);
});

test('Drive outcome target and mutation fields come only from the dispatched validated request', async () => {
  const requests: { fileId: string; body?: unknown }[] = [];
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'mutation-scope',
    transport: async (url, init) => {
      requests.push({
        fileId: new URL(String(url)).pathname.split('/').at(-1)!,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return json({ id: 'actor-forged-id', mutationFields: ['actor-forged-field'] });
    },
  });
  const renamed = await dispatcher.call(update, {
    fileId: 'actual-fixture',
    requestBody: { name: 'new' },
  });
  assert.equal(renamed.ok, true);
  if (renamed.ok) (renamed.value.data as Record<string, unknown>).id = 'different-forged-id';
  await dispatcher.call(get, { fileId: 'actual-fixture' });
  await dispatcher.call(update, {
    fileId: 'actual-fixture',
    requestBody: { name: 'new', description: 'changed' },
  });
  await dispatcher.call(
    update,
    { fileId: 'actual-fixture', requestBody: { name: 'new' } },
    { readOnly: true },
  );
  assert.deepEqual(
    dispatcher.outcomes.map(({ resourceId, mutationFields }) => ({ resourceId, mutationFields })),
    [
      { resourceId: 'actual-fixture', mutationFields: ['name'] },
      { resourceId: 'actual-fixture', mutationFields: undefined },
      { resourceId: 'actual-fixture', mutationFields: ['description', 'name'] },
      { resourceId: undefined, mutationFields: undefined },
    ],
  );
  assert.deepEqual(requests[0], { fileId: 'actual-fixture', body: { name: 'new' } });
});

test('unsafe or oversized Drive target/field annotations are absent rather than truncated', async () => {
  const dispatcher = createDispatcher({
    catalog: catalog(),
    accessToken: token,
    requestId: 'annotation-limits',
    transport: async () => json({ id: 'fixture' }),
  });
  for (const requestBody of [
    { [token]: 'not retained' },
    { ['x'.repeat(129)]: 'too long' },
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, 'many'])),
  ]) {
    const result = await dispatcher.call(update, { fileId: 'fixture', requestBody });
    assert.equal(result.ok, true);
    assert.equal(dispatcher.outcomes.at(-1)?.mutationFields, undefined);
  }
  await dispatcher.call(get, { fileId: token });
  assert.equal(dispatcher.outcomes.at(-1)?.resourceId, undefined);
  await dispatcher.call(get, { fileId: 'x'.repeat(257) });
  assert.equal(dispatcher.outcomes.at(-1)?.resourceId, undefined);
  assert.ok(!JSON.stringify(dispatcher.outcomes).includes(token));
});

test('Drive page annotations derive native IDs and projection, omitting unsafe pages wholesale', async () => {
  for (const [params, page, wanted] of [
    [
      {
        q: "name contains 'fixture'",
        pageSize: 1,
        fields: 'nextPageToken,incompleteSearch,files(id,name)',
      },
      { files: [{ id: 'owned' }], nextPageToken: 't+/=', incompleteSearch: false },
      {
        query: "name contains 'fixture'",
        pageSize: 1,
        fields: 'nextPageToken,incompleteSearch,files(id,name)',
        returnedIds: ['owned'],
        nextPageToken: 't+/=',
        incompleteSearch: false,
      },
    ],
    [
      { pageToken: 't+/=', fields: 'files(id)' },
      { files: [] },
      { requestedPageToken: 't+/=', fields: 'files(id)', returnedIds: [] },
    ],
    [{}, {}, {}],
    [{}, { files: [{ id: 'owned' }], nextPageToken: token }, undefined],
    [{}, { files: [{ id: token }] }, undefined],
    [{}, { files: [{ name: 'no-id' }] }, undefined],
    [{}, { files: [], incompleteSearch: 'false' }, undefined],
    [{}, { files: [], nextPageToken: '' }, undefined],
    [{}, { files: Array(1001).fill({ id: 'id' }) }, undefined],
  ] as const) {
    const dispatcher = createDispatcher({
      catalog: catalog(),
      accessToken: token,
      requestId: 'annotations',
      transport: async () => json(page),
    });
    const out = await dispatcher.call(list, params);
    assert.equal(out.ok, true);
    assert.deepEqual(dispatcher.outcomes[0].pagination, wanted);
  }
});
