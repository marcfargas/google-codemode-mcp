import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  prepareGmailFixture,
  gradeGmail,
  type GmailExpected,
  type GmailObservation,
} from './gmail.ts';
import type { ArtifactObservation } from './backend.ts';
import type { McpEvent } from './server.ts';

export const ARTIFACT_RESOURCE =
  'skill://google-codemode-mcp/google-workspace/references/artifacts.md';
export const ARTIFACT_CASES = ['large-json', 'binary-attachment'].map((id) => ({
  id,
  version: 1,
  policy: {
    expectedSends: 0,
    allowedMutations: [],
    requiredResourcesBeforeExecution: [ARTIFACT_RESOURCE],
  },
}));
export function getArtifactCase(id = 'large-json') {
  const item = ARTIFACT_CASES.find((item) => item.id === id);
  if (!item) throw new Error('Unknown artifact case');
  return item;
}
export function selectArtifactCases(selection = 'all') {
  const ids = selection === 'all' ? ARTIFACT_CASES.map((item) => item.id) : selection.split(',');
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('Invalid artifact case selection');
  return ids.map(getArtifactCase);
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface ArtifactExpected {
  profile: 'artifacts';
  caseId: string;
  gmail: GmailExpected;
  nativeJson?: unknown;
  size: number;
  sha256: string;
  mimeType: string;
}
export interface ArtifactTaskObservation {
  complete: boolean;
  gmail: GmailObservation;
  sourceUnchanged: boolean;
  storage: ArtifactObservation;
}
export async function prepareArtifactFixture(
  options: Omit<Parameters<typeof prepareGmailFixture>[0], 'caseId'> & { caseId: string },
) {
  const jsonCase = getArtifactCase(options.caseId).id === 'large-json';
  const seed = randomBytes(jsonCase ? 210_000 : 96_000);
  // Include every byte value so UTF-8 reinterpretation cannot satisfy the binary case.
  for (let i = 0; i < 256; i++) seed[i] = i;
  const gmail = await prepareGmailFixture({
    ...options,
    caseId: 'read-search',
    attachment: { bytes: seed, mimeType: 'application/octet-stream' },
  });
  async function nativeRead() {
    const path = jsonCase
      ? `messages/${gmail.expected.sourceId}?format=raw`
      : `messages/${gmail.expected.sourceId}/attachments/${encodeURIComponent(gmail.expected.attachment.attachmentId)}`;
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
      headers: { Authorization: `Bearer ${options.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Independent artifact source read failed');
    return response.json() as Promise<Record<string, any>>;
  }
  try {
    const baseline = await nativeRead();
    const bytes = jsonCase
      ? Buffer.from(JSON.stringify(baseline))
      : Buffer.from(baseline.data, 'base64url');
    if (jsonCase ? bytes.length <= 256000 || bytes.length >= 1000000 : !bytes.equals(seed))
      throw new Error('Artifact fixture size/content preflight failed');
    const expected: ArtifactExpected = {
      profile: 'artifacts',
      caseId: options.caseId,
      gmail: gmail.expected,
      ...(jsonCase ? { nativeJson: baseline } : {}),
      size: bytes.length,
      sha256: hash(bytes),
      mimeType: jsonCase ? 'application/json' : 'application/octet-stream',
    };
    const task = jsonCase
      ? 'Store the complete native Gmail message data returned with format raw as a JSON artifact; it is too large for inline execution output. Preserve every native field, including raw.'
      : 'Store the original attachment bytes as a binary artifact with application/octet-stream MIME, preserving every byte.';
    return {
      expected,
      manifest: gmail.manifest,
      cleanup: gmail.cleanup,
      prompt: `Find the email with exact subject "${gmail.expected.subject}". ${task} Discover the artifact contract and read its advanced reference before execution. After storing, use a separate execution to read the artifact through its corresponding Code Mode read helper and return a small inspection only. Also read its MCP resource manifest and one small chunk of at most 64 bytes. Finally delete the artifact in a later execution, after those reads. Leave Gmail unchanged. Write only answer.json with exactly {"messageId":"<source message ID>","size":<stored byte count>,"sha256":"<whole stored hash>","deleted":true}. Do not return or save the full content or base64 in the workspace.`,
      async observe(storage: ArtifactObservation): Promise<ArtifactTaskObservation> {
        const observation = await gmail.observe();
        let sourceUnchanged = false;
        try {
          sourceUnchanged = isDeepStrictEqual(await nativeRead(), baseline);
        } catch {
          observation.complete = false;
        }
        return {
          complete: observation.complete && storage.complete,
          gmail: observation,
          sourceUnchanged,
          storage,
        };
      },
    };
  } catch (error) {
    await gmail.cleanup();
    throw error;
  }
}

export function gradeArtifacts(
  expected: ArtifactExpected,
  observation: ArtifactTaskObservation | null,
  files: Record<string, string>,
  audit: McpEvent[],
) {
  const criteria = gradeGmail(expected.gmail, observation?.gmail ?? null, files, audit).filter(
    (item) => ['readback', 'no_extra_effects'].includes(item.id),
  );
  const add = (id: string, good: boolean | null, evidence: string) =>
    criteria.push({ id, status: good === null ? 'unknown' : good ? 'pass' : 'fail', evidence });
  const executions = audit.filter(
    (event) => event.method === 'tools/call' && event.params?.name === 'execute',
  );
  const records = executions.flatMap((event) =>
    (event.response?.result?.structuredContent?.artifacts?.outcomes ?? []).map((outcome: any) => ({
      event,
      outcome,
    })),
  );
  const stored = records.filter((item) => item.outcome.outcome === 'stored');
  const snapshot = observation?.storage.snapshots[0];
  const ref = snapshot?.reference;
  const matches = records.filter((item) => item.outcome.reference?.uri === ref?.uri);
  const put = stored[0];
  const read = matches.find(
    (item) =>
      item.outcome.operation === (expected.caseId === 'large-json' ? 'readJson' : 'readBytes') &&
      item.outcome.outcome === 'read',
  );
  const deleted = matches.find(
    (item) => item.outcome.operation === 'delete' && item.outcome.outcome === 'deleted',
  );
  const success = (event: McpEvent) =>
    event.status === 200 && !event.response?.error && !event.response?.result?.isError;
  const resourceReads = audit.filter(
    (event) =>
      event.method === 'resources/read' &&
      success(event) &&
      event.startedOrdinal! > put?.event.completedOrdinal! &&
      event.completedOrdinal! < deleted?.event.startedOrdinal!,
  );
  const manifest = resourceReads.find(
    (event) =>
      event.params.uri === ref?.uri &&
      typeof event.response.result?.contents?.[0]?.text === 'string',
  );
  const chunk = resourceReads.find(
    (event) =>
      event.params.uri?.startsWith(ref?.uri + '/chunk/0/') &&
      event.response.result?.contents?.[0]?._meta?.returnedBytes > 0 &&
      event.response.result.contents[0]._meta.returnedBytes <= 64 &&
      event.response.result.contents[0]._meta.offset === 0 &&
      event.response.result.contents[0]._meta.wholeSha256 === ref?.sha256 &&
      Buffer.from(event.response.result.contents[0].blob ?? '', 'base64').equals(
        Buffer.from(snapshot?.base64 ?? '', 'base64').subarray(
          0,
          event.response.result.contents[0]._meta.returnedBytes,
        ),
      ),
  );
  const contract = audit.some(
    (event) =>
      event.method === 'tools/call' &&
      event.params?.name === 'describe' &&
      event.params.arguments?.path === 'artifacts' &&
      success(event) &&
      event.response.result?.structuredContent?.enabled === true &&
      event.completedOrdinal! < Math.min(...executions.map((item) => item.startedOrdinal!)),
  );
  const ledgers =
    executions.length > 0 &&
    executions.every((event) => {
      const storage = event.response?.result?.structuredContent?.artifacts;
      return (
        success(event) &&
        storage?.outcomesComplete === true &&
        storage.hasUnknownOutcome === false &&
        Array.isArray(storage.outcomes) &&
        Array.isArray(storage.references) &&
        storage.outcomes.every(
          (item: any) =>
            typeof item?.operationId === 'string' &&
            ['putJson', 'putBytes', 'readJson', 'readBytes', 'delete'].includes(item.operation) &&
            ['stored', 'read', 'deleted'].includes(item.outcome),
        )
      );
    });
  add(
    'artifact_ledger',
    ledgers,
    'Complete trusted storage ledgers, without unknown or refused operations.',
  );
  add(
    'artifact_lifecycle',
    !!ref &&
      stored.length === 1 &&
      stored[0].outcome.reference?.uri === ref.uri &&
      stored[0].outcome.operation === (expected.caseId === 'large-json' ? 'putJson' : 'putBytes') &&
      !!read &&
      !!deleted &&
      put.event.completedOrdinal! < read.event.startedOrdinal! &&
      read.event.completedOrdinal! < deleted.event.startedOrdinal! &&
      !!manifest &&
      !!chunk &&
      contract &&
      put.event.response.result.structuredContent.outcomes.some(
        (item: any) =>
          !item.mutation &&
          item.outcome === 'acknowledged' &&
          item.path ===
            (expected.caseId === 'large-json'
              ? 'gmail/v1/users.messages.get'
              : 'gmail/v1/users.messages.attachments.get'),
      ),
    'One native-read-admitted put, later helper read, actor manifest/small-chunk reads, later deletion and prior artifact discovery.',
  );
  let content = false;
  if (ref && snapshot) {
    const bytes = Buffer.from(snapshot.base64, 'base64');
    content =
      ref.kind === (expected.caseId === 'large-json' ? 'json' : 'bytes') &&
      ref.mimeType === expected.mimeType &&
      ref.size === bytes.length &&
      ref.sha256 === hash(bytes);
    if (expected.caseId === 'large-json') {
      try {
        content &&=
          bytes.length > 256000 &&
          isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), expected.nativeJson);
      } catch {
        content = false;
      }
    } else content &&= bytes.length === expected.size && hash(bytes) === expected.sha256;
  }
  add(
    'artifact_content',
    observation?.storage.complete ? observation.storage.snapshots.length === 1 && content : null,
    'Trusted receiver reassembles and verifies the entire stored content outside model context.',
  );
  add(
    'artifact_deleted',
    observation?.storage.complete
      ? !!snapshot?.unavailableAfter && observation.storage.residualObjects === 0
      : null,
    'Independent public resource read confirms capability unavailable after actor deletion.',
  );
  add(
    'artifact_source_preserved',
    observation?.complete ? observation.sourceUnchanged : null,
    'Independent native source before/after comparison and Gmail history checks.',
  );
  let answer: any;
  try {
    answer = JSON.parse(Buffer.from(files['answer.json'] ?? '', 'base64').toString('utf8'));
  } catch {
    /* fail below */
  }
  add(
    'artifact_answer',
    Object.keys(files).join() === 'answer.json' &&
      !!ref &&
      !!answer &&
      Object.keys(answer).sort().join() === 'deleted,messageId,sha256,size' &&
      answer.deleted === true &&
      answer.messageId === expected.gmail.sourceId &&
      answer.size === ref.size &&
      answer.sha256 === ref.sha256,
    'Only the requested compact answer, with independently verified message identity, size and hash.',
  );
  return criteria;
}
export type ArtifactFixture = Awaited<ReturnType<typeof prepareArtifactFixture>>;
