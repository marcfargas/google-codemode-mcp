import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { McpEvent } from '../eval/server.ts';
import { toolEvent } from '../support/audit.ts';
import { GMAIL_CASES, type GmailCaseId } from '../eval/cases.ts';
import {
  gradeGmail,
  prepareGmailFixture,
  type GmailExpected,
  type GmailManifest,
  type GmailObservation,
  type GmailObservedMessage,
} from '../eval/gmail.ts';

function fixture() {
  const bytes = Buffer.from('Independent bytes\nCafé — 東京 ✓\n');
  const expected: GmailExpected = {
    account: 'dummy@example.test',
    subject: 'Review request fixture',
    sourceId: 'source',
    threadId: 'thread',
    messageId: '<source@example.test>',
    labelId: 'Label_fixture',
    labelName: 'Follow-up fixture',
    initialSourceLabels: ['INBOX', 'UNREAD'],
    initialLabels: [{ id: 'Label_fixture', name: 'Follow-up fixture', type: 'user' }],
    initialDraftIds: [],
    historyId: '100',
    confirmationCode: 'random-42',
    attachment: {
      filename: 'evidence.txt',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      attachmentId: 'attachment',
    },
  };
  const source: GmailObservedMessage = {
    id: 'source',
    threadId: 'thread',
    labels: ['INBOX', 'Label_fixture', 'UNREAD'],
    headers: { 'message-id': ['<source@example.test>'], subject: [expected.subject] },
    plainText: ['Please confirm this code: random-42\n'],
    mimeComplete: true,
  };
  const reply: GmailObservedMessage = {
    id: 'reply',
    threadId: 'thread',
    labels: ['INBOX', 'SENT', 'UNREAD'],
    headers: {
      'message-id': ['<reply@example.test>'],
      subject: [`Re: ${expected.subject}`],
      to: ['Dummy <dummy@example.test>'],
      from: ['dummy@example.test'],
      'in-reply-to': [expected.messageId],
      references: [expected.messageId],
    },
    plainText: ['Confirmed: random-42\r\n'],
    mimeComplete: true,
  };
  const observation: GmailObservation = {
    source,
    thread: [source, reply],
    labels: structuredClone(expected.initialLabels),
    newDraftIds: [],
    complete: true,
    errors: [],
    history: [
      { kind: 'labelsAdded', id: 'source', threadId: 'thread', labels: ['Label_fixture'] },
      {
        kind: 'messageAdded',
        id: 'reply',
        threadId: 'thread',
        labels: ['INBOX', 'SENT', 'UNREAD'],
      },
    ],
  };
  const files = { 'evidence.txt': bytes.toString('base64') };
  return { expected, observation, files, reply };
}
function statuses(...args: Parameters<typeof gradeGmail>) {
  return Object.fromEntries(
    gradeGmail(...args).map((criterion) => [criterion.id, criterion.status]),
  );
}

function readOnlyFixture(caseId: GmailCaseId) {
  const result = fixture();
  result.expected.caseId = caseId;
  result.observation.source!.labels = [...result.expected.initialSourceLabels];
  result.observation.thread = [result.observation.source!];
  result.observation.history = [];
  return result;
}
const answerFile = (answer: unknown) => ({
  'answer.json': Buffer.from(JSON.stringify(answer)).toString('base64'),
});
function audit(...outcomes: unknown[]): McpEvent[] {
  return [toolEvent('execute', { outcomesComplete: true, outcomes })];
}
function listPage(query: string, requestedPageToken?: string, nextPageToken?: string) {
  return {
    path: 'gmail/v1/users.messages.list',
    mutation: false,
    outcome: 'acknowledged',
    pagination: {
      query,
      maxResults: 1,
      ...(requestedPageToken ? { requestedPageToken } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    },
  };
}

test('read/search needs exact body knowledge, real source read and real subject search', () => {
  const { expected, observation } = readOnlyFixture('read-search');
  const files = answerFile({
    messageId: expected.sourceId,
    confirmationCode: expected.confirmationCode,
  });
  const events = audit(listPage(`subject:"${expected.subject}"`), {
    path: 'gmail/v1/users.messages.get',
    mutation: false,
    outcome: 'acknowledged',
    resourceId: expected.sourceId,
  });
  assert.ok(
    Object.values(statuses(expected, observation, files, events)).every(
      (value) => value === 'pass',
    ),
  );
  assert.equal(statuses(expected, observation, files).search_and_read, 'unknown');
  assert.equal(statuses(expected, observation, files, audit()).search_and_read, 'fail');
  assert.equal(
    statuses(
      expected,
      observation,
      answerFile({ messageId: 'wrong', confirmationCode: expected.confirmationCode }),
      events,
    ).read_answer,
    'fail',
  );
  assert.equal(
    statuses(
      expected,
      observation,
      answerFile({ messageId: expected.sourceId, confirmationCode: 'guess' }),
      events,
    ).read_answer,
    'fail',
  );
  assert.equal(
    statuses(
      expected,
      observation,
      answerFile({
        messageId: expected.sourceId,
        confirmationCode: expected.confirmationCode,
        extra: true,
      }),
      events,
    ).read_answer,
    'fail',
  );
});

test('independent reply keeps the full thread oracle and preserves source labels', () => {
  const { expected, observation } = fixture();
  expected.caseId = 'reply';
  observation.source!.labels = [...expected.initialSourceLabels];
  observation.history = observation.history.filter((change) => change.id !== expected.sourceId);
  assert.ok(Object.values(statuses(expected, observation, {})).every((value) => value === 'pass'));
  observation.source!.labels.push(expected.labelId);
  assert.equal(statuses(expected, observation, {}).no_extra_effects, 'fail');
  assert.equal(statuses(expected, observation, answerFile({})).only_requested_file, 'fail');
  observation.thread[1].plainText = ['A plausible reply without the code'];
  assert.equal(statuses(expected, observation, {}).reply_body, 'fail');
});

test('independent attachment and labels reject cross-task effects', () => {
  const attachment = readOnlyFixture('attachment');
  assert.ok(
    Object.values(statuses(attachment.expected, attachment.observation, attachment.files)).every(
      (value) => value === 'pass',
    ),
  );
  attachment.observation.source!.labels.push(attachment.expected.labelId);
  assert.equal(
    statuses(attachment.expected, attachment.observation, attachment.files).no_extra_effects,
    'fail',
  );
  assert.equal(statuses(attachment.expected, attachment.observation, {}).attachment_file, 'fail');
  const labels = readOnlyFixture('labels');
  labels.observation.source!.labels = ['INBOX', labels.expected.labelId, 'UNREAD'];
  labels.observation.history = [
    {
      kind: 'labelsAdded',
      id: labels.expected.sourceId,
      threadId: labels.expected.threadId,
      labels: [labels.expected.labelId],
    },
  ];
  assert.ok(
    Object.values(statuses(labels.expected, labels.observation, {})).every(
      (value) => value === 'pass',
    ),
  );
  labels.observation.source!.labels = [labels.expected.labelId];
  assert.equal(statuses(labels.expected, labels.observation, {}).no_extra_effects, 'fail');
  labels.observation.history.push({
    kind: 'labelsAdded',
    id: 'unrelated',
    threadId: 'other',
    labels: [labels.expected.labelId],
  });
  assert.equal(statuses(labels.expected, labels.observation, {}).no_extra_effects, 'fail');
});

test('pagination requires exact complete body evidence and trusted continuation tokens', () => {
  const { expected, observation } = readOnlyFixture('pagination');
  expected.pagination = ['second', 'third'].map((id) => ({
    sourceId: id,
    threadId: `${id}-thread`,
    confirmationCode: `${id}-secret`,
    initialLabels: ['INBOX'],
  }));
  observation.additionalSources = expected.pagination.map((entry) => ({
    ...structuredClone(observation.source!),
    id: entry.sourceId,
    threadId: entry.threadId,
    labels: [...entry.initialLabels],
  }));
  const messages = [
    { messageId: expected.sourceId, confirmationCode: expected.confirmationCode },
    ...expected.pagination.map((entry) => ({
      messageId: entry.sourceId,
      confirmationCode: entry.confirmationCode,
    })),
  ];
  const files = answerFile({ count: 3, messages: [...messages].reverse() });
  const pages = [
    listPage(expected.subject, undefined, 'two'),
    listPage(expected.subject, 'two', 'three'),
    listPage(expected.subject, 'three'),
  ];
  assert.ok(
    Object.values(statuses(expected, observation, files, audit(...pages))).every(
      (value) => value === 'pass',
    ),
  );
  assert.equal(statuses(expected, observation, files).actual_pagination, 'unknown');
  // Live Gmail can return a continuation after the last item, then an empty page.
  const emptyFinal = structuredClone(pages);
  emptyFinal[2].pagination.nextPageToken = 'empty-final';
  emptyFinal.push(listPage(expected.subject, 'empty-final'));
  assert.equal(
    statuses(expected, observation, files, audit(...emptyFinal)).actual_pagination,
    'pass',
  );
  const emptyMiddle = [
    listPage(expected.subject, undefined, 'empty-middle'),
    listPage(expected.subject, 'empty-middle', 'two'),
    ...structuredClone(pages).slice(1),
  ];
  assert.equal(
    statuses(expected, observation, files, audit(...emptyMiddle)).actual_pagination,
    'pass',
  );
  assert.equal(
    statuses(expected, observation, files, audit(...pages.map(() => listPage(expected.subject))))
      .actual_pagination,
    'fail',
  );
  const mismatched = structuredClone(pages);
  mismatched[1].pagination.requestedPageToken = 'invented';
  assert.equal(
    statuses(expected, observation, files, audit(...mismatched)).actual_pagination,
    'fail',
  );
  const truncated = structuredClone(pages);
  truncated[2].pagination.nextPageToken = 'more';
  assert.equal(
    statuses(expected, observation, files, audit(...truncated)).actual_pagination,
    'fail',
  );
  const larger = structuredClone(pages);
  larger[0].pagination.maxResults = 3;
  assert.equal(statuses(expected, observation, files, audit(...larger)).actual_pagination, 'fail');
  assert.equal(
    statuses(
      expected,
      observation,
      answerFile({ count: 3, messages: [messages[0], messages[0], messages[2]] }),
      audit(...pages),
    ).complete_page_answer,
    'fail',
  );
  assert.equal(
    statuses(
      expected,
      observation,
      answerFile({ count: 2, messages: messages.slice(0, 2) }),
      audit(...pages),
    ).complete_page_answer,
    'fail',
  );
  observation.additionalSources[1].labels.push('TRASH');
  assert.equal(statuses(expected, observation, files, audit(...pages)).no_extra_effects, 'fail');
});

test('safe failure needs a trusted 404 for the exact missing ID and unchanged mailbox', () => {
  const { expected, observation } = readOnlyFixture('failure');
  expected.missingId = 'abcdef0123456789';
  const files = answerFile({ messageId: expected.missingId, status: 'not_found' });
  const rejected = {
    path: 'gmail/v1/users.messages.get',
    mutation: false,
    resourceId: expected.missingId,
    outcome: 'rejected',
    httpStatus: 404,
  };
  assert.ok(
    Object.values(statuses(expected, observation, files, audit(rejected))).every(
      (value) => value === 'pass',
    ),
  );
  assert.equal(statuses(expected, observation, files).observed_not_found, 'unknown');
  assert.equal(
    statuses(expected, observation, files, audit({ ...rejected, resourceId: 'other' }))
      .observed_not_found,
    'fail',
  );
  assert.equal(
    statuses(expected, observation, files, audit({ ...rejected, httpStatus: 403 }))
      .observed_not_found,
    'fail',
  );
  assert.equal(
    statuses(expected, observation, files, audit({ ...rejected, outcome: 'unknown' }))
      .observed_not_found,
    'fail',
  );
  const incomplete = audit(rejected);
  incomplete[0].response.result.structuredContent.outcomesComplete = false;
  assert.equal(statuses(expected, observation, files, incomplete).observed_not_found, 'unknown');
  assert.equal(
    statuses(
      expected,
      observation,
      answerFile({ messageId: expected.missingId, status: 'done' }),
      audit(rejected),
    ).safe_failure_answer,
    'fail',
  );
  observation.newDraftIds.push('unexpected');
  assert.equal(statuses(expected, observation, files, audit(rejected)).no_extra_effects, 'fail');
});

test('independent cases never pass with missing or partial independent readback', () => {
  for (const { id } of GMAIL_CASES) {
    const { expected, observation } = readOnlyFixture(id);
    assert.equal(statuses(expected, null, {}).no_extra_effects, 'unknown');
    observation.complete = false;
    assert.equal(statuses(expected, observation, {}).readback, 'fail');
    assert.equal(statuses(expected, observation, {}).no_extra_effects, 'fail');
  }
});

test('objective Gmail state and exact Unicode attachment bytes pass', () => {
  const { expected, observation, files } = fixture();
  assert.ok(
    Object.values(statuses(expected, observation, files)).every((status) => status === 'pass'),
  );
});

test('no-op and narrative success cannot replace independent state', () => {
  const { expected, observation } = fixture();
  observation.thread = [observation.source!];
  observation.source!.labels = expected.initialSourceLabels;
  const result = statuses(expected, observation, {});
  assert.equal(result.attachment_file, 'fail');
  assert.equal(result.original_label, 'fail');
  assert.equal(result.one_reply, 'fail');
  assert.equal(result.reply_body, 'fail');
});

test('wrong thread, recipients, headers and quoted fact fail independently', () => {
  const { expected, observation, files, reply } = fixture();
  reply.threadId = 'other-thread';
  reply.headers.to = ['someone-else@example.test'];
  reply.headers['in-reply-to'] = ['<other@example.test>'];
  reply.plainText = ['Thanks\n> Confirmed: random-42\n'];
  const result = statuses(expected, observation, files);
  assert.equal(result.reply_thread, 'fail');
  assert.equal(result.reply_headers, 'fail');
  assert.equal(result.reply_body, 'fail');
});

test('distinct sends fail while duplicate self-send representations form one logical reply', () => {
  const { expected, observation, files, reply } = fixture();
  const duplicate = structuredClone(reply);
  duplicate.id = 'received-copy';
  duplicate.labels = ['INBOX', 'UNREAD'];
  observation.thread.push(duplicate);
  assert.equal(statuses(expected, observation, files).one_reply, 'pass');
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'pass');
  duplicate.labels.push('SENT');
  assert.equal(statuses(expected, observation, files).one_reply, 'fail');
  duplicate.labels = ['INBOX', 'UNREAD'];
  duplicate.headers['message-id'] = ['<second-send@example.test>'];
  assert.equal(statuses(expected, observation, files).one_reply, 'fail');
});

test('byte corruption, missing newline and unexpected filenames fail file criteria', () => {
  const { expected, observation, files } = fixture();
  files['evidence.txt'] = Buffer.from(
    Buffer.from(files['evidence.txt'], 'base64').subarray(0, -1),
  ).toString('base64');
  assert.equal(statuses(expected, observation, files).attachment_file, 'fail');
  assert.equal(
    statuses(expected, observation, { ...files, 'extra.txt': '' }).only_requested_file,
    'fail',
  );
});

test('unrelated history effects, catalog changes, remaining drafts and trash fail', () => {
  const { expected, observation, files, reply } = fixture();
  observation.history.push({
    kind: 'labelsRemoved',
    id: 'unrelated',
    threadId: 'elsewhere',
    labels: ['INBOX'],
  });
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'fail');
  observation.history.pop();
  observation.labels.push({ id: 'extra', name: 'extra' });
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'fail');
  observation.labels.pop();
  observation.newDraftIds.push('leftover');
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'fail');
  observation.newDraftIds.pop();
  reply.labels.push('TRASH');
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'fail');
});

test('draft then send transient message IDs and thread label operations are accepted', () => {
  const { expected, observation, files, reply } = fixture();
  observation.history.push(
    { kind: 'messageAdded', id: 'draft-message', threadId: 'thread', labels: ['DRAFT'] },
    { kind: 'messageDeleted', id: 'draft-message', threadId: 'thread', labels: [] },
  );
  reply.labels.push(expected.labelId);
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'pass');
  observation.history.pop();
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'fail');
});

test('missing readback is unknown, partial history cannot pass side-effect criterion', () => {
  const { expected, observation, files } = fixture();
  const missing = statuses(expected, null, files);
  assert.equal(missing.attachment_file, 'pass');
  assert.equal(missing.readback, 'unknown');
  assert.equal(missing.reply_body, 'unknown');
  observation.complete = false;
  observation.errors.push('history');
  assert.equal(statuses(expected, observation, files).readback, 'fail');
  assert.equal(statuses(expected, observation, files).no_extra_effects, 'fail');
});

test('independent REST lifecycle guards account, seeds MIME attachment, captures history and cleans only known IDs', async () => {
  await withFixtureApi(
    async ({ calls, raw, historyPages }) => {
      const events: GmailManifest[] = [];
      const result = await prepareGmailFixture({
        accessToken: 'synthetic-token',
        expectedUser: 'dummy@example.test',
        onEvent: (manifest) => {
          events.push(manifest);
        },
      });
      assert.equal(result.expected.messageId, '<observed-google-id@example.test>');
      assert.ok(result.prompt.includes(result.expected.subject));
      assert.ok(!result.prompt.includes(result.expected.confirmationCode));
      assert.ok(!result.prompt.includes(result.expected.attachment.filename));
      assert.ok(!result.prompt.includes(result.expected.sourceId));
      assert.ok(!result.prompt.includes('users.messages'));
      assert.ok(raw().includes('Content-Disposition: attachment;'));
      assert.ok(events.some((event) => event.writes.some((write) => write.state === 'attempting')));
      assert.ok(!JSON.stringify(events).includes('synthetic-token'));
      const observation = await result.observe();
      assert.equal(historyPages(), 2);
      assert.equal(observation.complete, true);
      assert.ok(observation.history.some((change) => change.id === 'unrelated'));
      assert.deepEqual(result.manifest.messageIds, [result.expected.sourceId, 'reply']);
      assert.equal(statuses(result.expected, observation, {}).no_extra_effects, 'fail');
      const cleaned = await result.cleanup();
      assert.deepEqual(cleaned, { failures: [], unknownMutations: [] });
      assert.equal(
        calls.filter((call) => call.method === 'POST' && call.path === 'messages').length,
        1,
      );
      assert.ok(!calls.some((call) => call.path.includes('unrelated/trash')));
      assert.ok(
        !calls.some((call) => call.path.includes('pre-existing-draft') && call.method !== 'GET'),
      );
    },
    { lifecycle: true },
  );
});

test('account mismatch fails before any write', async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    if (init?.method) writes++;
    return Response.json({ emailAddress: 'wrong@example.test' });
  }) as typeof fetch;
  try {
    await assert.rejects(
      prepareGmailFixture({ accessToken: 'secret', expectedUser: 'dummy@example.test' }),
      /account guard/,
    );
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unknown setup mutation emits retained marker and never retries it', async () => {
  const originalFetch = globalThis.fetch;
  const events: GmailManifest[] = [];
  let labelWrites = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (init?.method === 'POST') {
      labelWrites++;
      throw new Error('lost response');
    }
    return Response.json(
      String(input).endsWith('/profile') ? { emailAddress: 'dummy@example.test' } : { drafts: [] },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      prepareGmailFixture({
        accessToken: 'secret',
        expectedUser: 'dummy@example.test',
        onEvent: (manifest) => {
          events.push(manifest);
        },
      }),
      /unknown outcome/,
    );
    assert.equal(labelWrites, 1);
    assert.equal(events.at(-1)?.writes[0].state, 'unknown');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function withFixtureApi(
  run: (state: {
    calls: { path: string; method: string }[];
    seedCount: () => number;
    raw: () => string;
    historyPages: () => number;
  }) => Promise<void>,
  options: { missingStatus?: number; lifecycle?: boolean } = {},
) {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string }[] = [];
  const messages = new Map<string, any>();
  let labelName = '';
  let attachmentData = '';
  let raw = '';
  let historyPages = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/gmail/v1/users/me/', '');
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-token');
    if (path === 'profile')
      return Response.json({ emailAddress: 'dummy@example.test', historyId: '100' });
    if (path === 'drafts')
      return Response.json({ drafts: options.lifecycle ? [{ id: 'pre-existing-draft' }] : [] });
    if (path === 'labels' && method === 'POST') {
      labelName = JSON.parse(String(init?.body)).name;
      return Response.json({ id: 'Label_owned' });
    }
    if (path === 'labels' && method === 'GET')
      return Response.json({ labels: [{ id: 'Label_owned', name: labelName, type: 'user' }] });
    if (path === 'messages' && method === 'POST') {
      const mime = Buffer.from(JSON.parse(String(init?.body)).raw, 'base64url').toString('utf8');
      raw = mime;
      const id = `seed-${messages.size + 1}`;
      const segments = mime.split('Content-Transfer-Encoding: base64\r\n\r\n');
      const text = segments[1].split('\r\n')[0];
      const filename = mime.match(/filename="([^"]+)"/)?.[1];
      if (filename) attachmentData = segments[2].split('\r\n')[0];
      messages.set(id, {
        id,
        threadId: `thread-${id}`,
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          mimeType: filename ? 'multipart/mixed' : 'text/plain',
          headers: ['Subject', 'Message-ID'].map((name) => ({
            name,
            value:
              options.lifecycle && name === 'Message-ID'
                ? '<observed-google-id@example.test>'
                : mime.match(new RegExp(`^${name}: (.+)\\r?$`, 'm'))![1].trim(),
          })),
          ...(filename
            ? {
                parts: [
                  {
                    mimeType: 'text/plain',
                    body: { data: Buffer.from(text, 'base64').toString('base64url') },
                  },
                  { mimeType: 'text/plain', filename, body: { attachmentId: 'attachment' } },
                ],
              }
            : { body: { data: Buffer.from(text, 'base64').toString('base64url') } }),
        },
      });
      return Response.json({ id, threadId: `thread-${id}` });
    }
    if (path === 'messages/seed-1/attachments/attachment')
      return Response.json({ data: Buffer.from(attachmentData, 'base64').toString('base64url') });
    if (/^messages\/[^/]+$/.test(path) && method === 'GET') {
      const message =
        options.lifecycle && path === 'messages/unrelated'
          ? { id: 'unrelated', threadId: 'other' }
          : messages.get(path.split('/')[1]);
      return message
        ? Response.json(message)
        : Response.json(
            { error: { code: options.missingStatus ?? 404 } },
            { status: options.missingStatus ?? 404 },
          );
    }
    if (path === 'threads/thread-seed-1')
      return Response.json({
        messages: [
          messages.get('seed-1'),
          ...(options.lifecycle
            ? [
                {
                  id: 'reply',
                  threadId: 'thread-seed-1',
                  payload: {
                    headers: [
                      { name: 'In-Reply-To', value: '<observed-google-id@example.test>' },
                      {
                        name: 'Subject',
                        value: `Re: ${messages.get('seed-1').payload.headers[0].value}`,
                      },
                    ],
                  },
                },
              ]
            : []),
        ],
      });
    if (path === 'history') {
      historyPages++;
      return Response.json(
        !options.lifecycle
          ? { history: [] }
          : historyPages === 1
            ? {
                history: [
                  {
                    labelsAdded: [
                      {
                        message: { id: 'seed-1', threadId: 'thread-seed-1' },
                        labelIds: ['Label_owned'],
                      },
                    ],
                  },
                ],
                nextPageToken: 'next',
              }
            : {
                history: [
                  {
                    messagesAdded: [
                      { message: { id: 'unrelated', threadId: 'other', labelIds: ['INBOX'] } },
                    ],
                  },
                ],
              },
      );
    }
    if (/^messages\/(seed-[123]|reply)\/trash$/.test(path) && method === 'POST')
      return Response.json({ id: path.split('/')[1] });
    if (path === 'labels/Label_owned' && method === 'DELETE')
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected synthetic fixture API request: ${method} ${path}`);
  }) as typeof fetch;
  try {
    await run({
      calls,
      seedCount: () => messages.size,
      raw: () => raw,
      historyPages: () => historyPages,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('pagination fixture owns three independently read sources and cleans each known message', async () => {
  await withFixtureApi(async ({ calls, seedCount }) => {
    const fixture = await prepareGmailFixture({
      accessToken: 'synthetic-token',
      expectedUser: 'dummy@example.test',
      caseId: 'pagination',
    });
    assert.equal(fixture.expected.caseId, 'pagination');
    assert.equal(seedCount(), 3);
    assert.equal(fixture.expected.pagination?.length, 2);
    const sources = [
      { sourceId: fixture.expected.sourceId, confirmationCode: fixture.expected.confirmationCode },
      ...fixture.expected.pagination!,
    ];
    assert.equal(new Set(sources.map((entry) => entry.confirmationCode)).size, 3);
    for (const source of sources) {
      assert.ok(!fixture.prompt.includes(source.sourceId));
      assert.ok(!fixture.prompt.includes(source.confirmationCode));
    }
    assert.ok(fixture.prompt.includes('one search result per page'));
    assert.ok(!fixture.prompt.includes('users.messages'));
    const observation = await fixture.observe();
    assert.equal(observation.complete, true);
    assert.deepEqual(
      observation.additionalSources?.map((entry) => entry.id),
      ['seed-2', 'seed-3'],
    );
    const files = answerFile({
      count: 3,
      messages: sources.map((entry) => ({
        messageId: entry.sourceId,
        confirmationCode: entry.confirmationCode,
      })),
    });
    assert.equal(statuses(fixture.expected, observation, files).no_extra_effects, 'pass');
    assert.deepEqual(await fixture.cleanup(), { failures: [], unknownMutations: [] });
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith('/trash')).map((call) => call.path),
      ['messages/seed-1/trash', 'messages/seed-2/trash', 'messages/seed-3/trash'],
    );
  });
});

test('failure fixture preflights a well-formed missing ID and aborts on a different response', async () => {
  await withFixtureApi(async ({ calls }) => {
    const fixture = await prepareGmailFixture({
      accessToken: 'synthetic-token',
      expectedUser: 'dummy@example.test',
      caseId: 'failure',
    });
    assert.match(fixture.expected.missingId!, /^[a-f0-9]{16}$/);
    assert.ok(fixture.prompt.includes(fixture.expected.missingId!));
    assert.ok(
      calls.some(
        (call) => call.path === `messages/${fixture.expected.missingId}` && call.method === 'GET',
      ),
    );
    const observation = await fixture.observe();
    assert.equal(observation.complete, true);
    assert.equal(statuses(fixture.expected, observation, {}).no_extra_effects, 'pass');
    await fixture.cleanup();
    assert.ok(!calls.some((call) => call.path === `messages/${fixture.expected.missingId}/trash`));
  });
  await withFixtureApi(
    async ({ calls }) => {
      await assert.rejects(
        prepareGmailFixture({
          accessToken: 'synthetic-token',
          expectedUser: 'dummy@example.test',
          caseId: 'failure',
        }),
        /did not return HTTP 404/,
      );
      assert.ok(calls.some((call) => call.path === 'messages/seed-1/trash'));
      assert.ok(
        calls.some((call) => call.path === 'labels/Label_owned' && call.method === 'DELETE'),
      );
    },
    { missingStatus: 400 },
  );
});
