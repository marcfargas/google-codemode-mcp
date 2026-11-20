import { readMultipart } from '../support/multipart.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createR2Storage } from '../../src/storage.ts';
import { openBuiltWorker, type ExecutionReceipt } from '../support/worker-client.ts';
import { MEDIA_SKILL_URI } from '../../src/media.ts';

const docs = {
  drive: {
    name: 'drive',
    version: 'v3',
    revision: 'media-fixture',
    rootUrl: 'https://www.googleapis.com/',
    servicePath: 'drive/v3/',
    parameters: { fields: { type: 'string', location: 'query' } },
    schemas: {
      File: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          mimeType: { type: 'string' },
          parents: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    resources: {
      files: {
        methods: {
          create: {
            path: 'files',
            httpMethod: 'POST',
            request: { $ref: 'File' },
            response: { $ref: 'File' },
            supportsMediaUpload: true,
            mediaUpload: {
              protocols: { simple: { multipart: true, path: '/upload/drive/v3/files' } },
            },
          },
          get: {
            path: 'files/{fileId}',
            httpMethod: 'GET',
            supportsMediaDownload: true,
            parameters: {
              fileId: { type: 'string', required: true, location: 'path' },
              alt: { type: 'string', location: 'query' },
            },
            response: { $ref: 'File' },
          },
        },
      },
    },
  },
  gmail: {
    name: 'gmail',
    version: 'v1',
    revision: 'media-fixture',
    rootUrl: 'https://gmail.googleapis.com/',
    servicePath: '',
    schemas: {
      Body: { type: 'object', properties: { data: { type: 'string' }, size: { type: 'integer' } } },
      Message: { type: 'object', properties: { raw: { type: 'string' }, id: { type: 'string' } } },
      Draft: {
        type: 'object',
        properties: { id: { type: 'string' }, message: { $ref: 'Message' } },
      },
    },
    resources: {
      users: {
        resources: {
          messages: {
            resources: {
              attachments: {
                methods: {
                  get: {
                    path: 'gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}',
                    httpMethod: 'GET',
                    parameters: Object.fromEntries(
                      ['userId', 'messageId', 'id'].map((name) => [
                        name,
                        { type: 'string', required: true, location: 'path' },
                      ]),
                    ),
                    response: { $ref: 'Body' },
                  },
                },
              },
            },
          },
          drafts: {
            methods: {
              create: {
                path: 'gmail/v1/users/{userId}/drafts',
                httpMethod: 'POST',
                parameters: { userId: { type: 'string', required: true, location: 'path' } },
                request: { $ref: 'Draft' },
                response: { $ref: 'Draft' },
                supportsMediaUpload: true,
                mediaUpload: {
                  maxSize: '36700160',
                  protocols: {
                    simple: { multipart: true, path: '/upload/gmail/v1/users/{userId}/drafts' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
const json = (data: unknown) => Response.json(data);
const token = 'inert-workerd-media-token';

function attachment(raw: string) {
  const message = Buffer.from(raw, 'base64url').toString('ascii');
  const boundary = /boundary="([^"]+)"/.exec(message)![1];
  const part = message.split('--' + boundary)[2];
  const split = part.indexOf('\r\n\r\n');
  const headers = part.slice(0, split);
  return {
    bytes: Buffer.from(part.slice(split + 4).trim(), 'base64'),
    name: decodeURIComponent(/filename\*=UTF-8''([^\r\n]+)/.exec(headers)![1]),
    headers,
  };
}

test('actual workerd/native SDK composes Gmail attachments and Drive bytes without host intermediates', async () => {
  const bytes = Buffer.from(Array.from({ length: 131072 }, (_, index) => index % 256));
  const uploads: ReturnType<typeof readMultipart>[] = [];
  const drafts: ReturnType<typeof attachment>[] = [];
  const outbound = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.includes('/discovery/') || url.pathname.includes('$discovery'))
      return json(url.pathname.includes('/drive/') ? docs.drive : docs.gmail);
    assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
    if (url.pathname.includes('/attachments/'))
      return json({ data: bytes.toString('base64url'), size: bytes.length });
    if (url.pathname === '/upload/drive/v3/files') {
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      uploads.push(
        readMultipart(
          Buffer.from(await request.arrayBuffer()),
          request.headers.get('content-type')!,
        ),
      );
      return json({ id: 'created-file', name: uploads.at(-1)!.metadata.name });
    }
    if (url.pathname === '/drive/v3/files/source')
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    if (url.pathname.endsWith('/drafts')) {
      const body = (await request.json()) as { message: { raw: string } };
      drafts.push(attachment(body.message.raw));
      return json({ id: 'created-draft' });
    }
    throw new Error('Unexpected fixture route');
  };
  const client = await openBuiltWorker({ artifacts: true, outbound });
  const inline = await openBuiltWorker({ outbound });
  try {
    const guide = await client.resource(MEDIA_SKILL_URI);
    assert.match((guide.contents[0] as { text: string }).text, /composeMime/);
    const upload = await client.tool<ExecutionReceipt>('execute', {
      accessToken: token,
      code: `
      const {data: body} = await google.gmail({version:'v1'}).users.messages.attachments.get({userId:'me',messageId:'source',id:'attachment'});
      const {data: uploaded} = await google.drive({version:'v3'}).files.create({requestBody:{name:'résumé 🌍.bin'.toUpperCase(),parents:['target-folder']},media:{mimeType:'application/octet-stream',body:{encoding:'base64url',data:body.data,size:body.size}},fields:'id,name'});
      return uploaded;
    `,
    });
    assert.equal(upload.status, 'completed', JSON.stringify(upload));
    assert.equal(upload.outcomesComplete, true);
    assert.equal(upload.hasUnknownOutcome, false);
    assert.equal(
      upload.outcomes.find((outcome) => outcome.path === 'drive/v3/files.create')?.resourceId,
      'created-file',
    );
    assert.deepEqual(uploads[0].metadata, { name: 'RÉSUMÉ 🌍.BIN', parents: ['target-folder'] });
    assert.deepEqual(uploads[0].bytes, bytes);
    assert.equal(uploads[0].headers, 'content-type: application/octet-stream');
    const stored = await client.tool<ExecutionReceipt<{ uri: string }>>('execute', {
      accessToken: token,
      code: `const {data:b}=await google.gmail({version:'v1'}).users.messages.attachments.get({userId:'me',messageId:'source',id:'attachment'});
      return artifacts.putBytes({encoding:'base64url',data:b.data,size:b.size,mimeType:'application/octet-stream'},{name:'stored.bin'});`,
    });
    assert.equal(stored.status, 'completed', JSON.stringify(stored));
    assert.equal(JSON.stringify(stored).includes(bytes.toString('base64')), false);
    const reused = await client.tool<ExecutionReceipt>('execute', {
      accessToken: token,
      inputs: { uri: stored.result.uri },
      code: `const body=await artifacts.readBytes(inputs.uri);
      const {data}=await google.drive({version:'v3'}).files.create({requestBody:{name:'stored-copy.bin'},media:{mimeType:body.mimeType,body}});
      await artifacts.delete(inputs.uri); return data;`,
    });
    assert.equal(reused.status, 'completed', JSON.stringify(reused));
    assert.equal(reused.hasUnknownOutcome, false);
    assert.deepEqual(uploads[1].bytes, bytes);
    assert.equal(uploads[1].metadata.name, 'stored-copy.bin');
    const draft = await inline.tool<ExecutionReceipt>('execute', {
      accessToken: token,
      code: `
      const {data: file} = await google.drive({version:'v3'}).files.get({fileId:'source',alt:'media'});
      const raw = await snippets.run('composeMime',{to:'recipient@example.test',subject:'Résumé 🌍',text:'Body',attachments:[{name:'résumé 🌍.bin',...file}]});
      return (await google.gmail({version:'v1'}).users.drafts.create({userId:'me',requestBody:{message:{raw}}})).data;
    `,
    });
    assert.equal(draft.status, 'completed', JSON.stringify(draft));
    assert.equal(draft.outcomes.length, 2, 'pure MIME helper adds no Google calls');
    assert.equal(draft.outcomesComplete, true);
    assert.equal(
      draft.outcomes.find((outcome) => outcome.path === 'gmail/v1/users.drafts.create')?.resourceId,
      'created-draft',
    );
    assert.deepEqual(drafts[0].bytes, bytes);
    assert.equal(drafts[0].name, 'résumé 🌍.bin');
    assert.match(drafts[0].headers, /Content-Type: application\/octet-stream/);
  } finally {
    await client.close();
    await inline.close();
  }
});

test('workerd keeps empty multipart bodies and acknowledged writes when their response is invalid', async () => {
  let calls = 0;
  let wire: Buffer | undefined;
  let contentType = '';
  const client = await openBuiltWorker({
    outbound: async (request) => {
      if (new URL(request.url).pathname.includes('/discovery/')) return json(docs.drive);
      calls++;
      wire = Buffer.from(await request.arrayBuffer());
      contentType = request.headers.get('content-type')!;
      return new Response('{broken', { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const result = await client.tool<ExecutionReceipt>('execute', {
      accessToken: token,
      code: `
      return (await google.drive({version:'v3'}).files.create({requestBody:{name:'empty.bin'},media:{mimeType:'application/octet-stream',body:{encoding:'base64',data:'',size:0}}})).data;
    `,
    });
    assert.equal(calls, 1);
    assert.equal(readMultipart(wire!, contentType).bytes.length, 0);
    assert.equal(result.outcomes[0].outcome, 'acknowledged');
    assert.equal(result.outcomes[0].httpStatus, 200);
  } finally {
    await client.close();
  }
});

test('trusted stored-reference helpers round-trip 256 KiB through native Gmail media and JSON attachment storage', async () => {
  const bytes = Buffer.from(Array.from({ length: 262144 }, (_, index) => index % 251));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let drafted: ReturnType<typeof attachment> | undefined;
  let uploads = 0;
  let attachmentMode = 'valid';
  let loseDraftResponse = false;
  const client = await openBuiltWorker({
    artifacts: true,
    outbound: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.includes('/discovery/') || url.pathname.includes('$discovery'))
        return json(url.pathname.includes('/drive/') ? docs.drive : docs.gmail);
      assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
      if (url.pathname === '/drive/v3/files/source')
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
      if (url.pathname === '/upload/gmail/v1/users/me/drafts') {
        assert.equal(url.searchParams.get('uploadType'), 'multipart');
        const wire = readMultipart(
          Buffer.from(await request.arrayBuffer()),
          request.headers.get('content-type')!,
        );
        assert.deepEqual(wire.metadata, {});
        assert.equal(wire.headers, 'content-type: message/rfc822');
        drafted = attachment(wire.bytes.toString('base64url'));
        assert.deepEqual(drafted.bytes, bytes);
        assert.equal(drafted.name, 'résumé 🌍.bin');
        assert.match(drafted.headers, /Content-Type: application\/octet-stream/);
        if (loseDraftResponse) throw new Error('Injected lost Gmail mutation response');
        return json({ id: 'owned-draft', message: { id: 'owned-message' } });
      }
      if (url.pathname.includes('/attachments/')) {
        if (attachmentMode === 'invalid') return json({ data: 'Zh==', size: 1 });
        if (attachmentMode === 'credential')
          return json({
            data: Buffer.from(token).toString('base64url'),
            size: Buffer.byteLength(token),
          });
        return json({ data: drafted!.bytes.toString('base64url'), size: bytes.length });
      }
      if (url.pathname === '/upload/drive/v3/files') {
        const wire = readMultipart(
          Buffer.from(await request.arrayBuffer()),
          request.headers.get('content-type')!,
        );
        assert.deepEqual(wire.bytes, bytes);
        assert.equal(wire.metadata.name, drafted!.name);
        assert.equal(wire.metadata.mimeType, 'application/octet-stream');
        uploads++;
        return json({ id: 'owned-copy' });
      }
      throw new Error('Unexpected fixture route');
    },
  });
  try {
    const capabilities = await client.tool<any>('describe', { path: 'artifacts' });
    assert.equal(capabilities.referenceMedia.maxAttachmentBytes, 1024 * 1024);
    const method = await client.tool<any>('describe', {
      path: 'gmail/v1/users.drafts.create',
      view: 'full',
    });
    assert.equal(method.runtime.mediaUpload, true);
    assert.equal(method.runtime.maxArtifactUploadBytes, 36700160);
    assert.match(method.declarations, /message\/rfc822/);
    const receipt = await client.tool<ExecutionReceipt<any> & { artifacts: any }>('execute', {
      accessToken: token,
      code: `const drive=google.drive({version:'v3'}),gmail=google.gmail({version:'v1'});
      const {data:source}=await drive.files.get({fileId:'source',alt:'media'});
      const mime=await artifacts.composeMime({to:'recipient@example.test',subject:'Résumé 🌍',text:'Body',attachments:[{artifact:source.uri,name:'résumé 🌍.bin',mimeType:source.mimeType}]});
      const {data:draft}=await gmail.users.drafts.create({userId:'me',requestBody:{},media:{mimeType:mime.mimeType,body:{artifact:mime.uri}}});
      const recovered=await artifacts.fromGmailAttachment({userId:'me',messageId:draft.message.id,id:'attachment'},{name:'résumé 🌍.bin',mimeType:'application/octet-stream'});
      const {data:copy}=await drive.files.create({requestBody:{name:recovered.name,mimeType:recovered.mimeType},media:{mimeType:recovered.mimeType,body:{artifact:recovered.uri}}});
      await artifacts.delete(source.uri);await artifacts.delete(mime.uri);await artifacts.delete(recovered.uri);
      return {draft,copy,recovered};`,
    });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    assert.equal(receipt.result.recovered.sha256, sha256);
    assert.equal(receipt.result.recovered.size, bytes.length);
    assert.equal(receipt.result.recovered.name, drafted!.name);
    assert.equal(receipt.hasUnknownOutcome, false);
    assert.equal(receipt.outcomesComplete, true);
    assert.equal(receipt.artifacts.hasUnknownOutcome, false);
    assert.deepEqual(
      receipt.outcomes.map((o) => o.outcome),
      Array(4).fill('acknowledged'),
    );
    assert.equal(uploads, 1);
    assert.equal(JSON.stringify(receipt).includes(bytes.toString('base64url')), false);
    assert.equal(
      (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
      0,
    );
    for (attachmentMode of ['invalid', 'credential']) {
      const failed = await client.tool<ExecutionReceipt & { artifacts: any }>('execute', {
        accessToken: token,
        code: `return artifacts.fromGmailAttachment({userId:'me',messageId:'owned-message',id:'attachment'},{name:'attachment.bin',mimeType:'application/octet-stream'});`,
      });
      assert.equal(failed.status, 'error');
      assert.equal(failed.outcomes[0].outcome, 'acknowledged');
      assert.equal(failed.artifacts.references.length, 0);
      assert.equal(JSON.stringify(failed).includes(token), false);
      assert.equal(
        (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
        0,
      );
    }
    loseDraftResponse = true;
    const lost = await client.tool<ExecutionReceipt>('execute', {
      accessToken: token,
      code: `const drive=google.drive({version:'v3'}),gmail=google.gmail({version:'v1'});
      const {data:source}=await drive.files.get({fileId:'source',alt:'media'});
      const mime=await artifacts.composeMime({to:'recipient@example.test',subject:'Lost response',text:'Body',attachments:[{artifact:source.uri,name:'résumé 🌍.bin',mimeType:source.mimeType}]});
      try { await gmail.users.drafts.create({userId:'me',requestBody:{},media:{mimeType:mime.mimeType,body:{artifact:mime.uri}}}); } catch {}
      try { await drive.files.create({requestBody:{name:'must-not-dispatch'}}); } catch {}
      await artifacts.delete(source.uri);await artifacts.delete(mime.uri);return true;`,
    });
    assert.equal(lost.hasUnknownOutcome, true);
    assert.deepEqual(
      lost.outcomes.map((o) => o.outcome),
      ['acknowledged', 'unknown', 'not_dispatched'],
    );
    assert.equal(uploads, 1, 'unknown Gmail mutation is not retried and blocks later mutations');
    assert.equal(
      (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
      0,
    );
  } finally {
    await client.close();
  }
});

// The fixture and receiver retain only chunks, headers and hashes, never a whole file.
const largeSize = 33 * 1024 * 1024 + 17;
function generatedMedia(size: number, failAfter = Infinity, credential = false) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= failAfter) {
        if (credential) {
          controller.enqueue(Buffer.from(token));
          controller.close();
        } else controller.error(new Error('Interrupted source'));
        return;
      }
      if (offset === size) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(65536, size - offset));
      for (let i = 0; i < chunk.length; i++) chunk[i] = (offset + i) % 251;
      offset += chunk.length;
      controller.enqueue(chunk);
    },
  });
}
async function streamHash(body: ReadableStream<Uint8Array>) {
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyLargeUpload(request: Request) {
  const boundary = /boundary=([A-Za-z0-9-]+)$/.exec(request.headers.get('content-type')!)![1];
  const prefix = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n{"name":"streamed-copy.bin"}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--`);
  const hash = createHash('sha256');
  let offset = 0;
  for await (const value of request.body!) {
    const chunk = Buffer.from(value);
    let cursor = 0;
    if (offset < prefix.length) {
      const count = Math.min(chunk.length, prefix.length - offset);
      assert.deepEqual(chunk.subarray(0, count), prefix.subarray(offset, offset + count));
      cursor += count;
      offset += count;
    }
    if (offset < prefix.length + largeSize) {
      const count = Math.min(chunk.length - cursor, prefix.length + largeSize - offset);
      hash.update(chunk.subarray(cursor, cursor + count));
      cursor += count;
      offset += count;
    }
    if (cursor < chunk.length) {
      const start = offset - prefix.length - largeSize;
      assert.deepEqual(
        chunk.subarray(cursor),
        footer.subarray(start, start + chunk.length - cursor),
      );
      offset += chunk.length - cursor;
    }
  }
  assert.equal(offset, prefix.length + largeSize + footer.length);
  assert.equal(request.headers.get('content-length'), String(offset));
  return hash.digest('hex');
}

test('native SDK streams 33 MiB through R2 references with known and unknown lengths', async () => {
  const expected = await streamHash(generatedMedia(largeSize));
  let uploaded = 0;
  let uploadError: unknown;
  const client = await openBuiltWorker({
    artifacts: true,
    outbound: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.includes('/discovery/')) return json(docs.drive);
      assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
      if (request.method === 'GET') {
        assert.equal(request.headers.get('accept-encoding'), 'identity');
        return new Response(generatedMedia(largeSize), {
          headers: {
            'content-type': 'application/octet-stream',
            ...(url.pathname.endsWith('/known') ? { 'content-length': String(largeSize) } : {}),
          },
        });
      }
      try {
        assert.equal(await verifyLargeUpload(request), expected);
      } catch (error) {
        uploadError = error;
        throw error;
      }
      uploaded++;
      return json({ id: 'uploaded-' + uploaded });
    },
  });
  try {
    const description = await client.tool<{
      runtime: { mediaResult: string; maxDownloadBytes: number };
      declarations: string;
    }>('describe', { path: 'drive/v3/files.get', view: 'full' });
    assert.equal(description.runtime.mediaResult, 'artifact-reference');
    assert.match(description.declarations, /GoogleMediaArtifact/);
    for (const id of ['known', 'unknown']) {
      const receipt = await client.tool<
        ExecutionReceipt<{
          file: { uri: string; sha256: string; size: number };
          copy: { id: string };
        }> & { artifacts: { outcomes: { outcome: string }[]; references: unknown[] } }
      >('execute', {
        accessToken: token,
        inputs: { id },
        code: `
          const drive=google.drive({version:'v3'});
          const {data:file}=await drive.files.get({fileId:inputs.id,alt:'media'});
          const {data:copy}=await drive.files.create({requestBody:{name:'streamed-copy.bin'},media:{mimeType:file.mimeType,body:{artifact:file.uri}}});
          return {file,copy};`,
      });
      assert.ifError(uploadError);
      assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
      assert.equal(receipt.result.file.size, largeSize);
      assert.equal(receipt.result.file.sha256, expected);
      assert.deepEqual(
        receipt.artifacts.outcomes.map((item) => item.outcome),
        ['stored', 'read'],
      );
      assert.equal(receipt.artifacts.references.length, 1);
      assert.ok(JSON.stringify(receipt).length < 6000, 'bridge/MCP receipt contains metadata only');
      const resource = await client.resource(receipt.result.file.uri);
      assert.equal(JSON.parse((resource.contents[0] as { text: string }).text).sha256, expected);
      const cleanup = await client.tool<ExecutionReceipt>('execute', {
        accessToken: token,
        inputs: { uri: receipt.result.file.uri },
        code: 'await artifacts.delete(inputs.uri); return true;',
      });
      assert.equal(cleanup.status, 'completed', JSON.stringify(cleanup));
      assert.equal(
        (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
        0,
      );
    }
    assert.equal(uploaded, 2);
  } finally {
    await client.close();
  }
});

test('interrupted stored media cleans partial R2 writes and never replays uncertain uploads', async () => {
  let uploads = 0;
  const client = await openBuiltWorker({
    artifacts: true,
    outbound: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.includes('/discovery/')) return json(docs.drive);
      if (request.method === 'GET')
        return new Response(
          generatedMedia(
            largeSize,
            url.pathname.endsWith('/broken') ? 6 * 1024 * 1024 : Infinity,
            true,
          ),
          {
            headers: {
              'content-type': 'application/octet-stream',
            },
          },
        );
      uploads++;
      await streamHash(request.body!);
      throw new TypeError('Upload response lost');
    },
  });
  try {
    // Miniflare's RPC proxy uses Node Headers in its declarations; R2 wire API is identical.
    const adapter = createR2Storage(client.artifactBucket! as unknown as R2Bucket);
    await assert.rejects(
      adapter.write('artifacts/v2/source-error', generatedMedia(largeSize, 6 * 1024 * 1024)),
      /Interrupted source/,
    );
    assert.equal(
      (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
      0,
    );
    const failed = await client.tool<
      ExecutionReceipt & {
        artifacts: { outcomes: { outcome: string; cleanup?: string }[]; references: unknown[] };
      }
    >('execute', {
      accessToken: token,
      code: "return (await google.drive({version:'v3'}).files.get({fileId:'broken',alt:'media'})).data;",
    });
    assert.equal(failed.status, 'error');
    assert.equal(failed.outcomes[0].outcome, 'acknowledged');
    assert.equal(failed.artifacts.outcomes[0].outcome, 'unknown');
    assert.equal(failed.artifacts.references.length, 0);
    assert.equal(
      (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
      0,
    );
    const interrupted = await client.tool<ExecutionReceipt<{ uri: string }>>('execute', {
      accessToken: token,
      code: `
      const drive=google.drive({version:'v3'});
      const {data:file}=await drive.files.get({fileId:'source',alt:'media'});
      try { await drive.files.create({requestBody:{name:'streamed-copy.bin'},media:{mimeType:file.mimeType,body:{artifact:file.uri}}}); } catch {}
      try { await drive.files.create({requestBody:{name:'must-not-run'}}); } catch {}
      return {uri:file.uri};`,
    });
    assert.equal(interrupted.hasUnknownOutcome, true);
    assert.deepEqual(
      interrupted.outcomes.map((item) => item.outcome),
      ['acknowledged', 'unknown', 'not_dispatched'],
    );
    assert.equal(uploads, 1);
    const cleanup = await client.tool<ExecutionReceipt>('execute', {
      accessToken: token,
      inputs: interrupted.result,
      code: 'return artifacts.delete(inputs.uri);',
    });
    assert.equal(cleanup.status, 'completed');
    assert.equal(
      (await client.artifactBucket!.list({ prefix: 'artifacts/v2/' })).objects.length,
      0,
    );
  } finally {
    await client.close();
  }
});
