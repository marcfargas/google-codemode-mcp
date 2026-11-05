import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gradeSavedEvidence, regradeTrial } from '../eval/regrade.ts';
import { GRADING_VERSION } from '../eval/mechanisms.ts';
import type { McpEvent } from '../eval/server.ts';

const native = [{ type: 'result', subtype: 'success', is_error: false }];
const actor = {
  native,
  exitCode: 0,
  timedOut: false,
  files: {},
  transcript: { valid: true },
  usage: { evidence: 'retained usage' },
};
const source = { revision: 'original-execution', requestedModel: 'selected-model' };
const original = {
  status: 'error',
  error: 'original execution error',
  relayCloseError: true,
  cleanupError: true,
  hasUnknownMutation: true,
  cleanup: {
    failures: ['preserved cleanup failure'],
    unknownMutations: [{ operation: 'unknown original mutation' }],
  },
};

test('offline grading preserves original errors, cleanup and unknown mutations', () => {
  const result = gradeSavedEvidence({
    expected: null,
    observation: null,
    files: {},
    actor,
    audit: [],
    receipts: [{ requestedModel: 'selected-model', servedModels: ['other-model'], complete: true }],
    source,
    original,
    evidenceErrors: [],
  });
  assert.equal(result.status, 'error');
  assert.equal(result.gradingVersion, GRADING_VERSION);
  assert.deepEqual(result.originalResult, original);
  assert.deepEqual(result.executionSource, source);
  assert.equal(result.liveSystemQualified, false);
  assert.deepEqual(result.originalUsage, actor.usage);
  assert.equal(result.usage?.totals.outputTokens, null);
  const criteria = Object.fromEntries(
    result.criteria.map((criterion) => [criterion.id, criterion.status]),
  );
  assert.equal(criteria.model_identity, 'fail');
  assert.equal(criteria.saved_cleanup, 'fail');
  assert.equal(criteria.mutation_certainty, 'unknown');
  assert.equal(criteria.saved_execution_errors, 'fail');
  assert.equal(criteria.native_execution, 'pass');
});

test('offline command copies original source/result, records current grader and retains missing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-regrade-'));
  const saved = join(root, 'trial-1');
  const output = join(root, 'regraded');
  try {
    await mkdir(saved);
    const sourceText = JSON.stringify(source, null, 4) + '\n';
    const originalText = JSON.stringify(original, null, 4) + '\n';
    await writeFile(join(root, 'source.json'), sourceText);
    await writeFile(join(saved, 'result.json'), originalText);
    await writeFile(join(saved, 'actor-result.json'), JSON.stringify(actor));
    await writeFile(join(saved, 'files.json'), '{}');
    await writeFile(join(saved, 'observation.json'), 'null');
    await writeFile(join(saved, 'mcp.jsonl'), 'malformed saved receipt\n');
    await writeFile(join(saved, 'model-receipts.jsonl'), '');
    const result = await regradeTrial(saved, output);
    assert.equal(result.status, 'error');
    assert.equal(await readFile(join(output, 'source.json'), 'utf8'), sourceText);
    assert.equal(await readFile(join(output, 'result.json'), 'utf8'), originalText);
    assert.equal(await readFile(join(saved, 'result.json'), 'utf8'), originalText);
    assert.ok(result.inputs['source.json'].sha256);
    assert.ok(result.gradingIdentity.files['regrade.ts']);
    assert.ok(result.gradingIdentity.files['mechanisms.ts']);
    assert.ok(result.gradingIdentity.files['cases.ts']);
    assert.equal(result.gradingVersion, GRADING_VERSION);
    const completeness = result.criteria.find(
      (criterion) => criterion.id === 'evidence_completeness',
    );
    assert.equal(completeness?.status, 'unknown');
    assert.match(completeness!.evidence, /expected.json/);
    assert.match(completeness!.evidence, /mcp.jsonl/);
    await assert.rejects(regradeTrial(saved, output), /EEXIST/);
    await assert.rejects(regradeTrial(saved, join(saved, 'nested-output')), /outside saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const savedAudit = (): McpEvent[] => {
  const path = 'gmail/v1/users.messages.get';
  const uri = 'skill://google-codemode-mcp/google-workspace/SKILL.md';
  return [
    {
      method: 'tools/call',
      params: { name: 'describe', arguments: {} },
      response: { result: { structuredContent: { services: [] } } },
    },
    {
      method: 'resources/read',
      params: { uri },
      response: { result: { contents: [{ uri, text: '# Google Workspace Code Mode' }] } },
    },
    {
      method: 'tools/call',
      params: { name: 'describe', arguments: { path } },
      response: { result: { structuredContent: { path, signature: 'get(params)' } } },
    },
    {
      method: 'tools/call',
      params: { name: 'execute' },
      response: {
        result: {
          structuredContent: {
            outcomes: [{ path, mutation: false, outcome: 'acknowledged' }],
            outcomesComplete: true,
            hasUnknownOutcome: false,
          },
        },
      },
    },
  ].map((event, index) => ({
    ...event,
    status: 200,
    startedOrdinal: 2 * index + 1,
    completedOrdinal: 2 * index + 2,
  }));
};
const attemptRecords = (audit: McpEvent[]) =>
  audit.map((event) => ({
    method: event.method,
    params: event.params,
    startedOrdinal: event.startedOrdinal,
    status: 0,
    response: { pending: true },
  }));
const regrade = (audit: McpEvent[], attempts?: McpEvent[] | null) =>
  gradeSavedEvidence({
    // Task evidence is intentionally incomplete; these tests isolate mechanism evidence.
    expected: { caseId: 'read-search' } as any,
    observation: null,
    files: {},
    actor,
    audit,
    attempts,
    receipts: [],
    source: {
      ...source,
      mechanismPolicy: { expectedSends: 0, allowedMutations: ['gmail/v1/users.messages.send'] },
    },
    original: {
      status: 'pass',
      hasUnknownMutation: false,
      cleanup: { failures: [], unknownMutations: [] },
    },
    evidenceErrors: [],
  });
const criterion = (result: ReturnType<typeof regrade>, id: string) =>
  result.criteria.find((c) => c.id === id)?.status;

test('offline grading uses the maintained case policy and preserves old results under new version', () => {
  const audit = savedAudit();
  const result = regrade(audit, attemptRecords(audit));
  assert.equal(criterion(result, 'method_discovery'), 'pass');
  assert.equal(criterion(result, 'send_ledger'), 'pass');
  const legacy = savedAudit();
  for (const event of legacy) {
    delete event.startedOrdinal;
    delete event.completedOrdinal;
  }
  const historical = regrade(legacy);
  assert.equal(criterion(historical, 'method_discovery'), 'unknown');
  assert.equal(historical.originalResult?.status, 'pass');
  assert.equal(historical.gradingVersion, GRADING_VERSION);

  audit[3].response.result.structuredContent.outcomes.push({
    path: 'gmail/v1/users.messages.send',
    mutation: true,
    outcome: 'not_dispatched',
  });
  assert.equal(criterion(regrade(audit, attemptRecords(audit)), 'actor_mutation_surface'), 'fail');
});

test('offline grading retains abandoned attempts and rejects inconsistent attempt/completion joins', () => {
  const audit = savedAudit();
  const attempts = attemptRecords(audit);
  attempts.push({
    method: 'tools/call',
    params: { name: 'execute' },
    startedOrdinal: 9,
    status: 0,
    response: { pending: true },
  });
  const interrupted = regrade(audit, attempts);
  assert.equal(criterion(interrupted, 'method_discovery'), 'unknown');
  assert.equal(criterion(interrupted, 'mutation_certainty'), 'unknown');
  assert.equal(criterion(regrade(audit, null), 'method_discovery'), 'unknown');
  for (const mutate of [
    (entries: McpEvent[]) => {
      entries.pop();
    },
    (entries: McpEvent[]) => {
      entries.push(entries[0]);
    },
    (entries: McpEvent[]) => {
      entries[3].params = { name: 'different' };
    },
    (entries: McpEvent[]) => {
      entries[3].completedOrdinal = 8;
    },
  ]) {
    const entries = attemptRecords(savedAudit());
    mutate(entries);
    assert.equal(criterion(regrade(audit, entries), 'method_discovery'), 'unknown');
  }
});

test('offline Drive limitation grading applies maintained discovery policy and cannot widen mutations', () => {
  const expected = {
    caseId: 'conditional-update-unsupported' as const,
    fileId: 'owned-id',
    name: 'owned.txt',
    renamed: 'renamed.txt',
    filename: 'owned.txt',
    sha256: 'independent-hash',
    bytes: 17,
    mimeType: 'text/plain',
    marker: 'owned-marker',
    parents: ['root'],
    version: '7',
  };
  const observation = {
    complete: true,
    file: {
      id: expected.fileId,
      name: expected.name,
      mimeType: expected.mimeType,
      trashed: false,
      description: expected.marker,
      parents: expected.parents,
      version: '7',
    },
    sha256: expected.sha256,
    bytes: expected.bytes,
  };
  const files = {
    'status.json': Buffer.from(
      JSON.stringify({
        fileId: expected.fileId,
        renamed: false,
        reason: 'conditional-update-unsupported',
      }),
    ).toString('base64'),
  };
  const uri = 'skill://google-codemode-mcp/google-workspace/SKILL.md';
  const describe = (path: string) => ({
    method: 'tools/call',
    params: { name: 'describe', arguments: { path } },
    response: { result: { structuredContent: { path, signature: 'method(params)' } } },
  });
  const events = [
    {
      method: 'tools/call',
      params: { name: 'describe', arguments: {} },
      response: { result: { structuredContent: { services: [] } } },
    },
    {
      method: 'resources/read',
      params: { uri },
      response: { result: { contents: [{ uri, text: '# Google Workspace Code Mode' }] } },
    },
    describe('drive/v3/files.update'),
    describe('drive/v3/files.get'),
    {
      method: 'tools/call',
      params: { name: 'execute' },
      response: {
        result: {
          structuredContent: {
            status: 'completed',
            outcomesComplete: true,
            hasUnknownOutcome: false,
            outcomes: [
              {
                path: 'drive/v3/files.get',
                mutation: false,
                outcome: 'acknowledged',
                resourceId: expected.fileId,
              },
            ],
          },
        },
      },
    },
  ].map((e, i) => ({
    ...e,
    status: 200,
    startedOrdinal: i * 2 + 1,
    completedOrdinal: i * 2 + 2,
  })) as McpEvent[];
  const outbound = {
    version: 1,
    complete: true,
    workerDisposed: true,
    requests: [
      {
        ordinal: 1,
        method: 'GET',
        origin: 'https://www.googleapis.com',
        pathname: '/drive/v3/files/' + expected.fileId,
        queryKeys: [],
        methodOverride: false,
        dispatched: true,
        outcome: 'acknowledged',
        status: 200,
      },
    ],
  };
  const grade = (
    audit: McpEvent[],
    attempts: McpEvent[] | null = attemptRecords(audit),
    recording: unknown = outbound,
  ) =>
    gradeSavedEvidence({
      expected,
      observation,
      files,
      actor: { ...actor, files },
      audit,
      attempts,
      receipts: [
        { requestedModel: 'selected-model', servedModels: ['selected-model'], complete: true },
      ],
      source: {
        ...source,
        profile: 'drive',
        mechanismPolicy: { allowedMutations: ['drive/v3/files.update'] },
      },
      original: {
        status: 'pass',
        hasUnknownMutation: false,
        cleanup: { failures: [], unknownMutations: [] },
      },
      evidenceErrors: [],
      outbound: recording,
    });
  assert.equal(grade(events).status, 'pass');
  assert.equal(
    grade(events, attemptRecords(events), null).criteria.find(
      (c) => c.id === 'drive_outbound_reads_only',
    )?.status,
    'unknown',
  );
  assert.equal(grade(events).gradingVersion, 4);
  const noUpdate = structuredClone(events);
  noUpdate[2].params.arguments.path = 'drive/v3/files.list';
  noUpdate[2].response.result.structuredContent.path = 'drive/v3/files.list';
  assert.equal(
    grade(noUpdate).criteria.find((c) => c.id === 'required_method_discovery')?.status,
    'fail',
  );
  const mutation = structuredClone(events);
  mutation.at(-1)!.response.result.structuredContent.outcomes.push({
    path: 'drive/v3/files.update',
    mutation: true,
    outcome: 'not_dispatched',
  });
  assert.equal(
    grade(mutation).criteria.find((c) => c.id === 'actor_mutation_surface')?.status,
    'fail',
  );
  assert.equal(grade(mutation).taskSuccess, false);
  assert.equal(
    grade(events, null).criteria.find((c) => c.id === 'required_method_discovery')?.status,
    'unknown',
  );
});
