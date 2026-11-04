import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBuiltWorker } from '../worker-client.ts';

const MCP_VERSION = '2026-07-28';
const MAX_RESPONSE_BYTES = 524288;
export interface HostedConfiguration {
  endpoint: string;
  candidateDigest: string;
  workerVersion: string;
  accessHeaders: Record<string, string>;
}

export function hostedConfiguration(env: NodeJS.ProcessEnv = process.env): HostedConfiguration {
  const required = (name: string) => {
    if (!env[name]) throw new Error(`Missing ${name}`);
    return env[name]!;
  };
  const endpoint = new URL(required('HOSTED_VERIFICATION_URL'));
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== '/mcp' ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Hosted evaluation requires a credential-free HTTPS /mcp endpoint');
  const candidateDigest = required('HOSTED_EXPECTED_CANDIDATE_DIGEST');
  const workerVersion = required('HOSTED_EXPECTED_WORKER_VERSION');
  if (!/^[a-f0-9]{64}$/.test(candidateDigest) || !/^[A-Za-z0-9_-]{1,128}$/.test(workerVersion))
    throw new Error('Invalid expected hosted candidate identity');
  let values: unknown;
  try {
    values = JSON.parse(required('HOSTED_ACCESS_HEADERS_JSON'));
  } catch {
    throw new Error('Invalid private hosted Access headers');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('Expected the standard private Access header pair');
  const entries = Object.entries(values);
  const allowed = ['cf-access-client-id', 'cf-access-client-secret'];
  if (
    entries.length !== 2 ||
    new Set(entries.map(([key]) => key.toLowerCase())).size !== 2 ||
    entries.some(
      ([key, value]) =>
        !allowed.includes(key.toLowerCase()) ||
        typeof value !== 'string' ||
        !value.trim() ||
        /[\r\n]/.test(value),
    )
  )
    throw new Error('Expected only the standard private Access header pair');
  return {
    endpoint: endpoint.href,
    candidateDigest,
    workerVersion,
    accessHeaders: Object.fromEntries(entries),
  };
}

async function boundedText(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Hosted response exceeds evaluation limit');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Trusted transport. No Access credential or response cookie reaches the actor. */
export async function createHostedBackend(
  configuration: HostedConfiguration,
  options: {
    output: string;
    transport?: typeof fetch;
  },
) {
  const transport = options.transport ?? fetch;
  const send = async (request: Request, authenticated = true) => {
    const headers = new Headers();
    for (const name of [
      'content-type',
      'accept',
      'mcp-protocol-version',
      'mcp-method',
      'mcp-name',
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (authenticated)
      for (const [key, value] of Object.entries(configuration.accessHeaders))
        headers.set(key, value);
    return transport(configuration.endpoint, {
      method: 'POST',
      headers,
      body: await request.text(),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  };
  const dispatch = async (request: Request) => {
    const response = await send(request);
    if (
      response.headers.get('x-candidate-digest') !== configuration.candidateDigest ||
      response.headers.get('x-worker-version') !== configuration.workerVersion
    ) {
      await response.body?.cancel();
      throw new Error('Hosted candidate identity mismatch');
    }
    if (
      response.headers.has('mcp-session-id') ||
      !response.headers.get('content-type')?.includes('application/json')
    ) {
      await response.body?.cancel();
      throw new Error('Expected finite sessionless hosted JSON');
    }
    const text = await boundedText(response);
    try {
      JSON.parse(text);
    } catch {
      throw new Error('Invalid hosted JSON response');
    }
    return new Response(text, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const root = () =>
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MCP_VERSION,
        'MCP-Method': 'tools/call',
        'MCP-Name': 'describe',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'tools/call',
        params: {
          name: 'describe',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
  const denied = await send(root(), false);
  const deniedStatus = denied.status;
  await denied.body?.cancel();
  if (![401, 403].includes(deniedStatus))
    throw new Error('Hosted endpoint did not deny missing Access credentials');
  const admitted = await dispatch(root());
  const rpc = (await admitted.json()) as any;
  if (
    !admitted.ok ||
    rpc.error ||
    rpc.result?.isError ||
    !Array.isArray(rpc.result?.structuredContent?.services)
  )
    throw new Error('Hosted product root discovery preflight failed');
  const identity = {
    kind: 'hosted',
    endpoint: configuration.endpoint,
    candidateDigest: configuration.candidateDigest,
    workerVersion: configuration.workerVersion,
  };
  await writeFile(
    join(options.output, 'hosted-preflight.json'),
    JSON.stringify(
      {
        ...identity,
        checkedAt: new Date().toISOString(),
        missingAccessStatus: deniedStatus,
        authenticatedStatus: admitted.status,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return {
    identity,
    dispatch,
    secrets: Object.values(configuration.accessHeaders),
    async close() {},
  };
}

export async function createEvaluationBackend(output: string) {
  const backend = process.env.EVAL_BACKEND || 'local';
  if (backend === 'hosted') return createHostedBackend(hostedConfiguration(), { output });
  if (backend !== 'local') throw new Error('Select local or hosted evaluation backend');
  const bundleSha256 = createHash('sha256')
    .update(await readFile('dist/worker.js'))
    .digest('hex');
  const worker = await createBuiltWorker();
  return {
    identity: { kind: 'local', bundleSha256 },
    secrets: [] as string[],
    async dispatch(request: Request) {
      const response = await worker.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (
        response.headers.has('mcp-session-id') ||
        !response.headers.get('content-type')?.includes('application/json')
      )
        throw new Error('Expected finite sessionless JSON');
      return response as unknown as Response;
    },
    async close() {
      await worker.dispose();
    },
  };
}
