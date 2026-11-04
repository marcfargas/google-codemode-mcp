import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; body?: any }[] = [];
  const events: GmailManifest[] = [];
  let full: any;
  let downloaded: string;
  let subject: string;
  let labelName: string;
  let attachmentFilename: string;
  let fixtureRaw: string;
  let historyPages = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/gmail/v1/users/me/', '') + url.search;
    const method = init?.method ?? 'GET';
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-test-token');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    let value: any;
    if (path === 'profile') value = { emailAddress: 'dummy@example.test', historyId: '123' };
    else if (path === 'drafts?maxResults=100') value = { drafts: [{ id: 'pre-existing-draft' }] };
    else if (path === 'labels' && method === 'POST') {
      labelName = body.name;
      value = { id: 'fixture-label' };
    } else if (path.startsWith('messages?') && method === 'POST') {
      fixtureRaw = Buffer.from(body.raw, 'base64url').toString('utf8');
      subject = fixtureRaw.match(/^Subject: (.+)\r?$/m)![1].trim();
      attachmentFilename = fixtureRaw.match(/filename="([^"]+)"/)![1];
      downloaded = fixtureRaw
        .split('Content-Transfer-Encoding: base64\r\n\r\n')[2]
        .split('\r\n')[0];
      full = {
        id: 'source',
        threadId: 'thread',
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Message-ID', value: '<observed-google-id@example.test>' },
            { name: 'Subject', value: subject },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('seed body').toString('base64url') },
            },
            {
              mimeType: 'text/plain',
              filename: attachmentFilename,
              body: { attachmentId: 'attachment' },
            },
          ],
        },
      };
      value = { id: 'source', threadId: 'thread' };
    } else if (path === 'messages/source?format=full') value = full;
    else if (path === 'messages/unrelated?format=full')
      value = { id: 'unrelated', threadId: 'other' };
    else if (path === 'messages/source/attachments/attachment')
      value = { data: Buffer.from(downloaded!, 'base64').toString('base64url') };
    else if (path === 'labels' && method === 'GET')
      value = { labels: [{ id: 'fixture-label', name: labelName!, type: 'user' }] };
    else if (path === 'threads/thread?format=full')
      value = {
        messages: [
          full,
          {
            id: 'reply',
            threadId: 'thread',
            payload: {
              headers: [
                { name: 'In-Reply-To', value: '<observed-google-id@example.test>' },
                { name: 'Subject', value: `Re: ${subject!}` },
              ],
            },
          },
        ],
      };
    else if (path.startsWith('history?')) {
      historyPages++;
      value =
        historyPages === 1
          ? {
              history: [
                {
                  labelsAdded: [
                    { message: { id: 'source', threadId: 'thread' }, labelIds: ['fixture-label'] },
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
            };
    } else if (path === 'messages/source/trash' || path === 'messages/reply/trash')
      value = { id: path.split('/')[1] };
    else if (path === 'labels/fixture-label' && method === 'DELETE')
      return new Response(null, { status: 204 });
    else throw new Error(`Unexpected mocked path ${method} ${path}`);
    return Response.json(value);
  }) as typeof fetch;
  try {
    const result = await prepareGmailFixture({
      accessToken: 'private-test-token',
      expectedUser: 'dummy@example.test',
      onEvent: (manifest) => {
        events.push(manifest);
      },
    });
    assert.equal(result.expected.messageId, '<observed-google-id@example.test>');
    assert.ok(result.prompt.includes(subject!));
    assert.ok(!result.prompt.includes(result.expected.confirmationCode));
    assert.ok(!result.prompt.includes(attachmentFilename!));
    assert.ok(!result.prompt.includes(result.expected.sourceId));
    assert.ok(!result.prompt.includes('users.messages'));
    assert.ok(fixtureRaw!.includes('Content-Disposition: attachment;'));
    assert.ok(events.some((event) => event.writes.some((write) => write.state === 'attempting')));
    assert.ok(!JSON.stringify(events).includes('private-test-token'));
    const observation = await result.observe();
    assert.equal(historyPages, 2);
    assert.equal(observation.complete, true);
    assert.ok(observation.history.some((change) => change.id === 'unrelated'));
    assert.deepEqual(result.manifest.messageIds, ['source', 'reply']);
    assert.equal(statuses(result.expected, observation, {}).no_extra_effects, 'fail');
    const cleaned = await result.cleanup();
    assert.deepEqual(cleaned, { failures: [], unknownMutations: [] });
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.path.includes('messages?')).length,
      1,
    );
    assert.ok(!calls.some((call) => call.path.includes('unrelated/trash')));
    assert.ok(
      !calls.some((call) => call.path.includes('pre-existing-draft') && call.method !== 'GET'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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
