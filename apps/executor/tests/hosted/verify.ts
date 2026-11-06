import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_VERSION,
  PROTOCOL_VERSION,
  PROBE_NAMES,
  SYNTHETIC_TOKEN,
  type Probe,
} from './contract.ts';

type Status = 'pass' | 'fail' | 'unknown';
export interface ProbeResult {
  status: Status;
  evidence: string;
}
interface Identity {
  candidateDigest: string;
  workerVersion: string;
}
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const outside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '..' || path.startsWith('../');
};
async function boundedText(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 524288) {
      await reader.cancel();
      throw new Error('Verification response exceeds byte limit');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Only a platform CPU-specific exception qualifies CPU enforcement. */
export function gradeProbe(probe: Probe, receipt: unknown, expected: Identity): ProbeResult {
  const unknown = (evidence: string): ProbeResult => ({ status: 'unknown', evidence });
  const checked = (pass: boolean, evidence: string): ProbeResult => ({
    status: pass ? 'pass' : 'fail',
    evidence,
  });
  if (
    !object(receipt) ||
    receipt.harnessVersion !== HARNESS_VERSION ||
    receipt.protocolVersion !== PROTOCOL_VERSION ||
    receipt.probe !== probe ||
    receipt.syntheticGoogle !== true
  )
    return unknown('Missing or mismatched verification receipt');
  if (
    receipt.candidateDigest !== expected.candidateDigest ||
    receipt.workerVersion?.id !== expected.workerVersion
  )
    return {
      status: 'fail',
      evidence: 'Candidate digest or deployed Worker version does not match the selected candidate',
    };
  if (
    receipt.limits?.innerCpuMs !== 1000 ||
    receipt.limits?.innerSubRequests !== 1 ||
    receipt.limits?.innerNetworkDenied !== true ||
    receipt.limits?.executorTimeoutMs !== 15000
  )
    return {
      status: 'fail',
      evidence: 'Production executor limits differ from the selected verification contract',
    };
  const execution = receipt.execution;
  const dispatches = receipt.dispatches;
  if (
    !object(execution) ||
    execution.outcomesComplete !== true ||
    !Array.isArray(execution.outcomes) ||
    typeof execution.hasUnknownOutcome !== 'boolean' ||
    !Array.isArray(dispatches) ||
    !Number.isSafeInteger(receipt.syntheticEffects) ||
    receipt.syntheticEffects < 0 ||
    !Number.isSafeInteger(receipt.dispatchesAtClose) ||
    !Number.isFinite(receipt.closedAtMs) ||
    !Number.isFinite(receipt.elapsedMs) ||
    receipt.elapsedMs < receipt.closedAtMs
  )
    return unknown('Incomplete execution or dispatch-counter evidence');
  if (
    !dispatches.every(
      (entry, index) =>
        object(entry) &&
        entry.sequence === index + 1 &&
        ['GET', 'POST'].includes(entry.method) &&
        typeof entry.afterClose === 'boolean' &&
        typeof entry.aborted === 'boolean' &&
        Number.isFinite(entry.atMs),
    )
  )
    return unknown('Malformed dispatch counter');
  if (
    JSON.stringify({ execution, executorSignal: receipt.executorSignal }).includes(SYNTHETIC_TOKEN)
  )
    return checked(false, 'Synthetic request credential escaped its trusted boundary');
  if (
    dispatches.some((entry) => entry.afterClose) ||
    dispatches.length !== receipt.dispatchesAtClose
  )
    return {
      status: 'fail',
      evidence: 'A synthetic Google dispatch occurred after execution closed',
    };
  const outcomes = execution.outcomes;
  const ledger = (expected: [boolean, string, string][]) =>
    outcomes.length === expected.length &&
    expected.every(
      ([mutation, method, state], index) =>
        outcomes[index]?.mutation === mutation &&
        outcomes[index]?.path === `gmail/v1/users.messages.${method}` &&
        outcomes[index]?.outcome === state,
    );
  if (probe === 'mutationUnknown')
    return checked(
      execution.status === 'completed' &&
        execution.hasUnknownOutcome === true &&
        receipt.syntheticEffects === 1 &&
        JSON.stringify(dispatches.map((entry) => entry.method)) === '["POST","GET"]' &&
        ledger([
          [true, 'send', 'unknown'],
          [true, 'send', 'not_dispatched'],
          [true, 'send', 'not_dispatched'],
          [false, 'list', 'acknowledged'],
        ]) &&
        execution.result?.dispatch === 2,
      'One lost-response synthetic write effect, queued/subsequent writes fenced, and read acknowledged',
    );
  if (probe === 'mutationAcknowledged')
    return checked(
      execution.status === 'error' &&
        execution.hasUnknownOutcome === false &&
        String(execution.error).includes('Program failed after acknowledged write') &&
        receipt.syntheticEffects === 1 &&
        dispatches.length === 1 &&
        dispatches[0].method === 'POST' &&
        ledger([[true, 'send', 'acknowledged']]),
      'Acknowledged synthetic effect survives a later program error',
    );
  if (probe === 'isolation')
    return checked(
      execution.status === 'completed' &&
        execution.hasUnknownOutcome === false &&
        receipt.syntheticEffects === 0 &&
        dispatches.length === 1 &&
        dispatches[0].method === 'GET' &&
        ledger([
          [false, 'list', 'not_dispatched'],
          [false, 'list', 'not_dispatched'],
          [false, 'list', 'not_dispatched'],
          [false, 'list', 'acknowledged'],
        ]) &&
        execution.result?.networkBlocked === true &&
        execution.result?.token === 'undefined' &&
        execution.result?.environment === 'undefined' &&
        JSON.stringify(execution.result?.errors) ===
          '["INVALID_PARAMS","INVALID_PARAMS","INVALID_PARAMS","client","options"]' &&
        execution.result?.read?.dispatch === 1 &&
        execution.result?.echoRedactedBeforeReturn === true &&
        execution.result?.read?.credentialEcho === '[REDACTED]',
      'Loaded networking denied, transport overrides refused, credential hidden and upstream echo redacted before RPC',
    );
  if (
    execution.hasUnknownOutcome !== false ||
    receipt.syntheticEffects !== 0 ||
    dispatches.some((entry) => entry.method !== 'GET')
  )
    return checked(false, 'Unexpected mutation or uncertainty in synthetic read-only probe');
  if (
    execution.outcomes.some(
      (outcome: any) =>
        !object(outcome) ||
        outcome.mutation !== false ||
        outcome.path !== 'gmail/v1/users.messages.list',
    )
  )
    return {
      status: 'fail',
      evidence: 'Unexpected method or mutation in synthetic read-only probe',
    };
  if (probe === 'identity')
    return checked(
      execution.status === 'completed' &&
        execution.result === 'identity' &&
        dispatches.length === 0,
      'Prepared source digest and platform version metadata matched',
    );
  if (probe === 'cpu') {
    const signal = receipt.executorSignal;
    if (execution.status !== 'error')
      return {
        status: 'fail',
        evidence: 'CPU-bound program did not terminate with an execution error',
      };
    if (
      !object(signal) ||
      signal.kind !== 'threw' ||
      typeof signal.error !== 'string' ||
      !/(?:exceed(?:ed|s)?\s+(?:the\s+)?cpu(?:\s+time)?\s+limit|cpu(?:\s+time)?\s+limit\s+(?:was\s+)?exceeded)/i.test(
        signal.error,
      )
    )
      return unknown(
        'Execution failed without a CPU-specific platform exception; outer timeout, resource-limit and generic errors do not prove CPU enforcement',
      );
    return checked(
      dispatches.length === 0 && execution.outcomes.length === 0,
      'CPU-specific platform exception observed from the dynamic Worker executor',
    );
  }
  if (probe === 'asyncTimeout')
    return checked(
      execution.status === 'error' &&
        receipt.executorSignal?.kind === 'returned' &&
        receipt.executorSignal?.error === 'Execution timed out' &&
        receipt.closedAtMs >= 14500 &&
        receipt.closedAtMs < 25000 &&
        receipt.observeMs >= 1500 &&
        receipt.elapsedMs >= receipt.closedAtMs + 1400 &&
        dispatches.length === 0,
      'Production 15-second asynchronous timeout returned and no delayed Google call dispatched during the observation window',
    );
  if (probe === 'delayed' || probe === 'unawaited')
    return checked(
      execution.status === 'completed' &&
        receipt.observeMs >= 350 &&
        receipt.elapsedMs >= receipt.closedAtMs + 300 &&
        (probe === 'delayed'
          ? dispatches.length === 0 && execution.result === 'scheduled'
          : dispatches.length === 1 && dispatches[0].aborted && execution.result === 'in flight'),
      'Late/unawaited work was observed beyond its scheduled delay with no post-close dispatch',
    );
  const count = probe === 'multiple' ? 5 : 1;
  return checked(
    execution.status === 'completed' &&
      dispatches.length === count &&
      execution.outcomes.length === count &&
      execution.outcomes.every((outcome: any) => outcome.outcome === 'acknowledged') &&
      (probe === 'multiple'
        ? JSON.stringify(execution.result) === '[1,2,3,4,5]'
        : execution.result?.dispatch === 1),
    probe === 'multiple'
      ? 'Five synthetic Google calls completed under the production subRequests:1 limit'
      : 'Healthy follow-up completed through the production executor and dispatcher',
  );
}

export async function verifyHosted(output: string) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const endpoint = new URL(required('HOSTED_VERIFICATION_URL'));
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/mcp'
  )
    throw new Error('Use the owner-provided protected HTTPS /mcp URL without embedded credentials');
  const values: unknown = JSON.parse(required('HOSTED_ACCESS_HEADERS_JSON'));
  if (
    !object(values) ||
    !Object.keys(values).length ||
    !Object.values(values).every(
      (value) => typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value),
    )
  )
    throw new Error('Use private authentication headers as a JSON object');
  const headers = new Headers(values as Record<string, string>);
  const expected = {
    candidateDigest: required('HOSTED_EXPECTED_CANDIDATE_DIGEST'),
    workerVersion: required('HOSTED_EXPECTED_WORKER_VERSION'),
  };
  if (
    !/^[a-f0-9]{64}$/.test(expected.candidateDigest) ||
    !/^[A-Za-z0-9-]{1,100}$/.test(expected.workerVersion)
  )
    throw new Error('Invalid expected candidate identity');
  const prepared = required('HOSTED_PREPARED_DIR');
  if (!isAbsolute(prepared)) throw new Error('Prepared candidate directory must be absolute');
  const manifestText = await readFile(join(prepared, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  // Mode-less manifests retain their original source-only identity for replay.
  if (manifest.mode !== undefined && manifest.mode !== 'probes')
    throw new Error('Runtime probe verification requires a probes candidate');
  const preparedDigest = hash(
    JSON.stringify(
      manifest.mode === undefined
        ? manifest.sourceFiles
        : { mode: manifest.mode, sourceFiles: manifest.sourceFiles },
    ),
  );
  if (
    manifest.sourceDigest !== expected.candidateDigest ||
    preparedDigest !== expected.candidateDigest ||
    manifest.bundleSha256 !== hash(await readFile(join(prepared, 'worker.js')))
  )
    throw new Error('Retained prepared candidate identity or bundle hash mismatch');
  const checkout = fileURLToPath(new URL('../../../../', import.meta.url).href);
  if (!isAbsolute(output) || !outside(checkout, output) || !outside(prepared, output))
    throw new Error(
      'Use a new absolute evidence directory outside checkout and prepared candidate',
    );
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, 'prepared-manifest.json'), manifestText, { mode: 0o600 });
  const secrets = Object.values(values) as string[];
  const redact = (text: string) =>
    secrets.reduce(
      (result, secret) =>
        result
          .replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]')
          .replaceAll(secret, '[REDACTED]'),
      text,
    );
  const results: {
    probe: Probe;
    requestId: string;
    grade: ProbeResult;
    elapsedMs: number;
    httpStatus?: number;
  }[] = [];
  async function attempt(probe: Probe) {
    const requestId = randomUUID();
    const started = Date.now();
    const index = results.length + 1;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { accessToken: SYNTHETIC_TOKEN, code: probe, requestId },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    headers.set('MCP-Protocol-Version', PROTOCOL_VERSION);
    headers.set('MCP-Method', 'tools/call');
    headers.set('MCP-Name', 'execute');
    let httpStatus: number | undefined;
    let grade: ProbeResult;
    let raw: unknown;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        redirect: 'manual',
        signal: controller.signal,
      });
      httpStatus = response.status;
      const text = redact(await boundedText(response));
      raw = {
        httpStatus,
        body: text,
        cfRay: response.headers.get('cf-ray'),
        contentType: response.headers.get('content-type'),
        session: response.headers.has('mcp-session-id'),
      };
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* Raw failure remains retained. */
      }
      grade =
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json') ||
        response.headers.has('mcp-session-id') ||
        parsed?.error ||
        parsed?.result?.isError ||
        parsed?.id !== requestId ||
        parsed?.result?.structuredContent?.requestId !== requestId
          ? {
              status: 'unknown',
              evidence:
                'No complete, correlated, finite sessionless verification receipt; HTTP errors and 1102 alone do not prove CPU enforcement',
            }
          : gradeProbe(probe, parsed.result.structuredContent, expected);
    } catch {
      grade = {
        status: 'unknown',
        evidence: controller.signal.aborted
          ? 'Outer HTTP deadline elapsed; this is not proof of CPU termination'
          : 'Transport failed; no automatic retry performed',
      };
      raw = { failure: grade.evidence };
    } finally {
      clearTimeout(timer);
    }
    const result = {
      probe,
      requestId,
      grade,
      elapsedMs: Date.now() - started,
      ...(httpStatus ? { httpStatus } : {}),
    };
    results.push(result);
    await writeFile(
      join(output, `${String(index).padStart(2, '0')}-${probe}.json`),
      redact(JSON.stringify({ request, result, raw }, null, 2)) + '\n',
      { mode: 0o600 },
    );
    console.log(`${probe}: ${grade.status}`);
    return grade.status === 'pass';
  }
  const identity = await attempt('identity');
  if (identity) {
    for (const probe of PROBE_NAMES.filter((probe) => !['identity', 'healthy'].includes(probe))) {
      await attempt(probe);
      // Planned liveness observation is a distinct request, never a retry of the probe.
      if (!(await attempt('healthy'))) break;
    }
  }
  const complete = results.length === 1 + 2 * (PROBE_NAMES.length - 2);
  const report = {
    harnessVersion: HARNESS_VERSION,
    expected,
    endpoint: endpoint.origin + endpoint.pathname,
    preparedManifestSha256: hash(manifestText),
    completedAt: new Date().toISOString(),
    status: results.some((result) => result.grade.status === 'fail')
      ? 'fail'
      : complete && results.every((result) => result.grade.status === 'pass')
        ? 'pass'
        : 'unknown',
    hostedQualified: complete && results.every((result) => result.grade.status === 'pass'),
    syntheticGoogle: true,
    results,
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyHosted(process.argv[2] ?? '')
    .then((report) => {
      console.log(`Hosted verification: ${report.status}`);
      if (!report.hostedQualified) process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        'Hosted verification did not complete; inspect retained receipts and private environment prerequisites',
      );
      process.exitCode = 1;
    });
}
