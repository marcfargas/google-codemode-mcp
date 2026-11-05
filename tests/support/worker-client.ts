import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';

export interface ExecutionReceipt<T = unknown> {
  status: 'completed' | 'error';
  result: T;
  hasUnknownOutcome: boolean;
  outcomesComplete: boolean;
  outcomes: {
    path: string;
    mutation: boolean;
    outcome: 'acknowledged' | 'rejected' | 'unknown' | 'not_dispatched';
    httpStatus?: number;
    resourceId?: string;
    mutationFields?: string[];
  }[];
  discovery: { service: string; version: string; source: string; revision: string }[] | null;
}

/** Exercise the deployed bundle locally; parent Worker egress interception is opt-in. */
export interface BuiltWorkerOptions {
  outbound?: (request: Request) => Promise<Response>;
  artifacts?: boolean;
  persistencePath?: string;
  bundle?: string;
}
export async function createBuiltWorker(options: BuiltWorkerOptions = {}) {
  const bundle = options.bundle ?? (await readFile('dist/worker.js', 'utf8'));
  return new Miniflare({
    ...(options.persistencePath ? { resourcePersistencePath: options.persistencePath } : {}),
    workers: [
      {
        config: {
          name: 'live-gmail-verification',
          compatibilityDate: '2026-07-28',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'worker.js',
            modulesRoot: '/',
            modules: { 'worker.js': { type: 'esm', contents: bundle } },
          },
          env: {
            LOADER: { type: 'worker-loader' },
            ...(options.artifacts
              ? { ARTIFACTS: { type: 'r2' as const, name: 'test-artifacts' } }
              : {}),
          },
        },
        ...(options.outbound
          ? {
              dev: {
                outboundService: {
                  type: 'fetcher' as const,
                  handler: async (request: import('miniflare').Request) => {
                    const translated = new Request(request.url, {
                      method: request.method,
                      headers: Object.fromEntries(request.headers),
                      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
                      duplex: 'half',
                      signal: request.signal,
                      redirect: 'manual',
                    } as RequestInit);
                    const response = await options.outbound!(translated);
                    return new MiniflareResponse(
                      response.body as ConstructorParameters<typeof MiniflareResponse>[0],
                      {
                        status: response.status,
                        statusText: response.statusText,
                        headers: Object.fromEntries(response.headers),
                      },
                    );
                  },
                },
              },
            }
          : {}),
      },
    ],
  });
}

export async function openBuiltWorker(options: BuiltWorkerOptions = {}) {
  const worker = await createBuiltWorker(options);
  const client = new Client(
    { name: 'live-gmail-verification', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => {
      const request = new Request(input, init as RequestInit);
      const response = await worker.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (
        response.headers.has('mcp-session-id') ||
        !response.headers.get('content-type')?.includes('application/json')
      ) {
        throw new Error('Live verification requires finite sessionless JSON responses');
      }
      return response as unknown as Response;
    },
  });
  try {
    await client.connect(transport);
  } catch {
    await worker.dispose();
    throw new Error('Built Worker MCP connection failed; remote diagnostics suppressed');
  }
  return {
    async resource(uri: string) {
      return client.readResource({ uri });
    },
    async resourceTemplates() {
      return client.listResourceTemplates();
    },
    async resources() {
      return client.listResources();
    },
    async toolResult(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: args });
    },
    async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      try {
        const response = await client.callTool({ name, arguments: args });
        if (response.isError || !response.structuredContent) throw new Error();
        return response.structuredContent as T;
      } catch {
        // SDK errors can embed requests, credentials or mailbox contents.
        throw new Error('Live MCP tool failed; remote diagnostics suppressed');
      }
    },
    async close() {
      try {
        await client.close();
      } finally {
        await worker.dispose();
      }
    },
  };
}
