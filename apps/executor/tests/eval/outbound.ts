/** Harness-owned observation of parent Worker egress, independent of product receipts. */
export interface OutboundRequest {
  ordinal: number;
  method: string;
  origin: string;
  pathname: string;
  queryKeys: string[];
  methodOverride: boolean;
  dispatched: boolean;
  outcome: 'pending' | 'acknowledged' | 'rejected' | 'unknown';
  status?: number;
}
export interface OutboundEvidence {
  version: 1;
  complete: boolean;
  requests: OutboundRequest[];
  failure?: 'persistence_failed' | 'invalid_request' | 'late_request' | 'uncertain_write';
}

/** One recorder per Worker/trial. Supply onEvent for durable pre-egress evidence. */
export function createOutboundRecorder(
  options: {
    onEvent?: (evidence: OutboundEvidence) => Promise<unknown>;
    transport?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error('Invalid outbound observation timeout');
  const requests: OutboundRequest[] = [];
  const pending = new Set<Promise<void>>();
  let sealed = false;
  let failure: OutboundEvidence['failure'];
  let unknownMutation = false;
  let persistence: Promise<unknown> = Promise.resolve();
  let sealedEvidence: Promise<OutboundEvidence> | undefined;
  const snapshot = (complete = false): OutboundEvidence => ({
    version: 1,
    complete: complete && !failure,
    requests: structuredClone(requests),
    ...(failure ? { failure } : {}),
  });
  const persist = (complete = false) => {
    const value = snapshot(complete);
    const write = async () => {
      try {
        await options.onEvent?.(value);
      } catch {
        failure = 'persistence_failed';
        throw new Error('Outbound evidence persistence failed');
      }
    };
    persistence = persistence.then(write, write);
    return persistence;
  };
  function handler(request: Request): Promise<Response> {
    // This fence and pending registration run synchronously, before any await.
    if (sealed) {
      failure ??= 'late_request';
      void persist().catch(() => {});
      return Promise.reject(new Error('Outbound observation admission closed'));
    }
    if (failure) return Promise.reject(new Error('Outbound observation admission closed'));
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      failure = 'invalid_request';
      return Promise.reject(new Error('Invalid outbound observation request'));
    }
    const method = request.method.toUpperCase();
    const row: OutboundRequest = {
      ordinal: requests.length + 1,
      method,
      origin: url.origin,
      pathname: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())].sort(),
      methodOverride:
        ['x-http-method-override', 'x-method-override', 'x-http-method'].some((name) =>
          request.headers.has(name),
        ) ||
        url.searchParams.has('_method') ||
        url.searchParams.has('$method'),
      dispatched: false,
      outcome: 'pending',
    };
    const mutating = !['GET', 'HEAD'].includes(method) || row.methodOverride;
    requests.push(row);
    const operation = (async () => {
      await persist();
      if (failure) throw new Error('Outbound evidence unavailable; request not forwarded');
      if (mutating && unknownMutation) {
        failure = 'uncertain_write';
        await persist();
        throw new Error('Prior outbound write is uncertain; request not forwarded');
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Outbound forwarding deadline reached'));
        }, timeoutMs);
      });
      let response: Response;
      row.dispatched = true;
      try {
        // The Miniflare bridge does not preserve the Worker's redirect mode.
        // Host auto-follow would conceal a second request from this observer.
        response = await Promise.race([
          (options.transport ?? fetch)(request, {
            redirect: 'manual',
            signal: AbortSignal.any([request.signal, controller.signal]),
          }),
          deadline,
        ]);
      } catch {
        row.outcome = 'unknown';
        if (mutating) unknownMutation = true;
        await persist();
        throw new Error('Observed outbound forwarding failed');
      } finally {
        clearTimeout(timer);
      }
      row.status = response.status;
      row.outcome =
        response.status >= 200 && response.status < 300
          ? 'acknowledged'
          : response.status >= 400 && response.status < 500 && response.status !== 408
            ? 'rejected'
            : 'unknown';
      if (row.outcome === 'unknown' && mutating) unknownMutation = true;
      try {
        await persist();
      } catch {
        // Acknowledgement cannot be erased by a later evidence or body failure.
        await response.body?.cancel().catch(() => {});
        throw new Error('Outbound acknowledgement evidence could not be retained');
      }
      return response;
    })();
    const settled = operation.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return operation;
  }
  function seal(): Promise<OutboundEvidence> {
    // Closing admission cannot wait for persistence or for a prior fetch.
    sealed = true;
    return (sealedEvidence ??= (async () => {
      await Promise.all([...pending]);
      try {
        await persist(true);
      } catch {
        /* failure is latched in the returned evidence */
      }
      return snapshot(true);
    })());
  }
  return {
    handler,
    seal,
    /** Call after Worker disposal, when no more callbacks can arrive. */
    async finalize() {
      await seal();
      try {
        await persist(true);
      } catch {
        /* failure remains latched */
      }
      return snapshot(true);
    },
    get hasUnknownMutation() {
      return unknownMutation;
    },
    get failed() {
      return failure !== undefined;
    },
  };
}
