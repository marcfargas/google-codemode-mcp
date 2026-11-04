import { createServer, type IncomingMessage } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createResponsesHandler } from './responses-relay.ts';

export const TOKEN_SENTINEL = 'injected-by-eval-caller';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 262_144) throw new Error('Request exceeds evaluation input limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface McpEvent {
  method: string;
  params: any;
  status: number;
  response: any;
}

export async function startEvalServer(options: {
  dispatch: (request: Request) => Promise<Response>;
  accessToken: string;
  proxyUrl: string;
  proxyKey: string;
  model: string;
  output: string;
  runner?: 'claude' | 'responses';
}) {
  const audit: McpEvent[] = [];
  const llm: any[] = [];
  let unknownMutation = false;
  let stopped = false;
  let requests = 0;
  let outputTokens = 0;
  let active = false;
  let executing = false;
  let handlers = 0;
  const drained: (() => void)[] = [];
  const controllers = new Set<AbortController>();
  let closing: Promise<void> | undefined;
  const redact = (value: string) =>
    value
      .replaceAll(options.accessToken, '[google-token]')
      .replaceAll(options.proxyKey, '[proxy-key]');
  const responses =
    options.runner === 'responses'
      ? createResponsesHandler({
          ...options,
          receipts: llm,
          redact,
          allowedToolNames: () => [
            'Read',
            'Write',
            'ListMcpResourcesTool',
            'ReadMcpResourceTool',
            ...audit.flatMap((event) =>
              event.method === 'tools/list'
                ? (event.response.result?.tools ?? []).map(
                    (tool: any) => `mcp__google__${tool.name}`,
                  )
                : [],
            ),
          ],
        })
      : undefined;
  const server = createServer(async (request, response) => {
    handlers++;
    let ownsExecution = false;
    let pendingMcp: McpEvent | undefined;
    try {
      if (stopped) throw new Error('Evaluation execution closed');
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (path === '/mcp' && request.method === 'POST') {
        const rpc = JSON.parse(await body(request));
        if (stopped) throw new Error('Evaluation execution closed');
        const original = structuredClone(rpc.params ?? {});
        const execution = rpc.method === 'tools/call' && rpc.params?.name !== 'describe';
        if (execution) {
          if (unknownMutation) throw new Error('An earlier mutation has an unknown outcome');
          if (executing) throw new Error('Evaluation permits only one execution at a time');
          const args = rpc.params.arguments;
          if (args?.accessToken !== TOKEN_SENTINEL)
            throw new Error('Use the trusted caller token placeholder');
          args.accessToken = options.accessToken;
          executing = true;
          ownsExecution = true;
        }
        pendingMcp = {
          method: rpc.method,
          params: original,
          status: 0,
          response: { pending: true },
        };
        audit.push(pendingMcp);
        await appendFile(
          join(options.output, 'mcp-attempts.jsonl'),
          JSON.stringify(pendingMcp) + '\n',
          { mode: 0o600 },
        );
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            typeof value === 'string' &&
            !['host', 'content-length', 'connection', 'authorization'].includes(name)
          )
            headers[name] = value;
        }
        const result = await options.dispatch(
          new Request('http://localhost/mcp', {
            method: 'POST',
            headers,
            body: JSON.stringify(rpc),
          }),
        );
        const text = redact(await result.text());
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { invalidJson: true };
          if (execution) unknownMutation = true;
        }
        const receipt = parsed.result?.structuredContent;
        if (
          execution &&
          (!Array.isArray(receipt?.outcomes) || typeof receipt?.hasUnknownOutcome !== 'boolean')
        )
          unknownMutation = true;
        if (
          receipt?.hasUnknownOutcome ||
          receipt?.outcomes?.some(
            (outcome: any) => outcome.mutation && outcome.outcome === 'unknown',
          )
        )
          unknownMutation = true;
        Object.assign(pendingMcp, { status: result.status, response: parsed });
        await appendFile(join(options.output, 'mcp.jsonl'), JSON.stringify(pendingMcp) + '\n', {
          mode: 0o600,
        });
        const responseHeaders = new Headers(result.headers);
        responseHeaders.delete('content-length');
        response.writeHead(result.status, Object.fromEntries(responseHeaders));
        response.end(text);
        return;
      }
      if (path === '/mcp') {
        response.writeHead(405);
        response.end();
        return;
      }
      if (
        path === '/llm/v1/responses' &&
        request.method === 'POST' &&
        options.runner === 'responses'
      ) {
        await responses!.handle(request, response);
        return;
      }
      if (
        path !== '/llm/v1/messages' ||
        request.method !== 'POST' ||
        options.runner === 'responses'
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (
        request.headers['x-api-key'] !== 'local-eval-relay' &&
        request.headers.authorization !== 'Bearer local-eval-relay'
      )
        throw new Error('Invalid local model credential');
      const payload = JSON.parse(await body(request));
      if (payload.model !== options.model)
        throw new Error('Unexpected requested model; fallback is disabled');
      if (stopped || active || requests >= 18 || outputTokens >= 15_000)
        throw new Error('Evaluation model request/token ceiling reached');
      requests++;
      payload.max_tokens = Math.min(payload.max_tokens ?? 2048, 2048, 15_000 - outputTokens);
      active = true;
      outputTokens += payload.max_tokens;
      const controller = new AbortController();
      controllers.add(controller);
      const record: any = {
        request: requests,
        startedAt: new Date().toISOString(),
        requestedModel: payload.model,
        inputBytes: Buffer.byteLength(JSON.stringify(payload)),
        systemHash: hash(JSON.stringify(payload.system ?? null)),
        toolsHash: hash(JSON.stringify(payload.tools ?? [])),
        maxTokens: payload.max_tokens,
      };
      llm.push(record);
      await appendFile(
        join(options.output, 'model-requests.jsonl'),
        JSON.stringify({ ...record, payload }) + '\n',
        { mode: 0o600 },
      );
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-api-key': options.proxyKey,
          'anthropic-version': String(request.headers['anthropic-version'] ?? '2023-06-01'),
        };
        if (request.headers['anthropic-beta'])
          headers['anthropic-beta'] = String(request.headers['anthropic-beta']);
        const upstream = await fetch(options.proxyUrl.replace(/\/$/, '') + '/v1/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
          redirect: 'error',
        });
        const text = redact(await upstream.text());
        record.status = upstream.status;
        record.finishedAt = new Date().toISOString();
        const streaming = upstream.headers.get('content-type')?.includes('text/event-stream');
        const events = streaming
          ? text
              .split('\n')
              .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
              .flatMap((line) => {
                try {
                  return [JSON.parse(line.slice(6))];
                } catch {
                  return [];
                }
              })
          : [JSON.parse(text)];
        record.servedModels = [
          ...new Set(events.flatMap((event: any) => event.message?.model ?? event.model ?? [])),
        ];
        record.usageEvents = events.flatMap(
          (event: any) => event.message?.usage ?? event.usage ?? [],
        );
        const outputs = events.flatMap((event: any) => {
          const value =
            !streaming || event.type === 'message_delta' ? event.usage?.output_tokens : undefined;
          return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [value] : [];
        });
        record.complete =
          upstream.ok &&
          (streaming
            ? events.some((event: any) => event.type === 'message_stop')
            : events.some((event: any) => event.stop_reason));
        if (record.complete && outputs.length)
          outputTokens -= payload.max_tokens - Math.min(payload.max_tokens, Math.max(...outputs));
        record.totalOutputTokensOrUpperBound = outputTokens;
        await appendFile(
          join(options.output, 'model-receipts.jsonl'),
          JSON.stringify(record) + '\n',
          { mode: 0o600 },
        );
        response.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        });
        response.end(text);
      } catch {
        record.error = 'upstream_failure';
        record.complete = false;
        record.totalOutputTokensOrUpperBound = outputTokens;
        await appendFile(
          join(options.output, 'model-receipts.jsonl'),
          JSON.stringify(record) + '\n',
          { mode: 0o600 },
        );
        throw new Error('Model proxy request failed; no retry');
      } finally {
        active = false;
        controllers.delete(controller);
      }
    } catch (error) {
      if (ownsExecution) unknownMutation = true;
      if (pendingMcp) {
        Object.assign(pendingMcp, {
          status: 502,
          response: { error: 'Outer dispatch or receipt failed', outerUnknown: ownsExecution },
        });
        await appendFile(join(options.output, 'mcp.jsonl'), JSON.stringify(pendingMcp) + '\n', {
          mode: 0o600,
        });
      }
      await appendFile(
        join(options.output, 'relay-errors.jsonl'),
        JSON.stringify({
          path: request.url,
          message: redact(error instanceof Error ? error.message : 'Evaluation request failed'),
          at: new Date().toISOString(),
        }) + '\n',
        { mode: 0o600 },
      );
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            type: 'evaluation_error',
            message: error instanceof Error ? error.message : 'Evaluation request failed',
          },
        }),
      );
    } finally {
      if (ownsExecution) executing = false;
      if (--handlers === 0) for (const resolve of drained.splice(0)) resolve();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    audit,
    llm,
    get hasUnknownMutation() {
      return unknownMutation;
    },
    async close() {
      closing ??= (async () => {
        stopped = true;
        responses?.abort();
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        if (handlers) await new Promise<void>((resolve) => drained.push(resolve));
      })();
      await closing;
    },
  };
}
