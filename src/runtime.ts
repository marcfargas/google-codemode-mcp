import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import type { Executor, ResolvedProvider } from '@cloudflare/codemode';
import type { DiscoveryCatalog } from './discovery.ts';
import { createDispatcher } from './dispatcher.ts';
import { validateSnippetInput } from './snippets.ts';
import type { SnippetDefinition } from './snippets.ts';
import { SERVICES } from './services.ts';
import { createArtifactStore } from './artifacts.ts';
import { registerExecutionArtifactReferences } from './artifact-references.ts';

type ArtifactStore = ReturnType<typeof createArtifactStore>;

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
const google = Object.freeze(Object.fromEntries(${JSON.stringify(Object.values(SERVICES).map(({ name, version }) => ({ name, version })))}.map(service => [service.name, function(options) {
  if (!options || options.version !== service.version || Object.keys(options).some(k => k !== 'version')) {
    throw new Error('Use the discovered Google service version; client transport overrides are forbidden');
  }
  return __nativeProxy([service.name + '/' + service.version + '/']);
}])));
const snippets = Object.freeze({run: async (name, input = {}) => {
  const outcome = await hostBridge.snippet(name, input);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}});
const __artifactStringify = JSON.stringify;
const __artifactOwnKeys = Reflect.ownKeys;
const __artifactDescriptors = Object.getOwnPropertyDescriptors;
const __artifactGetDescriptor = Object.getOwnPropertyDescriptor;
const __artifactPrototype = Object.getPrototypeOf;
const __artifactArray = Array.isArray;
const __artifactFinite = Number.isFinite;
const __artifactIs = Object.is;
const __artifactNumber = Number;
const __artifactPlainPrototype = Object.prototype;
const __artifactArrayPrototype = Array.prototype;
function __artifactJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && __artifactFinite(value) && !__artifactIs(value, -0)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Artifacts require lossless plain JSON values');
  const array = __artifactArray(value);
  if (array ? __artifactPrototype(value) !== __artifactArrayPrototype : __artifactPrototype(value) !== __artifactPlainPrototype && __artifactPrototype(value) !== null)
    throw new Error('Artifacts require plain JSON');
  for (let cursor = value; cursor !== null; cursor = __artifactPrototype(cursor)) {
    const descriptor = __artifactGetDescriptor(cursor, 'toJSON');
    if (!descriptor) continue;
    if (!('value' in descriptor) || typeof descriptor.value === 'function')
      throw new Error('Artifacts reject executable toJSON');
    break;
  }
  const descriptors = __artifactDescriptors(value);
  const keys = __artifactOwnKeys(descriptors);
  if (array && keys.length !== value.length + 1) throw new Error('Artifacts reject sparse or extended arrays');
  seen.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) ||
      (array && (String(__artifactNumber(key)) !== key || __artifactNumber(key) >= value.length || __artifactNumber(key) < 0)))
      throw new Error('Artifacts reject accessors, symbols and lossy properties');
    __artifactJson(descriptor.value, seen);
  }
  seen.delete(value);
}
const artifacts = Object.freeze(Object.fromEntries(['putJson','putBytes','readJson','readBytes','delete'].map(op => [op, async (value, options = {}) => {
  __artifactJson(options);
  __artifactJson(value);
  const input = op === 'putJson' ? {...options,json:__artifactStringify(value)} : op === 'putBytes' ? {...options,body:value} : {uri:value};
  __artifactJson(input);
  const outcome = await hostBridge.artifact(op, __artifactStringify(input));
  if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), outcome.error);
  return outcome.value;
}])));
`;

export async function executeProgram(options: {
  args: ExecutionArguments;
  catalog: DiscoveryCatalog;
  snippets: readonly SnippetDefinition[];
  executor: Executor;
  transport?: typeof fetch;
  snippetName?: string;
  artifactStore?: ArtifactStore;
  waitUntil?: (promise: Promise<unknown>) => void;
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
  const artifactExecution = (options.artifactStore ?? createArtifactStore()).createExecution({
    token: args.accessToken,
    canWrite: () => dispatcher.outcomes.some((outcome) => outcome.outcome === 'acknowledged'),
    waitUntil: options.waitUntil,
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
          artifact: async (op, serialized) => {
            if (depth !== 0 || topSnippet)
              return {
                ok: false,
                error: {
                  code: 'ARTIFACT_SCOPE',
                  message: 'Artifacts are available only in top-level execute',
                },
              };
            if (typeof op !== 'string' || typeof serialized !== 'string')
              return {
                ok: false,
                error: { code: 'ARTIFACT_INPUT', message: 'Invalid artifact input' },
              };
            return artifactExecution.invoke(op, serialized);
          },
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
    artifactExecution.close();
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
    outcomesComplete: dispatcher.outcomesComplete,
    hasUnknownOutcome: dispatcher.hasUnknownOutcome,
    discovery: catalog.provenance,
    scopeAvailability: 'unknown',
    deduplication: 'none',
    artifacts: artifactExecution.snapshot(),
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
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  registerExecutionArtifactReferences(parsed, artifactExecution.snapshot().references);
  return parsed;
}
