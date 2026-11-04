import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import type { Executor, ResolvedProvider } from '@cloudflare/codemode';
import type { DiscoveryCatalog } from './discovery.ts';
import { createDispatcher } from './dispatcher.ts';
import { validateSnippetInput } from './snippets.ts';
import type { SnippetDefinition } from './snippets.ts';

export interface ExecutionArguments {
  accessToken: string;
  code: string;
  inputs?: Record<string, unknown>;
  requestId?: string;
}
export interface SnippetArguments {
  accessToken: string;
  inputs?: Record<string, unknown>;
  requestId?: string;
}

export function createExecutor(
  loader: WorkerLoader,
  options: { timeoutMs?: number } = {},
): Executor {
  // The stock executor's timer fences asynchronous calls; runtime limits govern CPU.
  const boundedLoader: WorkerLoader = {
    get: loader.get.bind(loader),
    load: (code) =>
      loader.load({
        ...code,
        compatibilityDate: '2026-07-28',
        limits: { cpuMs: 1_000, subRequests: 1 },
        globalOutbound: null,
      }),
  };
  return new DynamicWorkerExecutor({
    loader: boundedLoader,
    timeout: options.timeoutMs ?? 15_000,
    globalOutbound: null,
  });
}

const PRELUDE = `
function __freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(__freeze); Object.freeze(value); }
  return value;
}
const inputs = __freeze(__bridgeInputs);
function __nativeProxy(parts) {
  return new Proxy(function(){}, {
    get(_, key) {
      if (key === 'then' || typeof key !== 'string') return undefined;
      return __nativeProxy([...parts, key]);
    },
    async apply(_, __, args) {
      if (args.length > 1) throw new Error('Only native parameters are supported; transport options are forbidden');
      const outcome = await hostBridge.call(parts.join('.'), args[0] ?? {});
      if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), outcome.error);
      return outcome.value;
    }
  });
}
const google = Object.freeze({gmail(options) {
  if (!options || options.version !== 'v1' || Object.keys(options).some(k => k !== 'version')) {
    throw new Error('Use google.gmail({version: "v1"}); client transport overrides are forbidden');
  }
  return __nativeProxy(['gmail/v1/']);
}});
const snippets = Object.freeze({run: async (name, input = {}) => {
  const outcome = await hostBridge.snippet(name, input);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}});
`;

export async function executeProgram(options: {
  args: ExecutionArguments;
  catalog: DiscoveryCatalog;
  snippets: readonly SnippetDefinition[];
  executor: Executor;
  transport?: typeof fetch;
  snippetName?: string;
}) {
  const { args, catalog, snippets, executor } = options;
  if (!args.accessToken || args.accessToken.length > 16_384 || /[\r\n]/.test(args.accessToken)) {
    throw new Error('A valid request-local accessToken argument is required');
  }
  if (typeof args.code !== 'string' || args.code.length > 64_000)
    throw new Error('Code exceeds 64000 characters');
  const requestId = args.requestId ?? crypto.randomUUID();
  if (!/^[\w.:-]{1,128}$/.test(requestId)) throw new Error('Invalid requestId');
  const inputs = args.inputs ?? {};
  if (JSON.stringify(inputs).length > 64_000) throw new Error('Inputs exceed 64000 characters');
  const dispatcher = createDispatcher({
    catalog,
    accessToken: args.accessToken,
    requestId,
    transport: options.transport,
  });
  let snippetCalls = 0;
  const registry = new Map(snippets.map((s) => [s.name, s]));
  const topSnippet = options.snippetName ? registry.get(options.snippetName) : undefined;
  if (options.snippetName && !topSnippet) throw new Error('Unknown snippet');
  type Policy = { services?: readonly string[]; readOnly?: boolean };
  const run = async (code: string, input: unknown, policy: Policy, depth: number) => {
    const providers: ResolvedProvider[] = [
      {
        name: 'hostBridge',
        fns: {
          call: async (path, params) => {
            if (typeof path !== 'string')
              return { ok: false, error: { message: 'Invalid method path' } };
            // Proxy root is separated with slash; subsequent resources retain Google's dots.
            return dispatcher.call(path.replace('/.', '/'), params, policy);
          },
          snippet: async (name, snippetInput) => {
            const snippet = typeof name === 'string' ? registry.get(name) : undefined;
            if (!snippet || depth >= 4 || ++snippetCalls > 16)
              return { ok: false, error: 'Unknown snippet or invocation limit exceeded' };
            try {
              validateSnippetInput(snippet, snippetInput);
              const services = snippet.services.filter(
                (s) => !policy.services || policy.services.includes(s),
              );
              const result = await run(
                snippet.code,
                snippetInput,
                { services, readOnly: policy.readOnly || snippet.readOnly },
                depth + 1,
              );
              return result.error
                ? { ok: false, error: result.error }
                : { ok: true, value: result.result ?? null };
            } catch {
              return { ok: false, error: 'Snippet execution failed' };
            }
          },
        },
        prelude: `const __bridgeInputs = JSON.parse(${JSON.stringify(JSON.stringify(input))});\n${PRELUDE}`,
      },
    ];
    return executor.execute(`async () => {\n${code}\n}`, providers);
  };
  let result;
  try {
    if (topSnippet) validateSnippetInput(topSnippet, inputs);
    result = await run(
      topSnippet?.code ?? args.code,
      inputs,
      topSnippet ? { services: topSnippet.services, readOnly: topSnippet.readOnly } : {},
      0,
    );
  } catch {
    result = { result: undefined, error: 'Execution failed' };
  } finally {
    // Includes unawaited and in-flight calls, even when the program returns normally.
    dispatcher.close('Execution ended');
  }
  const output = {
    requestId,
    status: result.error ? 'error' : 'completed',
    result: result.result ?? null,
    ...(result.error ? { error: result.error } : {}),
    logs: Array.isArray(result.logs)
      ? result.logs
          .filter((s): s is string => typeof s === 'string')
          .slice(0, 100)
          .map((s) => s.slice(0, 4096))
      : [],
    outcomes: dispatcher.outcomes,
    hasUnknownOutcome: dispatcher.hasUnknownOutcome,
    discovery: catalog.provenance,
    scopeAvailability: 'unknown',
    deduplication: 'none',
  };
  // The credential never enters the sandbox. Redaction also covers hostile upstream echoes.
  const redact = (value: unknown) =>
    JSON.stringify(value).split(JSON.stringify(args.accessToken).slice(1, -1)).join('[REDACTED]');
  let serialized: string;
  try {
    serialized = redact(output);
  } catch {
    serialized = redact({
      ...output,
      status: 'error',
      result: null,
      error: 'Program result is not JSON serializable',
      logs: [],
    });
  }
  if (serialized.length > 256_000) {
    serialized = redact({
      ...output,
      status: 'error',
      result: null,
      logs: [],
      error: 'Execution output exceeds 256000 characters',
    });
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}
