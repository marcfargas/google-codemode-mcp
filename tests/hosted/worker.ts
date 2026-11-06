import type { Executor } from '@cloudflare/codemode';
import { DiscoveryCatalog, type DiscoveryDocument } from '../../src/discovery.ts';
import { handleMcp, MCP_VERSION } from '../../src/protocol.ts';
import { createExecutor, executeProgram } from '../../src/runtime.ts';

import { HARNESS_VERSION, SYNTHETIC_TOKEN, type Probe } from './contract.ts';
const read = `await google.gmail({version:'v1'}).users.messages.list({userId:'me'})`;
const write = `await google.gmail({version:'v1'}).users.messages.send({userId:'me',requestBody:{raw:'aGVsbG8='}})`;
export const PROBES = {
  identity: `return 'identity';`,
  healthy: `return (${read}).data;`,
  cpu: `while (true) {}`,
  asyncTimeout: `await new Promise(r => setTimeout(r, 16000)); ${read}; return 'too late';`,
  delayed: `void (async () => { await new Promise(r => setTimeout(r, 100)); ${read}; })().catch(() => {}); return 'scheduled';`,
  unawaited: `void (async () => { try { ${read}; } finally { ${read}; } })().catch(() => {}); await new Promise(r => setTimeout(r, 20)); return 'in flight';`,
  multiple: `let counts=[]; for(let i=0;i<5;i++) counts.push((${read}).data.dispatch); return counts;`,
  mutationUnknown: `const send=async()=>{try{${write}}catch{}};
    await Promise.all([send(),send()]); await send(); return (${read}).data;`,
  mutationAcknowledged: `${write}; throw new Error('Program failed after acknowledged write');`,
  isolation: `let networkBlocked=false;try{await fetch('https://example.com/')}catch{networkBlocked=true}
    const errors=[];const gmail=google.gmail({version:'v1'});
    for(const params of [{userId:'me',rootUrl:'https://example.com/'},{userId:'me',auth:'other'},{userId:'me',headers:{Authorization:'other'}}]){
      try{await gmail.users.messages.list(params)}catch(e){errors.push(e.code)}
    }
    try{google.gmail({version:'v1',rootUrl:'https://example.com/'})}catch{errors.push('client')}
    try{await gmail.users.messages.list({userId:'me'},{headers:{Authorization:'other'}})}catch{errors.push('options')}
    const data=(${read}).data;
    return {networkBlocked,errors,token:typeof accessToken,environment:typeof env,read:data,echoRedactedBeforeReturn:data.credentialEcho==='[REDACTED]'};`,
} as const;

const document: DiscoveryDocument = {
  name: 'gmail',
  version: 'v1',
  revision: 'hosted-synthetic-2',
  rootUrl: 'https://gmail.googleapis.com/',
  servicePath: '',
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            send: {
              id: 'gmail.users.messages.send',
              path: 'gmail/v1/users/{userId}/messages/send',
              httpMethod: 'POST',
              parameters: { userId: { type: 'string', required: true, location: 'path' } },
              request: { type: 'object', properties: { raw: { type: 'string' } } },
              response: { type: 'object', properties: { id: { type: 'string' } } },
            },
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
        let syntheticEffects = 0;
        const dispatches: {
          sequence: number;
          method: string;
          atMs: number;
          afterClose: boolean;
          aborted: boolean;
        }[] = [];
        const transport: typeof fetch = async (input, init) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const target = new URL(String(input));
          const sending =
            method === 'POST' && target.pathname === '/gmail/v1/users/me/messages/send';
          if (
            target.origin !== 'https://gmail.googleapis.com' ||
            !(sending || (method === 'GET' && target.pathname === '/gmail/v1/users/me/messages'))
          )
            throw new Error('Unexpected synthetic Google request');
          if (new Headers(init?.headers).get('authorization') !== `Bearer ${SYNTHETIC_TOKEN}`)
            throw new Error('Synthetic credential boundary failed');
          const entry = {
            sequence: dispatches.length + 1,
            method,
            atMs: Date.now() - startedAt,
            afterClose: closed,
            aborted: false,
          };
          dispatches.push(entry);
          if (sending) {
            syntheticEffects++;
            if (probe === 'mutationUnknown')
              throw new Error('Synthetic response lost after effect');
            return Response.json({ id: 'synthetic-write' });
          }
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
          return Response.json({
            dispatch: entry.sequence,
            ...(probe === 'isolation' ? { credentialEcho: SYNTHETIC_TOKEN } : {}),
          });
        };
        let executorSignal: {
          kind: 'returned' | 'threw';
          error: string | null;
          name?: string;
        } | null = null;
        let loadedLimits: { cpuMs?: number; subRequests?: number } | undefined;
        let networkDenied = false;
        const observedLoader: WorkerLoader = {
          get: env.LOADER.get.bind(env.LOADER),
          load: (code) => {
            loadedLimits = code.limits;
            networkDenied = code.globalOutbound === null;
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
          syntheticEffects,
          limits: {
            innerCpuMs: loadedLimits?.cpuMs ?? null,
            innerSubRequests: loadedLimits?.subRequests ?? null,
            innerNetworkDenied: networkDenied,
            executorTimeoutMs: 15000,
          },
          syntheticGoogle: true,
        };
      },
    });
  },
};
