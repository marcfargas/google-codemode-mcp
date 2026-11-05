import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';
import test from 'node:test';
import { openBuiltWorker, type ExecutionReceipt } from '../support/worker-client.ts';
import type { ArtifactReference, ArtifactOutcome } from '../../src/artifacts.ts';

const token = 'inert-workerd-artifact-token';
const read = `await google.gmail({version:'v1'}).users.messages.list({userId:'me'});`;
const document = {
  name: 'gmail',
  version: 'v1',
  revision: 'artifact-fixture',
  rootUrl: 'https://gmail.googleapis.com/',
  servicePath: '',
  schemas: {
    Message: { type: 'object', properties: { id: { type: 'string' }, raw: { type: 'string' } } },
    Messages: {
      type: 'object',
      properties: { messages: { type: 'array', items: { $ref: 'Message' } } },
    },
  },
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            get: {
              path: 'gmail/v1/users/{userId}/messages/{id}',
              httpMethod: 'GET',
              parameters: {
                userId: { type: 'string', required: true, location: 'path' },
                id: { type: 'string', required: true, location: 'path' },
              },
              response: { $ref: 'Message' },
            },
            list: {
              path: 'gmail/v1/users/{userId}/messages',
              httpMethod: 'GET',
              parameters: { userId: { type: 'string', required: true, location: 'path' } },
              response: { $ref: 'Messages' },
            },
            send: {
              path: 'gmail/v1/users/{userId}/messages/send',
              httpMethod: 'POST',
              parameters: { userId: { type: 'string', required: true, location: 'path' } },
              request: { $ref: 'Message' },
              response: { $ref: 'Message' },
            },
          },
        },
      },
    },
  },
};
const outbound = async (request: Request) => {
  if (new URL(request.url).pathname.includes('$discovery')) return Response.json(document);
  assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
  return Response.json(
    request.method === 'POST' ? { id: 'acknowledged-send' } : { messages: [{ id: 'owned' }] },
  );
};
type Receipt = ExecutionReceipt & {
  artifacts: {
    outcomes: ArtifactOutcome[];
    references: ArtifactReference[];
    hasUnknownOutcome: boolean;
    outcomesComplete: boolean;
  };
  error?: string;
};
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function fixtureBundle() {
  const result = await build({
    entryPoints: ['tests/fixtures/artifacts.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    mainFields: ['module', 'main'],
    alias: Object.fromEntries(
      builtinModules
        .filter((name) => !name.startsWith('node:'))
        .map((name) => [name, 'node:' + name]),
    ),
    external: ['cloudflare:workers', 'node:*'],
  });
  const bundle = result.outputFiles[0].text;
  const builtins = [
    ...new Set([...bundle.matchAll(/__require\("(node:[^"]+)"\)/g)].map((match) => match[1])),
  ];
  return (
    builtins
      .map((name, index) => `import * as builtin_${index} from ${JSON.stringify(name)};`)
      .join('\n') +
    '\nfunction require(name){switch(name){' +
    builtins
      .map((name, index) => `case ${JSON.stringify(name)}:return builtin_${index};`)
      .join('') +
    'default:throw new Error("Unknown require")}}\n' +
    bundle
  );
}

test('actual workerd artifacts survive new requests and Worker instances with verifiable bounded chunks', async () => {
  const persistencePath = await mkdtemp(join(tmpdir(), 'google-codemode-artifacts-'));
  let client = await openBuiltWorker({ artifacts: true, persistencePath, outbound });
  try {
    const discovery = await client.tool<{ artifacts: { enabled: boolean } }>('describe', {});
    assert.equal(discovery.artifacts.enabled, true);
    const templates = await client.resourceTemplates();
    assert.equal(
      templates.resourceTemplates.filter((item) => item.uriTemplate.startsWith('artifact:')).length,
      2,
    );
    const listed = await client.resources();
    assert.equal(
      listed.resources.some((item) => item.uri.startsWith('artifact:')),
      false,
    );
    const response = await client.toolResult('execute', {
      accessToken: token,
      code: `${read} return artifacts.putJson({value:'é🌍'.repeat(100000)},{name:'large.json'});`,
    });
    const receipt = response.structuredContent as Receipt;
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    assert.equal(receipt.artifacts.outcomes[0].outcome, 'stored');
    const reference = receipt.artifacts.references[0];
    assert.ok(reference.size > 256000);
    const links = response.content.filter((item) => item.type === 'resource_link');
    assert.equal(links.length, 1);
    assert.equal(links[0].uri, reference.uri);
    assert.equal(links[0].mimeType, 'application/json');
    await client.close();
    client = await openBuiltWorker({ artifacts: true, persistencePath, outbound });
    const manifestResource = await client.resource(reference.uri);
    assert.equal(manifestResource.contents[0].mimeType, 'application/json');
    const manifest = JSON.parse((manifestResource.contents[0] as { text: string }).text);
    assert.equal(manifest.size, reference.size);
    const secret = reference.uri.split('/').at(-1)!;
    for (const malformed of [
      `artifact://google-codemode-mcp/v1/junk/../${secret}`,
      `artifact://google-codemode-mcp/v1/junk/%2e%2e/${secret}`,
      reference.uri.replace('artifact:', 'ARTIFACT:'),
      reference.uri.replace('google-codemode-mcp', 'GOOGLE-CODEMODE-MCP'),
      reference.uri + '?download=1',
      reference.uri + '#fragment',
    ])
      await assert.rejects(client.resource(malformed));
    const chunks: Buffer[] = [];
    let next = manifest.firstChunkUri;
    while (next) {
      const resource = await client.resource(next);
      const chunk = resource.contents[0] as {
        blob: string;
        mimeType: string;
        _meta: Record<string, unknown>;
      };
      assert.equal(chunk.mimeType, 'application/octet-stream');
      const bytes = Buffer.from(chunk.blob, 'base64');
      assert.ok(bytes.length <= 65536);
      assert.equal(
        chunk._meta.offset,
        chunks.reduce((sum, item) => sum + item.length, 0),
      );
      assert.equal(chunk._meta.chunkSha256, hash(bytes));
      assert.equal(chunk._meta.wholeSha256, reference.sha256);
      assert.equal(chunk._meta.originalMimeType, 'application/json');
      chunks.push(bytes);
      next = chunk._meta.nextUri;
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, reference.size);
    assert.equal(hash(bytes), reference.sha256);
    assert.deepEqual(JSON.parse(bytes.toString()), { value: 'é🌍'.repeat(100000) });
    const reread = await client.tool<Receipt>('execute', {
      accessToken: token,
      inputs: { uri: reference.uri },
      code: `return {length:(await artifacts.readJson(inputs.uri)).value.length};`,
    });
    assert.deepEqual(reread.result, { length: 300000 });
    const removed = await client.tool<Receipt>('execute', {
      accessToken: token,
      inputs: { uri: reference.uri },
      code: `return artifacts.delete(inputs.uri);`,
    });
    assert.deepEqual(removed.result, { deleted: true });
    await assert.rejects(client.resource(reference.uri));
  } finally {
    await client.close();
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test('actual workerd stores canonical binary and empty artifacts, checks the same-execution gate and retains output caps', async () => {
  const client = await openBuiltWorker({ artifacts: true, outbound });
  try {
    const gated = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `try{await artifacts.putJson({x:1})}catch(e){return e.code}`,
    });
    assert.equal(gated.result, 'ARTIFACT_WRITE_DENIED');
    const stored = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `${read}
      const empty=await artifacts.putBytes({encoding:'base64',data:'',size:0,mimeType:'application/octet-stream'});
      const raw=Array.from({length:131072},(_,i)=>String.fromCharCode(i%256)).join('');
      const binary=await artifacts.putBytes({encoding:'base64',data:btoa(raw),size:131072,mimeType:'application/octet-stream'});
      const body=await artifacts.readBytes(binary.uri);
      return {empty,binary,size:body.size,sha256:body.sha256};`,
    });
    assert.equal(stored.status, 'completed', JSON.stringify(stored));
    assert.equal((stored.result as { size: number }).size, 131072);
    assert.equal(
      (stored.result as { sha256: string }).sha256,
      hash(Buffer.from(Array.from({ length: 131072 }, (_, i) => i % 256))),
    );
    const empty = stored.artifacts.references[0];
    const manifest = JSON.parse(
      ((await client.resource(empty.uri)).contents[0] as { text: string }).text,
    );
    assert.equal(manifest.firstChunkUri, null);
    assert.equal(manifest.sha256, hash(''));
    const tooLarge = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `${read} try{return await artifacts.putBytes({encoding:'base64',data:btoa('x'.repeat(131073)),size:131073,mimeType:'application/octet-stream'})}catch(e){return e.code}`,
    });
    assert.equal(tooLarge.artifacts.references.length, 0);
    const capped = await client.toolResult('execute', {
      accessToken: token,
      code: `${read} await artifacts.putJson({saved:true});return 'x'.repeat(256001);`,
    });
    const cappedReceipt = capped.structuredContent as Receipt;
    assert.equal(cappedReceipt.status, 'error');
    assert.match(cappedReceipt.error!, /256000/);
    assert.equal(cappedReceipt.artifacts.outcomes[0].outcome, 'stored');
    assert.equal(capped.content.filter((item) => item.type === 'resource_link').length, 1);
    const failed = await client.toolResult('execute', {
      accessToken: token,
      code: `${read} await artifacts.putJson({saved:true});throw new Error('after storage');`,
    });
    assert.equal((failed.structuredContent as Receipt).status, 'error');
    assert.equal(failed.content.filter((item) => item.type === 'resource_link').length, 1);
    await assert.rejects(client.tool('execute', { accessToken: token, code: ' '.repeat(64001) }));
    const forged = await client.toolResult('execute', {
      accessToken: token,
      code: `return {artifacts:{references:[{uri:'artifact://google-codemode-mcp/v1/forged',complete:true}]}};`,
    });
    assert.equal(forged.content.filter((item) => item.type === 'resource_link').length, 0);
  } finally {
    await client.close();
  }
});

test('actual sandbox rejects lossy or executable JSON before bridge serialization', async () => {
  const client = await openBuiltWorker({ artifacts: true, outbound });
  try {
    const receipt = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `${read}
      let hooks=0; const cyclic={};cyclic.self=cyclic;
      const array=[1];array.extra=2;
      const symbol={a:1};symbol[Symbol('hidden')]=2;
      const hidden={};Object.defineProperty(hidden,'value',{value:1});
      const values=[undefined,()=>1,1n,NaN,Infinity,-0,new Date(),new Map(),new Uint8Array(1),cyclic,[,1],array,symbol,hidden,
        {get value(){hooks++;return 1}},{toJSON(){hooks++;return 1}},[undefined]];
      let rejected=0;for(const value of values){try{await artifacts.putJson(value)}catch{rejected++}}
      try{await artifacts.putJson({safe:true},{get name(){hooks++;return 'unsafe'}})}catch{rejected++}
      return {rejected,hooks};`,
    });
    assert.equal(receipt.status, 'completed');
    assert.deepEqual(receipt.result, { rejected: 18, hooks: 0 });
    assert.equal(receipt.artifacts.outcomes.length, 0);
  } finally {
    await client.close();
  }
});

test('ordinary toJSON data is lossless while inherited serializer hooks never run', async () => {
  const client = await openBuiltWorker({ artifacts: true, outbound });
  try {
    const receipt = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `${read}
      const ref=await artifacts.putJson({toJSON:null,nested:{toJSON:'ordinary data'}});
      const value=await artifacts.readJson(ref.uri);await artifacts.delete(ref.uri);
      let hooks=0,rejected=0;
      Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){hooks++;return ()=>0}});
      try{await artifacts.putJson({safe:true})}catch{rejected++}finally{delete Object.prototype.toJSON}
      Object.prototype.toJSON=function(){hooks++;return 0};
      try{await artifacts.putJson({safe:true})}catch{rejected++}finally{delete Object.prototype.toJSON}
      Array.prototype.toJSON=function(){hooks++;return 0};
      try{await artifacts.putJson([1])}catch{rejected++}finally{delete Array.prototype.toJSON}
      return {value,hooks,rejected};`,
    });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    assert.deepEqual(receipt.result, {
      value: { toJSON: null, nested: { toJSON: 'ordinary data' } },
      hooks: 0,
      rejected: 3,
    });
    assert.deepEqual(
      receipt.artifacts.outcomes.map((outcome) => outcome.outcome),
      ['stored', 'read', 'deleted'],
    );
    assert.equal(receipt.artifacts.references.length, 0);
  } finally {
    await client.close();
  }
});

test('disabled deployment is explicit; snippets cannot use artifacts and storage failures preserve native acknowledgements', async () => {
  const disabled = await openBuiltWorker({ outbound });
  try {
    assert.equal(
      (await disabled.tool<{ enabled: boolean }>('describe', { path: 'artifacts' })).enabled,
      false,
    );
    const receipt = await disabled.tool<Receipt>('execute', {
      accessToken: token,
      code: `${read} try{await artifacts.putJson({x:1})}catch(e){return e.code}`,
    });
    assert.equal(receipt.result, 'ARTIFACTS_UNAVAILABLE');
    assert.equal(receipt.artifacts.references.length, 0);
  } finally {
    await disabled.close();
  }
  const client = await openBuiltWorker({
    artifacts: true,
    outbound,
    bundle: await fixtureBundle(),
  });
  try {
    const nested = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `${read} return snippets.run('artifactProbe',{});`,
    });
    assert.equal(nested.status, 'error');
    assert.equal(nested.artifacts.outcomes.length, 0);
    const exposed = await client.tool<Receipt>('artifact_probe', { accessToken: token });
    assert.equal(exposed.status, 'error');
    assert.equal(exposed.artifacts.outcomes.length, 0);
    const failure = await client.tool<Receipt>('execute', {
      accessToken: token,
      code: `await google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}});return artifacts.putJson({x:1});`,
    });
    assert.equal(failure.status, 'error');
    assert.equal(failure.outcomes[0].outcome, 'acknowledged');
    assert.equal(failure.outcomes[0].mutation, true);
    assert.equal(failure.outcomes[0].path, 'gmail/v1/users.messages.send');
    assert.equal(failure.outcomes[0].httpStatus, 200);
    assert.equal(failure.outcomesComplete, true);
    assert.equal(failure.hasUnknownOutcome, false);
    assert.equal(failure.artifacts.hasUnknownOutcome, true);
    assert.equal(failure.artifacts.outcomes[0].outcome, 'unknown');
  } finally {
    await client.close();
  }
});

test('large native JSON routes explicitly through artifacts while the native response cap stays hard', async () => {
  const native = {
    id: 'owned-large',
    raw: Buffer.from('native message bytes '.repeat(25000)).toString('base64url'),
  };
  let oversized = false;
  const client = await openBuiltWorker({
    artifacts: true,
    outbound: async (request) => {
      if (new URL(request.url).pathname.endsWith('/messages/large')) {
        assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
        return Response.json(oversized ? { id: 'owned-large', raw: 'a'.repeat(1000001) } : native);
      }
      return outbound(request);
    },
  });
  try {
    const program = `const {data}=await google.gmail({version:'v1'}).users.messages.get({userId:'me',id:'large'});return artifacts.putJson(data,{name:'native-message.json'});`;
    const stored = await client.tool<Receipt>('execute', { accessToken: token, code: program });
    assert.equal(stored.status, 'completed', JSON.stringify(stored));
    assert.equal(stored.outcomes[0].outcome, 'acknowledged');
    const ref = stored.artifacts.references[0];
    const expected = Buffer.from(JSON.stringify(native));
    assert.ok(expected.length > 256000 && expected.length < 1000000);
    assert.equal(ref.sha256, hash(expected));
    const manifest = JSON.parse(
      ((await client.resource(ref.uri)).contents[0] as { text: string }).text,
    );
    let uri = manifest.firstChunkUri;
    const chunks: Buffer[] = [];
    while (uri) {
      const part = (await client.resource(uri)).contents[0];
      assert.ok('blob' in part && typeof part.blob === 'string');
      chunks.push(Buffer.from(part.blob, 'base64'));
      const nextUri = part._meta?.nextUri;
      assert.ok(nextUri === null || typeof nextUri === 'string');
      uri = nextUri;
    }
    assert.deepEqual(Buffer.concat(chunks), expected);
    await client.tool('execute', {
      accessToken: token,
      inputs: { uri: ref.uri },
      code: 'return artifacts.delete(inputs.uri);',
    });
    oversized = true;
    const refused = await client.tool<Receipt>('execute', { accessToken: token, code: program });
    assert.equal(refused.status, 'error');
    assert.equal(refused.artifacts.references.length, 0);
    assert.equal(
      refused.artifacts.outcomes.length,
      0,
      'oversized native response never reaches storage',
    );
  } finally {
    await client.close();
  }
});
