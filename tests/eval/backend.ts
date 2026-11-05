import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBuiltWorker } from '../support/worker-client.ts';
import { responseText } from '../support/io.ts';
import type { ArtifactReference } from '../../src/artifacts.ts';

export interface ArtifactObservation {
  complete: boolean;
  errors: string[];
  residualObjects: number;
  snapshots: { reference: ArtifactReference; base64: string; unavailableAfter: boolean }[];
}
import { createOutboundRecorder, type OutboundEvidence } from './outbound.ts';

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
    const text = await responseText(
      response,
      MAX_RESPONSE_BYTES,
      'Hosted response exceeds evaluation limit',
    );
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
    hasUnknownMutation: false,
    artifacts: undefined,
    async finishObservation() {
      return null;
    },
    async close() {},
  };
}

export async function createEvaluationBackend(
  output: string,
  options: { captureOutbound?: boolean; artifacts?: boolean } = {},
) {
  const backend = process.env.EVAL_BACKEND || 'local';
  if (backend === 'hosted') {
    if (options.artifacts) throw new Error('Hosted artifact evaluation is not qualified');
    return createHostedBackend(hostedConfiguration(), { output });
  }
  if (backend !== 'local') throw new Error('Select local or hosted evaluation backend');
  const bundleSha256 = createHash('sha256')
    .update(await readFile('dist/worker.js'))
    .digest('hex');
  const retain = (evidence: unknown) =>
    writeFile(join(output, 'product-outbound.json'), JSON.stringify(evidence, null, 2) + '\n', {
      mode: 0o600,
    });
  const recorder = options.captureOutbound
    ? createOutboundRecorder({ onEvent: retain })
    : undefined;
  const worker = await createBuiltWorker({
    outbound: recorder?.handler,
    artifacts: options.artifacts,
  });
  const send = async (rpc: unknown) => {
    const response = await worker.dispatchFetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MCP_VERSION,
        'MCP-Method': (rpc as any).method,
        'MCP-Name': (rpc as any).params.uri,
      },
      body: JSON.stringify({
        ...(rpc as object),
        params: {
          ...(rpc as any).params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    return response.json();
  };
  const bucket = options.artifacts ? await worker.getR2Bucket('ARTIFACTS') : undefined;
  const artifacts: ArtifactObservation | undefined = bucket
    ? { complete: false, errors: [], residualObjects: 0, snapshots: [] }
    : undefined;
  async function snapshot(reply: any) {
    const ledger = reply.result?.structuredContent?.artifacts;
    if (
      !ledger ||
      ledger.outcomesComplete !== true ||
      ledger.hasUnknownOutcome !== false ||
      !Array.isArray(ledger.outcomes) ||
      !Array.isArray(ledger.references)
    ) {
      artifacts!.errors.push('artifact_ledger_invalid');
      return;
    }
    for (const outcome of ledger.outcomes) {
      if (outcome?.outcome !== 'stored') continue;
      const ref = outcome.reference;
      try {
        if (!/^artifact:\/\/google-codemode-mcp\/v1\/[A-Za-z0-9_-]{43}$/.test(ref?.uri))
          throw new Error();
        if (artifacts!.snapshots.some((item) => item.reference.uri === ref.uri)) throw new Error();
        const key =
          'artifacts/v1/' + createHash('sha256').update(ref.uri.split('/').at(-1)!).digest('hex');
        const object = await bucket!.get(key);
        if (!object || object.size > 1000000) throw new Error();
        const reference = {
          uri: ref.uri,
          ...JSON.parse(object.customMetadata?.artifact ?? 'null'),
        };
        const bytes = Buffer.from(await object.arrayBuffer());
        if (
          !isDeepStrictEqual(reference, ref) ||
          bytes.length !== ref.size ||
          createHash('sha256').update(bytes).digest('hex') !== ref.sha256
        )
          throw new Error();
        artifacts!.snapshots.push({
          reference,
          base64: bytes.toString('base64'),
          unavailableAfter: false,
        });
      } catch {
        artifacts!.errors.push('artifact_snapshot_failed');
      }
    }
  }
  let finishing: Promise<(OutboundEvidence & { workerDisposed: true }) | null> | undefined;
  const finishObservation = () =>
    (finishing ??= (async () => {
      try {
        await recorder?.seal();
        if (artifacts) {
          for (const snapshot of artifacts.snapshots) {
            try {
              const reply = (await send({
                jsonrpc: '2.0',
                id: 100000,
                method: 'resources/read',
                params: { uri: snapshot.reference.uri },
              })) as any;
              snapshot.unavailableAfter =
                reply.error?.code === -32603 && reply.error?.message === 'Artifact unavailable';
              if (reply.error && !snapshot.unavailableAfter)
                artifacts.errors.push('artifact_deletion_read_failed');
            } catch {
              artifacts.errors.push('artifact_deletion_read_failed');
            }
          }
          const inventory = await bucket!.list({ prefix: 'artifacts/v1/', limit: 100 });
          artifacts.residualObjects = inventory.objects.length;
          if (inventory.truncated) artifacts.errors.push('artifact_inventory_truncated');
          artifacts.complete = artifacts.errors.length === 0;
          await writeFile(
            join(output, 'artifact-storage.json'),
            JSON.stringify(artifacts, null, 2) + '\n',
            { mode: 0o600 },
          );
        }
      } finally {
        await worker.dispose();
      }
      if (!recorder) return null;
      const evidence = await recorder.finalize();
      const completed = { ...evidence, workerDisposed: true as const };
      await retain(completed);
      return completed;
    })());
  return {
    identity: {
      kind: 'local',
      bundleSha256,
      ...(bucket ? { artifactStorage: 'miniflare-r2', artifactObserverVersion: 1 } : {}),
      ...(recorder ? { outboundRecorderVersion: 1 } : {}),
    },
    secrets: [] as string[],
    get hasUnknownMutation() {
      return recorder?.hasUnknownMutation ?? false;
    },
    get artifacts() {
      return artifacts;
    },
    finishObservation,
    async dispatch(request: Request) {
      if (finishing) throw new Error('Evaluation backend admission closed');
      const body = await request.text();
      const response = await worker.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
      });
      if (
        response.headers.has('mcp-session-id') ||
        !response.headers.get('content-type')?.includes('application/json')
      )
        throw new Error('Expected finite sessionless JSON');
      if (bucket) {
        const rpc = (await response.clone().json()) as any;
        const requestRpc = JSON.parse(body);
        if (requestRpc.method === 'tools/call' && requestRpc.params?.name === 'execute')
          await snapshot(rpc);
      }
      return response as unknown as Response;
    },
    async close() {
      await finishObservation();
    },
  };
}
