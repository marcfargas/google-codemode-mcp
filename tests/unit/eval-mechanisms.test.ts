import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeMechanisms, GRADING_VERSION, type MechanismPolicy } from '../eval/mechanisms.ts';
import type { McpEvent } from '../eval/server.ts';

const get = 'gmail/v1/users.messages.get';
const send = 'gmail/v1/users.messages.send';
const skillUri = 'skill://google-codemode-mcp/google-workspace/SKILL.md';
const readOnly: MechanismPolicy = { expectedSends: 0, allowedMutations: [] };
const event = (method: string, params: any, result: any): McpEvent => ({
  method,
  params,
  status: 200,
  response: { result },
});
const describe = (path?: string) =>
  event(
    'tools/call',
    { name: 'describe', arguments: path ? { path } : {} },
    {
      structuredContent: path
        ? { path, signature: 'method(params)' }
        : { services: [{ name: 'gmail' }] },
    },
  );
const skill = () =>
  event(
    'resources/read',
    { uri: skillUri },
    {
      contents: [{ uri: skillUri, text: '# Google Workspace Code Mode' }],
    },
  );
const outcome = (path = get, mutation = false, state = 'acknowledged') => ({
  path,
  mutation,
  outcome: state,
});
const execute = (outcomes = [outcome()], name = 'execute') =>
  event(
    'tools/call',
    { name },
    {
      structuredContent: {
        outcomes,
        outcomesComplete: true,
        hasUnknownOutcome: outcomes.some((o) => o.mutation && o.outcome === 'unknown'),
      },
    },
  );
const ordered = (...events: McpEvent[]) =>
  events.map((entry, index) => ({
    ...entry,
    startedOrdinal: 2 * index + 1,
    completedOrdinal: 2 * index + 2,
  }));
const basic = () => ordered(describe(), skill(), describe(get), execute());
const statuses = (audit: McpEvent[], policy: MechanismPolicy = readOnly) =>
  Object.fromEntries(gradeMechanisms(audit, policy).map((c) => [c.id, c.status]));

test('grading version 3 uses all ledger methods and supports exact per-case policies', () => {
  assert.equal(GRADING_VERSION, 3);
  assert.ok(Object.values(statuses(basic())).every((status) => status === 'pass'));
  const combined = ordered(describe(), skill(), describe(send), execute([outcome(send, true)]));
  assert.ok(gradeMechanisms(combined).every((c) => c.status === 'pass'));
  assert.equal(statuses(combined).actor_mutation_surface, 'fail');
  assert.equal(statuses(combined).send_ledger, 'fail');
  assert.throws(() => gradeMechanisms(basic(), { expectedSends: -1, allowedMutations: [] }));
});

test('an unrelated method, late description or overlapping description cannot cover a call', () => {
  const unused = basic();
  unused[2] = { ...describe(send), startedOrdinal: 5, completedOrdinal: 6 };
  assert.equal(statuses(unused).method_discovery, 'fail');
  assert.equal(
    statuses(ordered(describe(), skill(), execute(), describe(get))).method_discovery,
    'fail',
  );
  const concurrent = basic();
  concurrent[2].completedOrdinal = 7;
  concurrent[3].startedOrdinal = 6;
  assert.equal(statuses(concurrent).method_discovery, 'fail');
});

test('all methods need a matching returned canonical path and successful signature', () => {
  const audit = basic();
  audit[3] = {
    ...execute([outcome(), outcome('drive/v3/files.get')]),
    startedOrdinal: 7,
    completedOrdinal: 8,
  };
  assert.equal(statuses(audit).method_discovery, 'fail');
  for (const mutate of [
    (entry: McpEvent) => {
      entry.response.result.structuredContent.path = send;
    },
    (entry: McpEvent) => {
      entry.response.result.structuredContent.signature = '';
    },
    (entry: McpEvent) => {
      entry.response.result.isError = true;
    },
    (entry: McpEvent) => {
      entry.response.error = { code: -1 };
    },
    (entry: McpEvent) => {
      entry.status = 500;
    },
  ]) {
    const changed = basic();
    mutate(changed[2]);
    assert.equal(statuses(changed).method_discovery, 'fail');
  }
});

test('previous completed discovery covers repeat calls and services other than Gmail', () => {
  const path = 'drive/v3/files.get';
  const audit = ordered(
    describe(),
    skill(),
    describe(path),
    execute([outcome(path)]),
    execute([outcome(path), outcome(path)]),
  );
  // Saved JSONL is completion ordered; array positions never provide causal proof.
  audit.reverse();
  assert.ok(Object.values(statuses(audit)).every((status) => status === 'pass'));
});

test('snippet tools and rejected/not-dispatched paths receive the same coverage rule', () => {
  for (const name of ['execute', 'gmail_inbox']) {
    for (const state of ['rejected', 'not_dispatched']) {
      const audit = ordered(
        describe(),
        skill(),
        describe(get),
        execute([outcome(get, false, state)], name),
      );
      assert.equal(statuses(audit).method_discovery, 'pass');
      audit[2] = { ...describe('snippets'), startedOrdinal: 5, completedOrdinal: 6 };
      assert.equal(statuses(audit).method_discovery, 'fail');
    }
  }
  assert.equal(
    statuses(ordered(describe(), skill(), execute([outcome('<invalid>', true, 'not_dispatched')])))
      .method_discovery,
    'fail',
  );
});

test('root and actual skill retrieval must complete before first execution', () => {
  assert.equal(
    statuses(ordered(skill(), describe(get), execute(), describe())).root_discovery,
    'fail',
  );
  assert.equal(
    statuses(ordered(describe(), describe(get), execute(), skill())).skill_resource,
    'fail',
  );
  const audit = basic();
  audit[1].response.result.contents[0].uri = 'skill://unrelated';
  assert.equal(statuses(audit).skill_resource, 'fail');
  audit[0].response.result.isError = true;
  assert.equal(statuses(audit).root_discovery, 'fail');
});

test('legacy, duplicated, missing, invalid or contradictory ordinals are unknown', () => {
  for (const change of [
    (audit: McpEvent[]) => {
      for (const e of audit) {
        delete e.startedOrdinal;
        delete e.completedOrdinal;
      }
    },
    (audit: McpEvent[]) => {
      delete audit[2].completedOrdinal;
    },
    (audit: McpEvent[]) => {
      audit[2].completedOrdinal = audit[1].completedOrdinal;
    },
    (audit: McpEvent[]) => {
      audit[2].completedOrdinal = 0;
    },
    (audit: McpEvent[]) => {
      audit[2].completedOrdinal = 6.5;
    },
    (audit: McpEvent[]) => {
      audit[2].startedOrdinal = 6;
      audit[2].completedOrdinal = 5;
    },
    (audit: McpEvent[]) => {
      audit[3].completedOrdinal = 9;
    },
    (audit: McpEvent[]) => {
      audit.push(null as unknown as McpEvent);
    },
  ]) {
    const audit = basic();
    change(audit);
    assert.ok(Object.values(statuses(audit)).every((status) => status === 'unknown'));
  }
});

test('missing, truncated and malformed trusted ledgers cannot pass from actor result data', () => {
  for (const change of [
    (receipt: any) => {
      delete receipt.outcomes;
    },
    (receipt: any) => {
      delete receipt.outcomesComplete;
    },
    (receipt: any) => {
      receipt.outcomesComplete = false;
    },
    (receipt: any) => {
      receipt.outcomes = [null];
    },
    (receipt: any) => {
      receipt.outcomes[0].mutation = 'false';
    },
    (receipt: any) => {
      receipt.outcomes[0].outcome = 'success';
    },
    (receipt: any) => {
      delete receipt.hasUnknownOutcome;
    },
    (receipt: any) => {
      receipt.hasUnknownOutcome = true;
    },
  ]) {
    const audit = basic();
    const receipt = audit[3].response.result.structuredContent;
    receipt.result = { outcomes: [outcome()], outcomesComplete: true };
    change(receipt);
    const result = statuses(audit);
    assert.equal(result.method_discovery, 'unknown');
    assert.equal(result.send_ledger, 'unknown');
    assert.equal(result.actor_mutation_surface, 'unknown');
  }
});

test('known unknown mutations fail the send ledger and exact paths restrict failed attempts too', () => {
  const audit = ordered(
    describe(),
    skill(),
    describe(send),
    execute([outcome(send, true, 'unknown')]),
  );
  assert.equal(statuses(audit).send_ledger, 'fail');
  assert.equal(statuses(audit).actor_mutation_surface, 'fail');
  assert.equal(statuses(audit).method_discovery, 'pass');
  const refused = ordered(
    describe(),
    skill(),
    describe(send),
    execute([outcome(send, true, 'not_dispatched')]),
  );
  assert.equal(statuses(refused).actor_mutation_surface, 'fail');
});

test('no executions fail while a complete no-call receipt has vacuous method coverage only', () => {
  assert.ok(Object.values(statuses([])).every((status) => status === 'fail'));
  const audit = ordered(describe(), skill(), execute([]));
  assert.equal(statuses(audit).method_discovery, 'pass');
  assert.equal(gradeMechanisms(audit).find((c) => c.id === 'send_ledger')?.status, 'fail');
});

test('case-required unused methods must be described successfully before first execution', () => {
  const update = 'drive/v3/files.update';
  const policy = { ...readOnly, requiredDescriptionsBeforeExecution: [update] };
  assert.equal(statuses(basic(), policy).required_method_discovery, 'fail');
  assert.equal(
    statuses(ordered(describe(), skill(), describe(get), describe(update), execute()), policy)
      .required_method_discovery,
    'pass',
  );
  assert.equal(
    statuses(ordered(describe(), skill(), describe(get), execute(), describe(update)), policy)
      .required_method_discovery,
    'fail',
  );
  for (const change of [
    (e: McpEvent) => {
      e.response.result.structuredContent.path = get;
    },
    (e: McpEvent) => {
      e.response.result.structuredContent.signature = '';
    },
    (e: McpEvent) => {
      e.status = 500;
    },
    (e: McpEvent) => {
      e.response.result.isError = true;
    },
  ]) {
    const e = describe(update);
    change(e);
    assert.equal(
      statuses(ordered(describe(), skill(), describe(get), e, execute()), policy)
        .required_method_discovery,
      'fail',
    );
  }
  const missing = ordered(describe(), skill(), describe(get), describe(update), execute());
  delete (missing[3] as McpEvent).completedOrdinal;
  assert.equal(statuses(missing, policy).required_method_discovery, 'unknown');
  assert.throws(() =>
    gradeMechanisms(basic(), { ...readOnly, requiredDescriptionsBeforeExecution: ['bad'] }),
  );
  // Legacy policies retain the exact same criteria; the extra contract is opt-in.
  assert.deepEqual(
    gradeMechanisms(basic()).map((c) => c.id),
    [
      'root_discovery',
      'method_discovery',
      'skill_resource',
      'send_ledger',
      'actor_mutation_surface',
    ],
  );
});
