import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Miniflare } from 'miniflare';

export interface ExecutionReceipt<T = unknown> {
  status: 'completed' | 'error';
  result: T;
  hasUnknownOutcome: boolean;
  outcomes: {
    path: string;
    mutation: boolean;
    outcome: 'acknowledged' | 'rejected' | 'unknown' | 'not_dispatched';
    httpStatus?: number;
  }[];
  discovery: { service: string; version: string; source: string; revision: string } | null;
}

/** Exercise the deployed bundle locally; Google outbound traffic is not mocked. */
export async function createBuiltWorker() {
  const bundle = await readFile('dist/worker.js', 'utf8');
  return new Miniflare({
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
          env: { LOADER: { type: 'worker-loader' } },
        },
      },
    ],
  });
}

export async function openBuiltWorker() {
  const worker = await createBuiltWorker();
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
