import { Validator } from '@cfworker/json-schema';
import { Readable } from 'node:stream';
import { Discovery } from 'googleapis-common/build/src/discovery.js';
import {
  DiscoveryCatalog,
  jsonSchema,
  referencedDefinitions,
  MAX_DOWNLOAD_BYTES,
} from './discovery.ts';
import type { DiscoveryDocument, MethodMetadata } from './discovery.ts';
import { callableParameters, parameterExclusion, supportsDownload } from './parameters.ts';
import { servicePath } from './services.ts';
import {
  supportsUpload,
  prepareUpload,
  uploadWireBody,
  normalizeUploadWire,
  MAX_EXECUTION_UPLOAD_BYTES,
  MAX_UPLOAD_PARAMS_BYTES,
  jsonBytes,
  artifactUpload,
  streamUploadWire,
  validateMethodUpload,
  maxArtifactUploadBytes,
} from './media.ts';
import { decodeGmailAttachment, MAX_ATTACHMENT_JSON_BYTES } from './reference-mime.ts';
import { MAX_STREAM_BYTES } from './storage.ts';
import type { StreamArtifactExecution } from './stream-artifacts.ts';

export type Outcome = 'not_dispatched' | 'rejected' | 'acknowledged' | 'unknown';
export interface CallOutcome {
  callId: string;
  path: string;
  mutation: boolean;
  outcome: Outcome;
  httpStatus?: number;
  resourceId?: string;
  mutationFields?: string[];
  pagination?: {
    requestedPageToken?: string;
    nextPageToken?: string;
    maxResults?: number;
    query?: string;
    pageSize?: number;
    fields?: string;
    orderBy?: string;
    corpora?: string;
    driveId?: string;
    spaces?: string;
    includeItemsFromAllDrives?: boolean;
    supportsAllDrives?: boolean;
    returnedIds?: string[];
    incompleteSearch?: boolean;
  };
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
  streamArtifacts?: StreamArtifactExecution;
}

export interface DispatchPolicy {
  services?: readonly string[];
  readOnly?: boolean;
}
interface AttachmentProjection {
  metadata: { name: string; mimeType: string };
  signal: AbortSignal;
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

function containsBytes(bytes: Uint8Array, needle: Uint8Array): boolean {
  // Linear matching bounds hostile near-matches under Worker CPU limits.
  const prefix = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index++) {
    while (matched && needle[index] !== needle[matched]) matched = prefix[matched - 1];
    if (needle[index] === needle[matched]) matched++;
    prefix[index] = matched;
  }
  for (let index = 0, matched = 0; index < bytes.length; index++) {
    while (matched && bytes[index] !== needle[matched]) matched = prefix[matched - 1];
    if (bytes[index] === needle[matched]) matched++;
    if (matched === needle.length) return true;
  }
  return false;
}

function validate(method: MethodMetadata, params: unknown, document: DiscoveryDocument): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const projection = callableParameters(method);
  if (!method.supported || !projection.supported) return false;
  const properties = Object.fromEntries(
    Object.entries(projection.parameters).map(([name, schema]) => [name, jsonSchema(schema)]),
  );
  for (const key of Object.keys(params)) {
    // The native SDK unaliases trailing underscores after extracting auth and
    // headers. Never allow an alias to bypass the actual Discovery whitelist.
    if (
      parameterExclusion(key) &&
      !(key === 'alt' && Object.hasOwn(projection.parameters, 'alt')) &&
      !(key === 'media' && supportsUpload(method))
    )
      return false;
  }
  for (const [name, schema] of Object.entries(projection.parameters)) {
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
        ...Object.entries(projection.parameters)
          .filter(([, value]) => value.required)
          .map(([name]) => name),
        ...(method.request?.required ? ['requestBody'] : []),
      ],
      definitions: referencedDefinitions(document, [
        ...Object.values(projection.parameters),
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
  let uploadedBytes = 0;
  const active = new Map<CallOutcome, AbortController>();
  const interrupted = new Set<CallOutcome>();
  const limits = {
    maxCalls: 100,
    maxResponseBytes: 1_000_000,
    callTimeoutMs: 15_000,
    ...options.limits,
  };
  function safeHeaders(source: HeadersInit): Record<string, string> {
    const result: Record<string, string> = {};
    const headers = new Headers(source);
    for (const name of ['etag', 'content-type', 'retry-after']) {
      const value = headers.get(name);
      if (value && (!accessToken || !value.includes(accessToken))) result[name] = value;
    }
    return result;
  }

  // Outcome annotations come from validated native calls, never program output.
  // Omit an unrepresentable page entirely: dropping only its token could falsely
  // imply that a response was the final page.
  const safeAnnotation = (value: unknown, maxLength: number): value is string =>
    typeof value === 'string' &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    (!accessToken || !value.includes(accessToken));

  function pagination(params: unknown, data: unknown, drive = false): CallOutcome['pagination'] {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const request = params as Record<string, unknown>;
    const response = data as Record<string, unknown>;
    const result: NonNullable<CallOutcome['pagination']> = {};
    for (const [source, name, field, bound] of [
      [request, 'pageToken', 'requestedPageToken', 2048],
      [request, 'q', 'query', 4096],
      [response, 'nextPageToken', 'nextPageToken', 2048],
    ] as const) {
      if (!Object.hasOwn(source, name)) continue;
      const value = source[name];
      if (!safeAnnotation(value, bound) || (name !== 'q' && !value.length)) return undefined;
      result[field] = value;
    }
    if (Object.hasOwn(request, 'maxResults')) {
      if (!Number.isInteger(request.maxResults)) return undefined;
      result.maxResults = request.maxResults as number;
    }
    if (drive) {
      for (const name of ['fields', 'orderBy', 'corpora', 'driveId', 'spaces'] as const) {
        if (!Object.hasOwn(request, name)) continue;
        if (!safeAnnotation(request[name], 4096)) return undefined;
        result[name] = request[name];
      }
      if (Object.hasOwn(request, 'pageSize')) {
        if (!Number.isInteger(request.pageSize)) return undefined;
        result.pageSize = request.pageSize as number;
      }
      for (const name of ['includeItemsFromAllDrives', 'supportsAllDrives'] as const) {
        if (!Object.hasOwn(request, name)) continue;
        if (typeof request[name] !== 'boolean') return undefined;
        result[name] = request[name];
      }
      if (Object.hasOwn(response, 'incompleteSearch')) {
        if (typeof response.incompleteSearch !== 'boolean') return undefined;
        result.incompleteSearch = response.incompleteSearch;
      }
      // Absence may mean a projected-out field. Do not manufacture an empty page.
      if (Object.hasOwn(response, 'files')) {
        if (!Array.isArray(response.files) || response.files.length > 1000) return undefined;
        const ids: string[] = [];
        for (const file of response.files) {
          if (!file || typeof file !== 'object' || !safeAnnotation(file.id, 256) || !file.id)
            return undefined;
          ids.push(file.id);
        }
        result.returnedIds = ids;
      }
    }
    return result;
  }

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
    attachment?: AttachmentProjection,
  ): Promise<CallResult> {
    if (closed || (method.mutation && unknown)) {
      return failure(record, 'DISPATCH_CLOSED', 'Further Google dispatch is blocked');
    }
    const selectedService = servicePath(method.path);
    const document = await catalog.document(selectedService);
    const media =
      supportsDownload(method) &&
      ((params as Record<string, unknown>).alt === 'media' || !method.response);
    const responseLimit = media
      ? options.streamArtifacts
        ? MAX_STREAM_BYTES
        : Math.min(limits.maxResponseBytes, MAX_DOWNLOAD_BYTES)
      : attachment
        ? MAX_ATTACHMENT_JSON_BYTES
        : limits.maxResponseBytes;
    const uploading = Object.hasOwn(params as object, 'media');
    let nativeParams = params;
    let expectedUpload: { metadataJson: string; mimeType: string; bytes: Uint8Array } | undefined;
    let streamedUpload: ReturnType<typeof artifactUpload> | undefined;
    if (uploading) {
      try {
        if (!supportsUpload(method)) throw new Error('Unsupported media upload');
        validateMethodUpload(method, params as Record<string, unknown>);
        const body = ((params as Record<string, unknown>).media as { body?: object }).body;
        if (body && Object.hasOwn(body, 'artifact')) {
          if (!options.streamArtifacts) throw new Error('Storage unavailable');
          streamedUpload = artifactUpload(params as Record<string, unknown>);
          nativeParams = {
            ...(params as Record<string, unknown>),
            media: {
              mimeType: streamedUpload.mimeType,
              body: Readable.from([], { objectMode: false }),
            },
          };
        } else {
          const prepared = await prepareUpload(params as Record<string, unknown>);
          if (uploadedBytes + prepared.bytes.length > MAX_EXECUTION_UPLOAD_BYTES)
            throw new Error('Execution upload limit exceeded');
          // Failed/unknown attempts still consume the conservative execution budget.
          uploadedBytes += prepared.bytes.length;
          expectedUpload = {
            ...prepared,
            metadataJson: JSON.stringify((params as Record<string, unknown>).requestBody),
          };
          nativeParams = {
            ...(params as Record<string, unknown>),
            media: {
              mimeType: prepared.mimeType,
              body: Readable.from([prepared.bytes], { objectMode: false }),
            },
          };
        }
      } catch {
        return failure(record, 'INVALID_MEDIA_UPLOAD', 'Invalid or oversized media upload');
      }
      if (closed || (method.mutation && unknown))
        return failure(record, 'DISPATCH_CLOSED', 'Further Google dispatch is blocked');
    }
    const controller = new AbortController();
    const abort = () => controller.abort(attachment?.signal.reason);
    attachment?.signal.addEventListener('abort', abort, { once: true });
    if (attachment?.signal.aborted) abort();
    active.set(record, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    let timedOut = false;
    let bodyLimitExceeded = false;
    try {
      const endpoint = endpointFactory(document)({
        retry: false,
        ...(media ? { responseType: options.streamArtifacts ? 'stream' : 'arraybuffer' } : {}),
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
          if (media) headers.set('Accept-Encoding', 'identity');
          // Workerd fetch must receive bytes, not the native SDK's Node stream.
          let uploadBody: BodyInit | undefined = expectedUpload
            ? normalizeUploadWire(
                await uploadWireBody(init?.body),
                headers.get('content-type'),
                expectedUpload,
              )
            : undefined;
          let uploadCompletion: Promise<void> | undefined;
          if (streamedUpload) {
            const stored = await options.streamArtifacts!.open(streamedUpload.uri, {
              signal: controller.signal,
            });
            if (stored.reference.mimeType !== streamedUpload.mimeType) {
              await stored.body.cancel();
              throw new Error('Media type differs from stored content');
            }
            if (stored.reference.size > maxArtifactUploadBytes(method)) {
              await stored.body.cancel();
              throw new Error('Media exceeds native method upload limit');
            }
            // Keep the SDK's URL/parameter construction; replace its Node body.
            (init?.body as unknown as { destroy?: () => void })?.destroy?.();
            const wire = streamUploadWire(headers.get('content-type'), {
              ...streamedUpload,
              body: stored.body,
              size: stored.reference.size,
              signal: controller.signal,
            });
            headers.set('content-length', String(wire.size));
            uploadBody = wire.body;
            uploadCompletion = wire.completion;
          }
          if (closed || timedOut || controller.signal.aborted || (method.mutation && unknown))
            throw new Error('Dispatch gate closed');
          const id = (params as Record<string, unknown>).id;
          if (method.path === 'gmail/v1/users.messages.get' && safeAnnotation(id, 256))
            record.resourceId = id;
          const fileId = (params as Record<string, unknown>).fileId;
          if (selectedService === 'drive/v3' && safeAnnotation(fileId, 256))
            record.resourceId = fileId;
          if (method.path === 'drive/v3/files.update') {
            const body = (params as Record<string, unknown>).requestBody;
            const fields =
              body && typeof body === 'object' && !Array.isArray(body)
                ? Object.keys(body).sort()
                : body === undefined
                  ? []
                  : undefined;
            if (
              fields &&
              fields.length <= 64 &&
              fields.every(
                (field) => safeAnnotation(field, 128) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field),
              )
            )
              record.mutationFields = fields;
          }
          dispatched = true;
          record.outcome = 'unknown';
          const response = await (options.transport ?? fetch)(url, {
            ...init,
            ...(uploading ? { body: uploadBody as BodyInit } : {}),
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
          if (response.ok && uploadCompletion) await uploadCompletion;
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
                if (received > (response.ok ? responseLimit : limits.maxResponseBytes)) {
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
      for (const segment of method.path.slice(selectedService.length + 1).split('.')) {
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
      return await Promise.race([
        (async (): Promise<CallResult> => {
          const response = await (target(nativeParams) as Promise<{
            data?: unknown;
            status: number;
            headers: HeadersInit;
          }>);
          if (interrupted.has(record)) {
            return failure(
              record,
              'DISPATCH_CLOSED',
              'Google call interrupted; inspect its recorded outcome',
            );
          }
          record.httpStatus = response.status;
          record.outcome = 'acknowledged';
          if (media) {
            if (options.streamArtifacts) {
              if (!(response.data instanceof ReadableStream))
                return failure(record, 'INVALID_MEDIA', 'Google media response was not a stream');
              const headers = new Headers(response.headers);
              const mimeType = headers.get('content-type') ?? 'application/octet-stream';
              const rawSize = headers.get('content-length');
              const size =
                rawSize !== null && /^(0|[1-9][0-9]*)$/.test(rawSize) ? Number(rawSize) : undefined;
              const reference = await options.streamArtifacts.put(response.data, {
                mimeType,
                size,
                signal: controller.signal,
              });
              return {
                ok: true,
                value: {
                  data: reference,
                  status: response.status,
                  headers: safeHeaders(response.headers),
                },
              };
            }
            if (!(response.data instanceof ArrayBuffer))
              return failure(record, 'INVALID_MEDIA', 'Google media response was not bytes');
            const bytes = new Uint8Array(response.data);
            if (bytes.length > responseLimit)
              return failure(record, 'RESPONSE_LIMIT', 'Google response exceeds execution limit');
            const tokenBytes = new TextEncoder().encode(accessToken);
            if (tokenBytes.length && containsBytes(bytes, tokenBytes))
              return failure(
                record,
                'CREDENTIAL_ECHO',
                'Google media response contained credential bytes',
              );
            const responseHeaders = new Headers(response.headers);
            const mimeType = responseHeaders.get('content-type') ?? 'application/octet-stream';
            if (
              mimeType.length > 256 ||
              /[\u0000-\u001f\u007f]/.test(mimeType) ||
              (accessToken && mimeType.includes(accessToken))
            )
              return failure(record, 'INVALID_MEDIA', 'Google media metadata was invalid');
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
              '',
            );
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return {
              ok: true,
              value: {
                data: {
                  encoding: 'base64',
                  data: btoa(binary),
                  size: bytes.length,
                  mimeType,
                  sha256,
                },
                status: response.status,
                headers: safeHeaders(response.headers),
              },
            };
          }
          if (attachment) {
            controller.signal.throwIfAborted();
            const bytes = decodeGmailAttachment(response.data);
            const reference = await options.streamArtifacts!.put(new Response(bytes).body!, {
              ...attachment.metadata,
              size: bytes.length,
              signal: controller.signal,
            });
            return {
              ok: true,
              value: {
                data: reference,
                status: response.status,
                headers: safeHeaders(response.headers),
              },
            };
          }
          const serialized = JSON.stringify(
            response.status === 204 ? null : (response.data ?? null),
          );
          if (['drive/v3/files.create', 'gmail/v1/users.drafts.create'].includes(method.path)) {
            const created = response.data as { id?: unknown } | null;
            if (created && safeAnnotation(created.id, 256) && created.id)
              record.resourceId = created.id;
          }
          if (new TextEncoder().encode(serialized).length > limits.maxResponseBytes) {
            return failure(record, 'RESPONSE_LIMIT', 'Google response exceeds execution limit');
          }
          const escapedToken = JSON.stringify(accessToken).slice(1, -1);
          const data = accessToken
            ? JSON.parse(serialized.split(escapedToken).join('[REDACTED]'))
            : JSON.parse(serialized);
          if (['gmail/v1/users.messages.list', 'drive/v3/files.list'].includes(method.path)) {
            const observed = pagination(
              params,
              response.data,
              method.path === 'drive/v3/files.list',
            );
            if (observed) record.pagination = observed;
          }
          return {
            ok: true,
            value: { data, status: response.status, headers: safeHeaders(response.headers) },
          };
        })(),
        deadline,
      ]);
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
      let errorData: unknown = native.response?.data;
      if (errorData instanceof ArrayBuffer) {
        try {
          errorData = JSON.parse(new TextDecoder().decode(errorData));
        } catch {
          errorData = undefined;
        }
      }
      const errors = (errorData as { error?: { errors?: unknown } } | undefined)?.error?.errors;
      const reasons = (Array.isArray(errors) ? errors : [])
        .map((item: unknown) =>
          item && typeof item === 'object' ? (item as { reason?: unknown }).reason : undefined,
        )
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
      controller.abort();
      attachment?.signal.removeEventListener('abort', abort);
      active.delete(record);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function call(
    path: string,
    params: unknown = {},
    policy?: DispatchPolicy,
    attachment?: AttachmentProjection,
  ): Promise<CallResult> {
    const record: CallOutcome = {
      callId: `${options.requestId}:${++sequence}`,
      path:
        typeof path === 'string' &&
        path.length <= 256 &&
        /^(gmail\/v1|drive\/v3)\/[A-Za-z0-9_.]+$/.test(path)
          ? path
          : '<invalid>',
      mutation: true,
      outcome: 'not_dispatched',
    };
    if (sequence > limits.maxCalls) {
      if (sequence === limits.maxCalls + 1) outcomes.push(record);
      return failure(record, 'CALL_LIMIT', 'Google call limit exceeded');
    }
    outcomes.push(record);
    if (record.path === '<invalid>')
      return failure(record, 'INVALID_PATH', 'Invalid Google method path');
    let method: MethodMetadata;
    try {
      method = await catalog.resolve(path);
      record.mutation = method.mutation;
      if (
        (policy?.readOnly && method.mutation) ||
        (policy?.services && !policy.services.includes(servicePath(method.path)))
      )
        return failure(record, 'POLICY_DENIED', 'Snippet policy does not permit this Google call');
      try {
        if (jsonBytes(params) > MAX_UPLOAD_PARAMS_BYTES)
          return failure(record, 'REQUEST_LIMIT', 'Google parameters exceed execution limit');
      } catch {
        return failure(record, 'INVALID_PARAMS', 'Google parameters must be JSON serializable');
      }
      if (!validate(method, params, await catalog.document(servicePath(method.path))))
        return failure(
          record,
          'INVALID_PARAMS',
          'Parameters do not match the supported Google method schema',
        );
      params = structuredClone(params);
    } catch {
      return failure(record, 'DISCOVERY_ERROR', 'Google method discovery failed');
    }
    if (!method.mutation) return dispatch(method, params, record, attachment);
    const run = mutations.then(() => dispatch(method, params, record));
    mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    outcomes,
    get outcomesComplete() {
      return sequence === outcomes.length;
    },
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
    call,
    storeGmailAttachment(
      params: unknown,
      metadata: AttachmentProjection['metadata'],
      signal: AbortSignal,
      policy?: DispatchPolicy,
    ) {
      return call('gmail/v1/users.messages.attachments.get', params, policy, { metadata, signal });
    },
  };
}
