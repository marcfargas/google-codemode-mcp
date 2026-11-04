import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const MAX_REQUESTS = 18;
const MAX_OUTPUT = 15_000;
const MAX_PER_REQUEST = 2048;
const MAX_INPUT_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ESTIMATED_USD = 1;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const RESPONSES_PRICING = Object.freeze({
  version: 1,
  source: 'https://developers.openai.com/api/docs/pricing',
  fetchedAt: '2026-11-04',
  basis: 'Standard USD per million tokens; estimate only, not proxy billing',
  models: Object.freeze({
    'gpt-6.1-terra': { input: 1, output: 5, cachedInput: 0.05 },
    'gpt-6.1-sol': { input: 2, output: 10, cachedInput: 0.1 },
    'gpt-6-luna': { input: 0.1, output: 0.5, cachedInput: 0.01 },
  }),
});

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Responses input exceeds evaluation limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function responseText(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Responses output exceeds evaluation limit');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validateInput(payload: any, allowedToolNames: string[]) {
  if (payload.store !== false) throw new Error('Responses storage must be disabled');
  if (payload.previous_response_id != null || payload.conversation != null)
    throw new Error('Responses server context references are not allowed');
  if (payload.background === true)
    throw new Error('Background Responses are not supported by this gate');
  if (!Array.isArray(payload.tools)) throw new Error('Responses requires explicit function tools');
  const names = new Set<string>();
  for (const tool of payload.tools) {
    if (
      tool?.type !== 'function' ||
      typeof tool.name !== 'string' ||
      !allowedToolNames.includes(tool.name) ||
      names.has(tool.name)
    )
      throw new Error('Responses tool is not in the local evaluation allowlist');
    names.add(tool.name);
  }
  if (payload.tool_choice != null && payload.tool_choice !== 'auto')
    throw new Error('Responses tool selection must remain automatic');
  if (!Array.isArray(payload.input)) throw new Error('Responses input must be self-contained');
  for (const item of payload.input) {
    if (!item || typeof item !== 'object') throw new Error('Invalid Responses input item');
    if (['item_reference', 'computer_call_output'].includes(item.type))
      throw new Error('Responses remote input references are not allowed');
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        !names.has(item.name) ||
        typeof item.arguments !== 'string'
      )
        throw new Error('Invalid retained Responses function call');
      continue;
    }
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || typeof item.output !== 'string')
        throw new Error('Responses function outputs must be text');
      continue;
    }
    if (item.type === 'reasoning') {
      if (
        !Array.isArray(item.summary) ||
        item.summary.some(
          (part: any) => part.type !== 'summary_text' || typeof part.text !== 'string',
        ) ||
        (item.encrypted_content != null && typeof item.encrypted_content !== 'string')
      )
        throw new Error('Invalid self-contained Responses reasoning item');
      continue;
    }
    if (item.type != null && item.type !== 'message')
      throw new Error('Responses input item type is unsupported');
    if (!['user', 'assistant', 'system', 'developer'].includes(item.role))
      throw new Error('Invalid Responses input role');
    if (typeof item.content === 'string') continue;
    if (
      !Array.isArray(item.content) ||
      item.content.some(
        (part: any) =>
          !['input_text', 'output_text', 'refusal'].includes(part.type) ||
          (part.type === 'refusal'
            ? typeof part.refusal !== 'string'
            : typeof part.text !== 'string'),
      )
    )
      throw new Error('Responses input must contain text only');
  }
}

function parseEvents(text: string, streaming: boolean): any[] {
  if (!streaming) return [JSON.parse(text)];
  const events: any[] = [];
  for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') events.push(JSON.parse(data));
  }
  return events;
}

export function createResponsesHandler(options: {
  proxyUrl: string;
  proxyKey: string;
  model: string;
  output: string;
  receipts: any[];
  redact: (value: string) => string;
  allowedToolNames: () => string[];
}) {
  const rates = RESPONSES_PRICING.models[options.model as keyof typeof RESPONSES_PRICING.models];
  if (!rates) throw new Error('GPT model lacks an explicit evaluation pricing entry');
  let active = false;
  let stopped = false;
  let requests = 0;
  let reservedOutput = 0;
  let estimatedUsdUpperBound = 0;
  let usageEstimatedUsd = 0;
  let completeUsage = true;
  let controller: AbortController | undefined;
  const responseIds = new Set<string>();
  const append = (name: string, value: unknown) =>
    appendFile(join(options.output, name), options.redact(JSON.stringify(value)) + '\n', {
      mode: 0o600,
    });
  return {
    abort() {
      stopped = true;
      controller?.abort();
    },
    async handle(request: IncomingMessage, response: ServerResponse) {
      if (stopped) throw new Error('Responses evaluation is closed');
      if (request.headers.authorization !== 'Bearer local-eval-relay')
        throw new Error('Invalid local Responses credential');
      const payload = JSON.parse(await readBody(request));
      if (payload.model !== options.model)
        throw new Error('Unexpected requested model; fallback is disabled');
      validateInput(payload, options.allowedToolNames());
      if (
        payload.max_output_tokens != null &&
        (!integer(payload.max_output_tokens) || payload.max_output_tokens === 0)
      )
        throw new Error('Responses output allowance must be a positive integer');
      if (stopped || active || requests >= MAX_REQUESTS || reservedOutput >= MAX_OUTPUT)
        throw new Error('Responses evaluation request/token ceiling reached');
      payload.max_output_tokens = Math.min(
        payload.max_output_tokens ?? MAX_PER_REQUEST,
        MAX_PER_REQUEST,
        MAX_OUTPUT - reservedOutput,
      );
      const serialized = JSON.stringify(payload);
      const inputBytes = Buffer.byteLength(serialized);
      // UTF-8 bytes plus framing allowance is deliberately more conservative
      // than a tokenizer estimate. Input reservations are never discounted.
      const inputTokenUpperBound = inputBytes + 256;
      const reservationUsd =
        (inputTokenUpperBound * rates.input + payload.max_output_tokens * rates.output) / 1_000_000;
      if (estimatedUsdUpperBound + reservationUsd > MAX_ESTIMATED_USD)
        throw new Error('Responses published-rate estimate ceiling reached');
      active = true;
      requests++;
      reservedOutput += payload.max_output_tokens;
      estimatedUsdUpperBound += reservationUsd;
      const record: any = {
        api: 'responses',
        request: requests,
        startedAt: new Date().toISOString(),
        requestedModel: payload.model,
        inputBytes,
        inputTokenUpperBound,
        requestSha256: hash(serialized),
        systemHash: hash(JSON.stringify(payload.instructions ?? null)),
        toolsHash: hash(JSON.stringify(payload.tools)),
        maxTokens: payload.max_output_tokens,
        reservationUsd,
        pricing: { ...RESPONSES_PRICING, models: undefined, rates },
        providerBilledCostUsd: null,
        complete: false,
        servedModels: [],
        usageEvents: [],
      };
      options.receipts.push(record);
      controller = new AbortController();
      try {
        await append('model-requests.jsonl', { ...record, payload });
        const upstream = await fetch(options.proxyUrl.replace(/\/$/, '') + '/v1/responses', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.proxyKey}`,
          },
          body: serialized,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
          redirect: 'error',
        });
        const text = options.redact(await responseText(upstream));
        record.status = upstream.status;
        record.responseSha256 = hash(text);
        const streaming =
          upstream.headers.get('content-type')?.includes('text/event-stream') ?? false;
        const events = parseEvents(text, streaming);
        const responses = streaming ? events.flatMap((event) => event.response ?? []) : events;
        record.servedModels = [
          ...new Set(
            responses.flatMap((item) => (typeof item.model === 'string' ? [item.model] : [])),
          ),
        ];
        record.terminalTypes = streaming
          ? [
              ...new Set(
                events
                  .filter((event) =>
                    [
                      'response.completed',
                      'response.failed',
                      'response.incomplete',
                      'error',
                    ].includes(event.type),
                  )
                  .map((event) => event.type),
              ),
            ]
          : ['json'];
        const terminals = streaming
          ? events
              .filter((event) =>
                ['response.completed', 'response.failed', 'response.incomplete'].includes(
                  event.type,
                ),
              )
              .map((event) => event.response)
          : events;
        const distinct = new Map<string, any>();
        let conflictingTerminals = false;
        for (const terminal of terminals) {
          if (terminal && typeof terminal.id === 'string' && terminal.id.length > 0) {
            const prior = distinct.get(terminal.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(terminal))
              conflictingTerminals = true;
            distinct.set(terminal.id, terminal);
          }
        }
        const terminal = distinct.size === 1 ? [...distinct.values()][0] : null;
        const duplicateResponse = terminal ? responseIds.has(terminal.id) : false;
        for (const id of distinct.keys()) responseIds.add(id);
        record.responseIds = [...distinct.keys()];
        record.duplicateResponse = duplicateResponse;
        record.conflictingTerminals = conflictingTerminals || distinct.size > 1;
        record.terminalState = terminal?.status ?? null;
        record.incompleteDetails = terminal?.incomplete_details ?? null;
        record.rawResponse = terminal;
        record.rawUsage = terminal?.usage ?? null;
        record.usageEvents = terminal?.usage ? [terminal.usage] : [];
        record.complete =
          upstream.ok &&
          !duplicateResponse &&
          !record.conflictingTerminals &&
          terminal?.status === 'completed' &&
          terminal?.error == null &&
          (!streaming ||
            events.some(
              (event) => event.type === 'response.completed' && event.response?.id === terminal.id,
            )) &&
          !events.some((event) =>
            ['error', 'response.failed', 'response.incomplete'].includes(event.type),
          );
        const output = terminal?.usage?.output_tokens;
        if (
          record.complete &&
          integer(output) &&
          output > 0 &&
          output <= payload.max_output_tokens
        ) {
          const refund = payload.max_output_tokens - output;
          reservedOutput -= refund;
          estimatedUsdUpperBound -= (refund * rates.output) / 1_000_000;
        }
        const input = terminal?.usage?.input_tokens;
        const cached = terminal?.usage?.input_tokens_details?.cached_tokens;
        record.invalidUsage =
          (output != null && (!integer(output) || output > payload.max_output_tokens)) ||
          (input != null && (!integer(input) || input > inputTokenUpperBound)) ||
          (cached != null && (!integer(cached) || (integer(input) && cached > input)));
        if (
          !record.invalidUsage &&
          !duplicateResponse &&
          !record.conflictingTerminals &&
          record.servedModels.length === 1 &&
          record.servedModels[0] === options.model &&
          integer(input) &&
          integer(output) &&
          integer(cached) &&
          cached <= input
        ) {
          record.usagePublishedRateEstimateUsd =
            ((input - cached) * rates.input + cached * rates.cachedInput + output * rates.output) /
            1_000_000;
          usageEstimatedUsd += record.usagePublishedRateEstimateUsd;
        } else {
          record.usagePublishedRateEstimateUsd = null;
          completeUsage = false;
        }
        record.cacheReadInputTokens = integer(cached) ? cached : null;
        record.cacheCreationInputTokens = null;
        record.modelMismatch = record.servedModels.some((model: string) => model !== options.model);
        if (record.modelMismatch) record.error = 'model_identity_mismatch';
        else if (duplicateResponse) record.error = 'response_identity_reused';
        else if (record.conflictingTerminals) record.error = 'conflicting_response_terminals';
        else if (record.invalidUsage) record.error = 'invalid_usage_telemetry';
        else if (terminal?.status === 'failed' || events.some((event) => event.type === 'error'))
          record.error = 'upstream_response_error';
        else if (!upstream.ok) record.error = 'upstream_http_error';
        record.finishedAt = new Date().toISOString();
        record.totalOutputTokensOrUpperBound = reservedOutput;
        record.estimatedUsdUpperBound = estimatedUsdUpperBound;
        record.cumulativeUsagePublishedRateEstimateUsd = completeUsage ? usageEstimatedUsd : null;
        await append('model-receipts.jsonl', record);
        response.writeHead(record.error ? 502 : upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        });
        response.end(text);
      } catch (error) {
        record.error = 'upstream_failure';
        record.complete = false;
        record.finishedAt = new Date().toISOString();
        record.totalOutputTokensOrUpperBound = reservedOutput;
        record.estimatedUsdUpperBound = estimatedUsdUpperBound;
        record.cumulativeUsagePublishedRateEstimateUsd = null;
        completeUsage = false;
        await append('model-receipts.jsonl', record);
        throw new Error(
          stopped
            ? 'Responses evaluation aborted; no retry'
            : 'Responses proxy request failed; no retry',
        );
      } finally {
        active = false;
        controller = undefined;
      }
    },
  };
}
