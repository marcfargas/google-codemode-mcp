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
  assert.deepEqual(await dynamic.describe(), { services: [{ name: 'gmail', versions: ['v1'] }] });
  assert.equal(fetched, 0);
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
  const described = await dynamic.describe(send);
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
  assert.equal(dispatcher.outcomes.length, 2);
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
