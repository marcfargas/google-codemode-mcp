import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import type { Executor, ResolvedProvider } from '@cloudflare/codemode';
import type { DiscoveryCatalog } from './discovery.ts';
import { createDispatcher } from './dispatcher.ts';
import { validateSnippetInput } from './snippets.ts';
import type { SnippetDefinition } from './snippets.ts';
import { SERVICES } from './services.ts';
import { createArtifactStore } from './artifacts.ts';
import { registerExecutionArtifactReferences } from './artifact-references.ts';
import type { StreamArtifactStore } from './stream-artifacts.ts';

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

export const PAGINATION_CAPABILITIES = {
  operations: ['collect'],
  methods: ['gmail/v1/users.messages.list', 'drive/v3/files.list'],
  limits: { maxPages: 50, maxBytes: 1_000_000, tokenCharacters: 4096 },
  skill: 'skill://google-codemode-mcp/google-workspace/references/pagination.md',
} as const;

const PRELUDE = `
function __freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(__freeze); Object.freeze(value); }
  return value;
}
const inputs = __freeze(__bridgeInputs);
const {google,pagination} = (() => {
const methods = new WeakMap();
function __nativeProxy(parts) {
  const proxy = new Proxy(function(){}, {
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
  methods.set(proxy, parts.join('.').replace('/.', '/'));
  return proxy;
}
const google = Object.freeze(Object.fromEntries(${JSON.stringify(Object.values(SERVICES).map(({ name, version }) => ({ name, version })))}.map(service => [service.name, function(options) {
  if (!options || options.version !== service.version || Object.keys(options).some(k => k !== 'version')) {
    throw new Error('Use the discovered Google service version; client transport overrides are forbidden');
  }
  return __nativeProxy([service.name + '/' + service.version + '/']);
}])));
const pagination = Object.freeze({collect: async (method, params, options) => {
  const invalid = message => Object.assign(new Error(message), {code:'PAGINATION_INVALID'});
  const path = methods.get(method);
  if (!${JSON.stringify(PAGINATION_CAPABILITIES.methods)}.includes(path))
    throw invalid('Pagination requires a supported native list method');
  try { __artifactJson(params); __artifactJson(options); }
  catch { throw invalid('Pagination requires lossless plain JSON parameters and limits'); }
  if (!params || typeof params !== 'object' || Array.isArray(params) || !options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).sort().join() !== 'maxBytes,maxPages' ||
      !Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 50 ||
      !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1000000)
    throw invalid('Pagination requires native parameters and bounded maxPages/maxBytes');
  const original = __freeze(JSON.parse(__artifactStringify(params)));
  const {maxPages,maxBytes} = options;
  const drive = path === 'drive/v3/files.list';
  const tokenValid = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
  if (Object.hasOwn(original,'pageToken') && !tokenValid(original.pageToken))
    throw invalid('Invalid initial pageToken');
  if (Object.hasOwn(original,'fields')) {
    if (typeof original.fields !== 'string') throw invalid('Invalid fields mask');
    const fields = []; let depth = 0, start = 0;
    for (let i = 0; i < original.fields.length; i++) {
      const char = original.fields[i];
      if (char === '(') depth++;
      if (char === ')' && --depth < 0) throw invalid('Unbalanced fields mask');
      if (char === ',' && depth === 0) { fields.push(original.fields.slice(start,i).trim()); start = i+1; }
    }
    fields.push(original.fields.slice(start).trim());
    if (depth || fields.some(field => !field) ||
        (!fields.includes('*') && (!fields.includes('nextPageToken') || (drive && !fields.includes('incompleteSearch')))))
      throw invalid('Fields mask must expose top-level pagination fields');
  }
  const pages = [], seen = new Set();
  let token = original.pageToken ?? null, incompleteSearch = null;
  const envelope = (stoppedBy, exhausted = false) => ({pages,exhausted,stoppedBy,resumePageToken:token,incompleteSearch});
  // Reserve the longest stop marker and boolean encodings, including for error partials.
  const fits = (candidatePages, candidateToken) => new TextEncoder().encode(__artifactStringify({
    pages:candidatePages,exhausted:false,stoppedBy:'maxPages',resumePageToken:candidateToken,incompleteSearch:false
  })).length <= maxBytes;
  if (!fits(pages,token)) throw invalid('maxBytes cannot hold pagination metadata');
  const fail = (error, reason) => { error.partial = envelope(reason); throw error; };
  while (true) {
    if (token !== null) seen.add(token);
    let data;
    try {
      const request = {...original};
      if (token === null) delete request.pageToken; else request.pageToken = token;
      data = (await method(request)).data;
    } catch (error) { fail(error,'error'); }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      fail(invalid('Native list response must be an object'),'invalid');
    const next = Object.hasOwn(data,'nextPageToken') ? data.nextPageToken : null;
    if ((next !== null && !tokenValid(next)) ||
        (Object.hasOwn(data,'nextPageToken') && next === null) ||
        (drive && Object.hasOwn(data,'incompleteSearch') && typeof data.incompleteSearch !== 'boolean'))
      fail(invalid('Malformed native pagination metadata'),'invalid');
    if (next !== null && seen.has(next))
      fail(Object.assign(new Error('Repeated native page token'),{code:'PAGINATION_CYCLE'}),'cycle');
    if (!fits([...pages,data],next)) return envelope('maxBytes');
    pages.push(data); token = next;
    if (drive) incompleteSearch = incompleteSearch === true || data.incompleteSearch === true ? true :
      pages.length === 1 ? (data.incompleteSearch === false ? false : null) :
      incompleteSearch === false && data.incompleteSearch === false ? false : null;
    if (next === null) return envelope('end',true);
    if (pages.length >= maxPages) return envelope('maxPages');
  }
}});
return {google,pagination};
})();
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
  streamArtifactStore?: StreamArtifactStore;
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
  const streamArtifacts = options.streamArtifactStore?.createExecution({
    token: args.accessToken,
    waitUntil: options.waitUntil,
  });
  const dispatcher = createDispatcher({
    catalog,
    accessToken: args.accessToken,
    requestId,
    transport: options.transport,
    streamArtifacts,
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
            const input = JSON.parse(serialized) as { uri?: unknown };
            if (
              typeof input.uri === 'string' &&
              input.uri.startsWith('artifact://google-codemode-mcp/v2/')
            ) {
              if (
                !streamArtifacts ||
                Object.keys(input).join() !== 'uri' ||
                !['readBytes', 'delete'].includes(op)
              )
                return {
                  ok: false,
                  error: { code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact unavailable' },
                };
              try {
                return {
                  ok: true,
                  value: await (op === 'delete'
                    ? streamArtifacts.delete(input.uri)
                    : streamArtifacts.readBytes(input.uri)),
                };
              } catch {
                return {
                  ok: false,
                  error: { code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact unavailable' },
                };
              }
            }
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
    streamArtifacts?.close();
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
    artifacts: (() => {
      const bounded = artifactExecution.snapshot(),
        streamed = streamArtifacts?.snapshot();
      return streamed
        ? {
            outcomes: [...bounded.outcomes, ...streamed.outcomes],
            references: [...bounded.references, ...streamed.references],
            outcomesComplete: bounded.outcomesComplete && streamed.outcomesComplete,
            hasUnknownOutcome: bounded.hasUnknownOutcome || streamed.hasUnknownOutcome,
          }
        : bounded;
    })(),
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
  registerExecutionArtifactReferences(parsed, output.artifacts.references);
  return parsed;
}
