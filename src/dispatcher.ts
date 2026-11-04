import { Validator } from '@cfworker/json-schema';
import { Discovery } from 'googleapis-common/build/src/discovery.js';
import { DiscoveryCatalog, jsonSchema, referencedDefinitions } from './discovery.ts';
import type { DiscoveryDocument, MethodMetadata } from './discovery.ts';

export type Outcome = 'not_dispatched' | 'rejected' | 'acknowledged' | 'unknown';
export interface CallOutcome {
  callId: string;
  path: string;
  mutation: boolean;
  outcome: Outcome;
  httpStatus?: number;
}
export interface SafeGoogleError {
  code: string;
  message: string;
  callId: string;
  outcome: Outcome;
  httpStatus?: number;
  reasons?: string[];
}
export type CallResult =
  | { ok: true; value: { data: unknown; status: number; headers: Record<string, string> } }
  | { ok: false; error: SafeGoogleError };

interface DispatcherOptions {
  catalog: DiscoveryCatalog;
  accessToken: string;
  requestId: string;
  limits?: { maxCalls?: number; maxResponseBytes?: number; callTimeoutMs?: number };
  transport?: typeof fetch;
}

export interface DispatchPolicy {
  services?: readonly string[];
  readOnly?: boolean;
}

// Native Discovery Endpoint exposes makeEndpoint at runtime, but marks it private
// in its declarations. This isolated cast is pinned to googleapis-common 9.3.1.
type Endpoint = Record<string, unknown>;
type EndpointFactory = (options: Record<string, unknown>) => Endpoint;
function endpointFactory(document: DiscoveryDocument): EndpointFactory {
  return (
    new Discovery({}) as unknown as {
      makeEndpoint(document: DiscoveryDocument): EndpointFactory;
    }
  ).makeEndpoint(document);
}

function validate(method: MethodMetadata, params: unknown, document: DiscoveryDocument): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const properties = Object.fromEntries(
    Object.entries(method.parameters ?? {}).map(([name, schema]) => [name, jsonSchema(schema)]),
  );
  const reserved =
    /^(auth|headers|rootUrl|url|options|retry|retryConfig|adapter|fetchImplementation|accessToken|oauth_token|access_token|key|resource|media|uploadType|upload_protocol|callback|alt)_*$/i;
  for (const key of Object.keys(params)) {
    // The native SDK unaliases trailing underscores after extracting auth and
    // headers. Never allow an alias to bypass the actual Discovery whitelist.
    if (reserved.test(key) || key.endsWith('_')) return false;
  }
  for (const [name, schema] of Object.entries(method.parameters ?? {})) {
    if (schema.location !== 'path') continue;
    const raw = (params as Record<string, unknown>)[name];
    if (typeof raw !== 'string') continue;
    let value = raw;
    for (let depth = 0; depth < 5; depth++) {
      if (/(^|[/\\])\.{1,2}([/\\]|$)|[\u0000-\u001f]/.test(value)) return false;
      if (!value.includes('%')) break;
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        return false;
      }
      if (depth === 4) return false;
    }
  }
  if (method.request) properties.requestBody = jsonSchema(method.request);
  return new Validator(
    {
      type: 'object',
      properties,
      additionalProperties: false,
      required: [
        ...Object.entries(method.parameters ?? {})
          .filter(([, value]) => value.required)
          .map(([name]) => name),
        ...(method.request?.required ? ['requestBody'] : []),
      ],
      definitions: referencedDefinitions(document, [
        ...Object.values(method.parameters ?? {}),
        ...(method.request ? [method.request] : []),
      ]),
    },
    '7',
  ).validate(params).valid;
}

export function createDispatcher(options: DispatcherOptions) {
  const { catalog, accessToken } = options;
  const outcomes: CallOutcome[] = [];
  let closed = false;
  let unknown = false;
  let mutations = Promise.resolve();
  let sequence = 0;
  const active = new Map<CallOutcome, AbortController>();
  const interrupted = new Set<CallOutcome>();
  const limits = {
    maxCalls: 100,
    maxResponseBytes: 1_000_000,
    callTimeoutMs: 15_000,
    ...options.limits,
  };

  const failure = (
    record: CallOutcome,
    code: string,
    message: string,
    reasons?: string[],
  ): CallResult => ({
    ok: false,
    error: {
      code,
      message,
      callId: record.callId,
      outcome: record.outcome,
      ...(record.httpStatus ? { httpStatus: record.httpStatus } : {}),
      ...(reasons?.length ? { reasons } : {}),
    },
  });

  async function dispatch(
    method: MethodMetadata,
    params: unknown,
    record: CallOutcome,
  ): Promise<CallResult> {
    if (closed || (method.mutation && unknown)) {
      return failure(record, 'DISPATCH_CLOSED', 'Further Google dispatch is blocked');
    }
    const document = await catalog.document();
    const controller = new AbortController();
    active.set(record, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    let timedOut = false;
    let bodyLimitExceeded = false;
    try {
      const endpoint = endpointFactory(document)({
        retry: false,
        headers: { Authorization: `Bearer ${accessToken}` },
        fetchImplementation: async (url: string | URL | Request, init?: RequestInit) => {
          const target = new URL(
            typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
          );
          const root = new URL(document.rootUrl);
          if (target.origin !== root.origin || target.username || target.password) {
            throw new Error('Untrusted Google destination');
          }
          if (closed || timedOut || (method.mutation && unknown))
            throw new Error('Dispatch gate closed');
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${accessToken}`);
          dispatched = true;
          record.outcome = 'unknown';
          const response = await (options.transport ?? fetch)(url, {
            ...init,
            headers,
            redirect: 'manual',
            signal: controller.signal,
          });
          if (closed || timedOut || interrupted.has(record)) {
            await response.body?.cancel();
            throw new Error('Dispatch closed');
          }
          record.httpStatus = response.status;
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new Error('Google redirects are not followed');
          }
          if (response.status >= 200 && response.status < 300) record.outcome = 'acknowledged';
          if (!response.body) return response;
          const reader = response.body.getReader();
          let received = 0;
          const bounded = new ReadableStream<Uint8Array>({
            async pull(stream) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  stream.close();
                  return;
                }
                received += value.byteLength;
                if (received > limits.maxResponseBytes) {
                  bodyLimitExceeded = true;
                  await reader.cancel('Google response exceeds byte limit');
                  stream.error(new Error('Google response exceeds byte limit'));
                  return;
                }
                stream.enqueue(value);
              } catch (error) {
                stream.error(error);
              }
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          });
          return new Response(bounded, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      });
      let target: unknown = endpoint;
      for (const segment of method.path.slice('gmail/v1/'.length).split('.')) {
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, segment)) {
          throw new Error('Native method unavailable');
        }
        target = (target as Endpoint)[segment];
      }
      if (typeof target !== 'function') throw new Error('Native method unavailable');
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('Google call timed out'));
        }, limits.callTimeoutMs);
      });
      const response = await Promise.race([
        target(structuredClone(params)) as Promise<{
          data?: unknown;
          status: number;
          headers: HeadersInit;
        }>,
        deadline,
      ]);
      if (interrupted.has(record)) {
        return failure(
          record,
          'DISPATCH_CLOSED',
          'Google call interrupted; inspect its recorded outcome',
        );
      }
      record.httpStatus = response.status;
      record.outcome = 'acknowledged';
      const serialized = JSON.stringify(response.status === 204 ? null : (response.data ?? null));
      if (new TextEncoder().encode(serialized).length > limits.maxResponseBytes) {
        return failure(record, 'RESPONSE_LIMIT', 'Google response exceeds execution limit');
      }
      const escapedToken = JSON.stringify(accessToken).slice(1, -1);
      const data = accessToken
        ? JSON.parse(serialized.split(escapedToken).join('[REDACTED]'))
        : JSON.parse(serialized);
      const headers: Record<string, string> = {};
      const responseHeaders = new Headers(response.headers);
      for (const name of ['etag', 'content-type', 'retry-after']) {
        const value = responseHeaders.get(name);
        if (value && !value.includes(accessToken)) headers[name] = value;
      }
      return { ok: true, value: { data, status: response.status, headers } };
    } catch (error) {
      const native = error as {
        response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
      };
      const status = native.response?.status ?? record.httpStatus;
      if (typeof status === 'number') record.httpStatus = status;
      // A 4xx response is Google's authoritative rejection; 408 and server /
      // transport failures cannot establish whether a mutation was accepted.
      if (!interrupted.has(record) && record.outcome !== 'acknowledged')
        record.outcome = !dispatched
          ? 'not_dispatched'
          : status && status >= 400 && status < 500 && status !== 408
            ? 'rejected'
            : 'unknown';
      if (method.mutation && record.outcome === 'unknown') unknown = true;
      const reasons = native.response?.data?.error?.errors
        ?.map((item) => item.reason)
        .filter(
          (reason): reason is string =>
            typeof reason === 'string' &&
            /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(reason) &&
            !reason.includes(accessToken),
        );
      return failure(
        record,
        bodyLimitExceeded ? 'RESPONSE_LIMIT' : timedOut ? 'GOOGLE_TIMEOUT' : 'GOOGLE_ERROR',
        dispatched
          ? 'Google call failed; inspect its recorded outcome'
          : 'Google call was not dispatched',
        reasons,
      );
    } finally {
      active.delete(record);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    outcomes,
    get hasUnknownOutcome() {
      return unknown;
    },
    close(_reason?: string) {
      closed = true;
      for (const [record, controller] of active) {
        interrupted.add(record);
        if (record.mutation && record.outcome === 'unknown') unknown = true;
        controller.abort();
      }
    },
    async call(path: string, params: unknown = {}, policy?: DispatchPolicy): Promise<CallResult> {
      const record: CallOutcome = {
        callId: `${options.requestId}:${++sequence}`,
        path:
          typeof path === 'string' && path.length <= 256 && /^gmail\/v1\/[A-Za-z0-9_.]+$/.test(path)
            ? path
            : '<invalid>',
        mutation: true,
        outcome: 'not_dispatched',
      };
      if (sequence > limits.maxCalls)
        return failure(record, 'CALL_LIMIT', 'Google call limit exceeded');
      outcomes.push(record);
      if (record.path === '<invalid>')
        return failure(record, 'INVALID_PATH', 'Invalid Google method path');
      let method: MethodMetadata;
      try {
        method = await catalog.resolve(path);
        record.mutation = method.mutation;
        if (
          (policy?.readOnly && method.mutation) ||
          (policy?.services && !policy.services.includes('gmail/v1'))
        ) {
          return failure(
            record,
            'POLICY_DENIED',
            'Snippet policy does not permit this Google call',
          );
        }
        if (!validate(method, params, await catalog.document())) {
          return failure(
            record,
            'INVALID_PARAMS',
            'Parameters do not match the supported Google method schema',
          );
        }
      } catch {
        return failure(record, 'DISCOVERY_ERROR', 'Google method discovery failed');
      }
      if (!method.mutation) return dispatch(method, params, record);
      const run = mutations.then(() => dispatch(method, params, record));
      mutations = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
