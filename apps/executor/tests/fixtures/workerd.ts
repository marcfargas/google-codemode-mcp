import type { DiscoveryDocument } from '../../src/discovery.ts';
import { DiscoveryCatalog } from '../../src/discovery.ts';
import { executeProgram, createExecutor } from '../../src/runtime.ts';
import { validateSnippets, bundledSnippets } from '../../src/snippets.ts';
import { handleMcp } from '../../src/protocol.ts';
import type { ExecutionArguments, SnippetArguments } from '../../src/runtime.ts';

const document: DiscoveryDocument = {
  kind: 'discovery#restDescription',
  discoveryVersion: 'v1',
  id: 'gmail:v1',
  name: 'gmail',
  version: 'v1',
  revision: 'test-revision',
  title: 'Gmail API',
  description: 'Test Discovery',
  protocol: 'rest',
  rootUrl: 'https://gmail.googleapis.com/',
  servicePath: '',
  baseUrl: 'https://gmail.googleapis.com/',
  parameters: { fields: { type: 'string', location: 'query' } },
  schemas: {
    Message: { type: 'object', properties: { raw: { type: 'string' }, id: { type: 'string' } } },
    ListMessagesResponse: {
      type: 'object',
      properties: {
        messages: { type: 'array', items: { $ref: 'Message' } },
        nextPageToken: { type: 'string' },
      },
    },
  },
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            list: {
              id: 'gmail.users.messages.list',
              path: 'gmail/v1/users/{userId}/messages',
              httpMethod: 'GET',
              parameters: {
                userId: { type: 'string', required: true, location: 'path' },
                q: { type: 'string', location: 'query' },
                maxResults: { type: 'integer', location: 'query' },
                labelIds: { type: 'string', repeated: true, location: 'query' },
                pageToken: { type: 'string', location: 'query' },
              },
              response: { $ref: 'ListMessagesResponse' },
              scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            },
            send: {
              id: 'gmail.users.messages.send',
              path: 'gmail/v1/users/{userId}/messages/send',
              httpMethod: 'POST',
              parameters: { userId: { type: 'string', required: true, location: 'path' } },
              request: { $ref: 'Message' },
              response: { $ref: 'Message' },
              scopes: ['https://www.googleapis.com/auth/gmail.send'],
            },
            delete: {
              id: 'gmail.users.messages.delete',
              path: 'gmail/v1/users/{userId}/messages/{id}',
              httpMethod: 'DELETE',
              parameters: {
                userId: { type: 'string', required: true, location: 'path' },
                id: { type: 'string', required: true, location: 'path' },
              },
              scopes: ['https://www.googleapis.com/auth/gmail.modify'],
            },
          },
        },
      },
    },
  },
};
// Reduced native Drive Discovery; transport-option refusals run through the
// same isolated executor and dispatcher as the Gmail fixture above.
const driveDocument: DiscoveryDocument = {
  name: 'drive',
  version: 'v3',
  revision: 'fixture-drive-20261102',
  rootUrl: 'https://www.googleapis.com/',
  servicePath: 'drive/v3/',
  parameters: { fields: { type: 'string', location: 'query' } },
  schemas: {
    File: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
  },
  resources: {
    files: {
      methods: {
        list: {
          path: 'files',
          httpMethod: 'GET',
          parameters: {
            q: { type: 'string', location: 'query' },
            pageSize: { type: 'integer', location: 'query' },
            pageToken: { type: 'string', location: 'query' },
          },
          response: { type: 'object' },
        },
        get: {
          path: 'files/{fileId}',
          httpMethod: 'GET',
          parameters: { fileId: { type: 'string', required: true, location: 'path' } },
          response: { $ref: 'File' },
        },
        update: {
          path: 'files/{fileId}',
          httpMethod: 'PATCH',
          parameters: { fileId: { type: 'string', required: true, location: 'path' } },
          request: { $ref: 'File' },
          response: { $ref: 'File' },
        },
      },
    },
  },
};
const snippets = validateSnippets(bundledSnippets);
export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader }) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const url = new URL(request.url);
    const transport: typeof fetch = async (input, init) => {
      const target = String(input);
      calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body });
      if (new Headers(init?.headers).get('Authorization') !== 'Bearer TOKEN_CANARY_77881')
        throw new Error('Missing token');
      if (url.searchParams.has('lost') && init?.method === 'POST')
        throw new TypeError('connection lost TOKEN_CANARY_77881');
      if (url.searchParams.has('slow') && init?.method === 'POST')
        await new Promise((resolve) => setTimeout(resolve, 200));
      if (url.searchParams.has('reject'))
        return Response.json(
          { error: { message: 'bad TOKEN_CANARY_77881', errors: [{ reason: 'forbidden' }] } },
          { status: 403 },
        );
      if (url.searchParams.has('pages')) {
        const pages = JSON.parse(url.searchParams.get('pages')!) as any[];
        const page = pages[calls.length - 1];
        if (page?.fixtureError)
          return Response.json({ error: { message: 'fixture rejected page' } }, { status: 403 });
        return Response.json(page ?? {});
      }
      if (new URL(target).pathname === '/drive/v3/files')
        return Response.json({
          files: [{ id: 'native-owned' }],
          nextPageToken: 'native+/=',
          incompleteSearch: false,
        });
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(
            init?.method === 'POST'
              ? { id: 'sent-id' }
              : { messages: [], nextPageToken: 'empty-page-continues' },
          );
    };
    const catalog = new DiscoveryCatalog({
      documents: { 'gmail/v1': document, 'drive/v3': driveDocument },
    });
    const executor = createExecutor(env.LOADER, {
      timeoutMs: url.searchParams.has('timeout') ? 40 : undefined,
    });
    const execute = (args: ExecutionArguments, snippetName?: string) =>
      executeProgram({ args, catalog, snippets, executor, transport, snippetName });
    if (url.pathname === '/mcp')
      return handleMcp(request, {
        snippets,
        describe: async (args: { path?: string }) => catalog.describe(args.path),
        execute,
        runSnippet: async (name: string, args: SnippetArguments) =>
          execute({ ...args, code: snippets.find((s) => s.name === name)!.code }, name),
      });
    const args = (await request.json()) as ExecutionArguments & { snippetName?: string };
    return Response.json({ execution: await execute(args, args.snippetName), calls });
  },
};
