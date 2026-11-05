import { readMultipart } from '../support/multipart.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
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
  const client = await openBuiltWorker({
    outbound: async (request) => {
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
    },
  });
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
    const draft = await client.tool<ExecutionReceipt>('execute', {
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
