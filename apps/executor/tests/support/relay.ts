import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResponsesHandler } from '../eval/responses-relay.ts';

export async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
export async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

/** Synthetic upstream only; payload and response policy stay in each test. */
export async function responsesHarness(
  respond: (body: any, response: ServerResponse, request: IncomingMessage) => unknown,
  payload: any,
  nativeCodex = false,
) {
  const output = await mkdtemp(join(tmpdir(), 'responses-relay-'));
  const upstream: any[] = [];
  const proxy = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    upstream.push({ body, headers: request.headers });
    await respond(body, response, request);
  });
  const proxyUrl = await listen(proxy);
  const receipts: any[] = [];
  const handler = createResponsesHandler({
    proxyUrl,
    proxyKey: 'private-proxy-key',
    model: payload.model,
    output,
    receipts,
    redact: (text) => text.replaceAll('private-proxy-key', '[proxy-key]'),
    allowedToolNames: () => ['describe'],
    nativeCodex,
  });
  const relay = createServer(async (request, response) => {
    try {
      await handler.handle(request, response);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }));
    }
  });
  const url = await listen(relay);
  return {
    output,
    upstream,
    receipts,
    handler,
    invoke: (body: any = payload, key = 'local-eval-relay') =>
      fetch(`${url}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }),
    async close() {
      handler.abort();
      await Promise.all([closeServer(relay), closeServer(proxy)]);
      await rm(output, { recursive: true, force: true });
    },
  };
}
