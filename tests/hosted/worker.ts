import type { Executor } from '@cloudflare/codemode';
import { DiscoveryCatalog, type DiscoveryDocument } from '../../src/discovery.ts';
import { handleMcp, MCP_VERSION } from '../../src/protocol.ts';
import { createExecutor, executeProgram } from '../../src/runtime.ts';

import { HARNESS_VERSION, SYNTHETIC_TOKEN, type Probe } from './contract.ts';
const read = `await google.gmail({version:'v1'}).users.messages.list({userId:'me'})`;
export const PROBES = {
  identity: `return 'identity';`,
  healthy: `return (${read}).data;`,
  cpu: `while (true) {}`,
  asyncTimeout: `await new Promise(r => setTimeout(r, 16000)); ${read}; return 'too late';`,
  delayed: `void (async () => { await new Promise(r => setTimeout(r, 100)); ${read}; })().catch(() => {}); return 'scheduled';`,
  unawaited: `void (async () => { try { ${read}; } finally { ${read}; } })().catch(() => {}); await new Promise(r => setTimeout(r, 20)); return 'in flight';`,
  multiple: `let counts=[]; for(let i=0;i<5;i++) counts.push((${read}).data.dispatch); return counts;`,
} as const;

const document: DiscoveryDocument = {
  name: 'gmail',
  version: 'v1',
  revision: 'hosted-synthetic-1',
  rootUrl: 'https://gmail.googleapis.com/',
  servicePath: '',
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            list: {
              id: 'gmail.users.messages.list',
              path: 'gmail/v1/users/{userId}/messages',
              httpMethod: 'GET',
              parameters: { userId: { type: 'string', required: true, location: 'path' } },
              response: { type: 'object', properties: { dispatch: { type: 'integer' } } },
            },
          },
        },
      },
    },
  },
};

interface Environment {
  LOADER: WorkerLoader;
  CANDIDATE_DIGEST: string;
  WORKER_VERSION: { id: string; tag?: string; timestamp?: string };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A private, fixed-program verifier. This is never mounted in the product Worker. */
export default {
  async fetch(request: Request, env: Environment) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (!/^[a-f0-9]{64}$/.test(env.CANDIDATE_DIGEST ?? '') || !env.WORKER_VERSION?.id)
      return Response.json(
        { error: 'Prepared candidate identity and version binding required' },
        { status: 503 },
      );
    const catalog = new DiscoveryCatalog({ document });
    return handleMcp(request, {
      snippets: [],
      describe: (args) => catalog.describe(args.path),
      runSnippet: async () => {
        throw new Error('No verification snippets');
      },
      execute: async (args) => {
        const probe = args.code as Probe;
        if (
          !Object.hasOwn(PROBES, probe) ||
          args.accessToken !== SYNTHETIC_TOKEN ||
          Object.keys(args.inputs ?? {}).length
        )
          throw new Error('Only fixed synthetic verification probes are accepted');
        const startedAt = Date.now();
        let closed = false;
        const dispatches: {
          sequence: number;
          atMs: number;
          afterClose: boolean;
          aborted: boolean;
        }[] = [];
        const transport: typeof fetch = async (input, init) => {
          if (
            (init?.method ?? 'GET') !== 'GET' ||
            new URL(String(input)).pathname !== '/gmail/v1/users/me/messages'
          )
            throw new Error('Unexpected synthetic Google request');
          if (new Headers(init?.headers).get('authorization') !== `Bearer ${SYNTHETIC_TOKEN}`)
            throw new Error('Synthetic credential boundary failed');
          const entry = {
            sequence: dispatches.length + 1,
            atMs: Date.now() - startedAt,
            afterClose: closed,
            aborted: false,
          };
          dispatches.push(entry);
          if (probe === 'unawaited')
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                entry.aborted = true;
                clearTimeout(timer);
                reject(new Error('Synthetic read aborted'));
              };
              const timer = setTimeout(() => {
                init?.signal?.removeEventListener('abort', onAbort);
                resolve();
              }, 200);
              if (init?.signal?.aborted) onAbort();
              else init?.signal?.addEventListener('abort', onAbort, { once: true });
            });
          return Response.json({ dispatch: entry.sequence });
        };
        let executorSignal: {
          kind: 'returned' | 'threw';
          error: string | null;
          name?: string;
        } | null = null;
        let loadedLimits: { cpuMs?: number; subRequests?: number } | undefined;
        const observedLoader: WorkerLoader = {
          get: env.LOADER.get.bind(env.LOADER),
          load: (code) => {
            loadedLimits = code.limits;
            return env.LOADER.load(code);
          },
        };
        const native = createExecutor(observedLoader);
        // Observe platform exceptions before executeProgram applies its normal safe error envelope.
        const observed: Executor = {
          async execute(...parameters) {
            try {
              const result = await native.execute(...parameters);
              executorSignal = { kind: 'returned', error: result.error?.slice(0, 2048) ?? null };
              return result;
            } catch (error) {
              executorSignal = {
                kind: 'threw',
                error:
                  error instanceof Error
                    ? error.message.slice(0, 2048)
                    : 'Non-Error platform exception',
                name: error instanceof Error ? error.name : 'unknown',
              };
              throw error;
            }
          },
        };
        const execution = await executeProgram({
          args: { ...args, code: PROBES[probe] },
          catalog,
          snippets: [],
          executor: observed,
          transport,
        });
        closed = true;
        const closedAtMs = Date.now() - startedAt;
        const atClose = dispatches.length;
        // Keep this request alive beyond all scheduled late work, including the timeout probe.
        const observeMs =
          probe === 'asyncTimeout' ? 1500 : ['delayed', 'unawaited'].includes(probe) ? 350 : 0;
        if (observeMs) await sleep(observeMs);
        return {
          harnessVersion: HARNESS_VERSION,
          protocolVersion: MCP_VERSION,
          probe,
          candidateDigest: env.CANDIDATE_DIGEST,
          workerVersion: env.WORKER_VERSION,
          requestId: args.requestId,
          execution,
          executorSignal,
          startedAt: new Date(startedAt).toISOString(),
          closedAtMs,
          elapsedMs: Date.now() - startedAt,
          observeMs,
          dispatchesAtClose: atClose,
          dispatches,
          limits: {
            innerCpuMs: loadedLimits?.cpuMs ?? null,
            innerSubRequests: loadedLimits?.subRequests ?? null,
            executorTimeoutMs: 15000,
          },
          syntheticGoogle: true,
        };
      },
    });
  },
};
