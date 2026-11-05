import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gradeArtifacts } from '../eval/artifacts.ts';
import { ordered, toolEvent, resourceEvent } from '../support/audit.ts';

function sample(json = false) {
  const native = { id: 'source', raw: 'x'.repeat(260000) };
  const bytes = json ? Buffer.from(JSON.stringify(native)) : Buffer.from([0, 255, 128, 10]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ref = {
    uri: 'artifact://google-codemode-mcp/v1/' + 'a'.repeat(43),
    kind: json ? 'json' : 'bytes',
    mimeType: json ? 'application/json' : 'application/octet-stream',
    size: bytes.length,
    sha256,
    createdAt: 1,
    expiresAt: 3600001,
    complete: true as const,
  };
  const gmail: any = {
    caseId: 'read-search',
    sourceId: 'source',
    threadId: 'thread',
    confirmationCode: 'nonce',
    initialSourceLabels: [],
    initialLabels: [],
    initialDraftIds: [],
    attachment: {},
  };
  const expected: any = {
    profile: 'artifacts',
    caseId: json ? 'large-json' : 'binary-attachment',
    gmail,
    size: bytes.length,
    sha256,
    mimeType: ref.mimeType,
    ...(json ? { nativeJson: native } : {}),
  };
  const storage = (operation: string, outcome: string) => ({
    outcomesComplete: true,
    hasUnknownOutcome: false,
    references: outcome === 'stored' ? [ref] : [],
    outcomes: [{ operationId: 'artifact:1', operation, outcome, reference: ref }],
  });
  const execution = (operation: string, outcome: string, nativeOutcomes: any[] = []) =>
    toolEvent('execute', {
      outcomesComplete: true,
      hasUnknownOutcome: false,
      outcomes: nativeOutcomes,
      artifacts: storage(operation, outcome),
    });
  const audit = ordered(
    toolEvent('describe', { enabled: true }, { path: 'artifacts' }),
    execution(json ? 'putJson' : 'putBytes', 'stored', [
      {
        path: json ? 'gmail/v1/users.messages.get' : 'gmail/v1/users.messages.attachments.get',
        outcome: 'acknowledged',
        mutation: false,
      },
    ]),
    execution(json ? 'readJson' : 'readBytes', 'read'),
    resourceEvent(ref.uri, '{}'),
    {
      method: 'resources/read',
      params: { uri: ref.uri + '/chunk/0/4' },
      status: 200,
      response: {
        result: {
          contents: [
            {
              blob: bytes.subarray(0, 4).toString('base64'),
              _meta: { returnedBytes: 4, offset: 0, wholeSha256: sha256 },
            },
          ],
        },
      },
    },
    execution('delete', 'deleted'),
  );
  const observation: any = {
    complete: true,
    sourceUnchanged: true,
    gmail: {
      complete: true,
      errors: [],
      source: {
        id: 'source',
        threadId: 'thread',
        labels: [],
        plainText: ['Please confirm this code: nonce\n'],
        headers: {},
        mimeComplete: true,
      },
      thread: [{ id: 'source' }],
      history: [],
      labels: [],
      newDraftIds: [],
    },
    storage: {
      residualObjects: 0,
      complete: true,
      errors: [],
      snapshots: [{ reference: ref, base64: bytes.toString('base64'), unavailableAfter: true }],
    },
  };
  const files = {
    'answer.json': Buffer.from(
      JSON.stringify({ messageId: 'source', size: ref.size, sha256, deleted: true }),
    ).toString('base64'),
  };
  return { expected, observation, files, audit };
}
const statuses = (f: ReturnType<typeof sample>) =>
  Object.fromEntries(
    gradeArtifacts(f.expected, f.observation, f.files, f.audit).map((item) => [
      item.id,
      item.status,
    ]),
  );
test('artifact graders accept exact JSON/binary lifecycles and reject untrusted or incomplete proof', () => {
  for (const json of [false, true]) {
    const f = sample(json);
    assert.ok(
      Object.values(statuses(f)).every((status) => status === 'pass'),
      JSON.stringify(statuses(f)),
    );
    for (const fault of [
      'content',
      'delete',
      'same-execution',
      'manifest',
      'unknown',
      'forged',
      'answer',
      'source',
      'references',
      'operation',
    ]) {
      const bad = structuredClone(f);
      if (fault === 'content')
        bad.observation.storage.snapshots[0].base64 = Buffer.from('{}').toString('base64');
      if (fault === 'delete') bad.observation.storage.snapshots[0].unavailableAfter = false;
      if (fault === 'same-execution') bad.audit[2].startedOrdinal = bad.audit[1].startedOrdinal;
      if (fault === 'manifest') bad.audit.splice(3, 1);
      if (fault === 'unknown')
        bad.audit[1].response.result.structuredContent.artifacts.hasUnknownOutcome = true;
      if (fault === 'forged') {
        const r = bad.audit[1].response.result.structuredContent;
        r.result = { artifacts: r.artifacts };
        delete r.artifacts;
      }
      if (fault === 'answer') bad.files['answer.json'] = Buffer.from('{}').toString('base64');
      if (fault === 'references')
        delete bad.audit[1].response.result.structuredContent.artifacts.references;
      if (fault === 'operation')
        bad.audit[1].response.result.structuredContent.artifacts.outcomes[0].operation =
          '<invalid>';
      if (fault === 'source') bad.observation.sourceUnchanged = false;
      assert.ok(
        Object.values(statuses(bad)).some((status) => status !== 'pass'),
        fault,
      );
    }
  }
});
