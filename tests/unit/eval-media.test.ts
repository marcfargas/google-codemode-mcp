import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_RESOURCE,
  getMediaCase,
  gradeMedia,
  selectMediaCases,
  type MediaExpected,
  type MediaObservation,
} from '../eval/media.ts';
import { gradeMechanisms } from '../eval/mechanisms.ts';
import { summarizeSavedRun } from '../eval/report.ts';
import type { McpEvent } from '../eval/server.ts';

const expected: MediaExpected = {
  profile: 'media',
  caseId: 'gmail-to-drive',
  marker: 'random-owned-marker',
  name: 'renamed.bin',
  mimeType: 'application/octet-stream',
  sha256: 'a'.repeat(64),
  bytes: 256,
  subject: 'Transfer random-owned-marker',
  recipient: 'test@example.test',
  folderId: 'owned-folder',
  sourceMessageId: 'owned-message',
  sourceDraftId: 'source-draft',
  initialDraftIds: [],
};
const observation: MediaObservation = {
  complete: true,
  sourceUnchanged: true,
  targets: [
    {
      id: 'created-file',
      name: expected.name,
      mimeType: expected.mimeType,
      parents: ['owned-folder'],
      sha256: expected.sha256,
      bytes: expected.bytes,
    },
  ],
  drafts: [],
  unexpectedDraftIds: [],
};
const files = (value: unknown = { fileId: 'created-file' }) => ({
  'answer.json': Buffer.from(JSON.stringify(value)).toString('base64'),
});
const outcomes = [
  {
    path: 'gmail/v1/users.messages.get',
    resourceId: 'owned-message',
    mutation: false,
    outcome: 'acknowledged',
  },
  {
    path: 'drive/v3/files.create',
    resourceId: 'created-file',
    mutation: true,
    outcome: 'acknowledged',
  },
];
function audit(
  items: Record<string, any>[] = outcomes,
  options: { guide?: boolean; late?: boolean; complete?: boolean; result?: unknown } = {},
): McpEvent[] {
  const events: McpEvent[] = [];
  const add = (method: string, params: Record<string, unknown>, result: Record<string, unknown>) =>
    events.push({ method, params, status: 200, response: { result } });
  add('tools/call', { name: 'describe', arguments: {} }, { structuredContent: { services: [] } });
  const skill = 'skill://google-codemode-mcp/google-workspace/SKILL.md';
  add(
    'resources/read',
    { uri: skill },
    { contents: [{ uri: skill, text: '# Google Workspace Code Mode' }] },
  );
  const guide = () =>
    add(
      'resources/read',
      { uri: MEDIA_RESOURCE },
      { contents: [{ uri: MEDIA_RESOURCE, text: '# Media transfers\nActual deployment guide.' }] },
    );
  if (options.guide !== false && !options.late) guide();
  for (const path of new Set(items.map((item) => item.path)))
    add(
      'tools/call',
      { name: 'describe', arguments: { path } },
      { structuredContent: { path, signature: 'method(params): Promise<unknown>' } },
    );
  add(
    'tools/call',
    { name: 'execute', arguments: {} },
    {
      structuredContent: {
        status: 'completed',
        outcomesComplete: options.complete !== false,
        hasUnknownOutcome: items.some((item) => item.mutation && item.outcome === 'unknown'),
        outcomes: items,
        result: options.result,
      },
    },
  );
  if (options.late) guide();
  return events.map((event, index) => ({
    ...event,
    startedOrdinal: index * 2 + 1,
    completedOrdinal: index * 2 + 2,
  }));
}
const statuses = (
  e = expected,
  o: MediaObservation | null = observation,
  f: Record<string, string> = files(),
  a: McpEvent[] | undefined = audit(),
) => Object.fromEntries(gradeMedia(e, o, f, a).map((item) => [item.id, item.status]));

test('media cases are bounded independent selections with exact mutation and resource policies', () => {
  assert.deepEqual(
    selectMediaCases().map((item) => item.id),
    ['gmail-to-drive', 'drive-to-gmail'],
  );
  assert.throws(() => selectMediaCases('gmail-to-drive,gmail-to-drive'));
  assert.throws(() => getMediaCase('arbitrary'));
  assert.deepEqual(getMediaCase().policy.allowedMutations, ['drive/v3/files.create']);
  assert.deepEqual(getMediaCase('drive-to-gmail').policy.allowedMutations, [
    'gmail/v1/users.drafts.create',
  ]);
  assert.deepEqual(getMediaCase().policy.requiredResourcesBeforeExecution, [MEDIA_RESOURCE]);
});
test('known-valid Gmail to Drive transfer passes actual-state and trusted-ledger criteria', () => {
  assert.ok(Object.values(statuses()).every((status) => status === 'pass'));
  assert.equal(
    statuses(
      expected,
      observation,
      files(),
      audit([outcomes[0], { ...outcomes[1], resourceId: undefined }]),
    ).media_created_identity,
    'unknown',
  );
  assert.equal(
    statuses(
      expected,
      observation,
      files(),
      audit([outcomes[0], { ...outcomes[1], resourceId: 'foreign-created-file' }]),
    ).media_created_identity,
    'fail',
  );
  assert.ok(
    gradeMechanisms(audit(), getMediaCase().policy).every((item) => item.status === 'pass'),
  );
});
test('no-op and forged program outcomes cannot satisfy actual native read and write evidence', () => {
  const guessed = files();
  const noop = statuses(expected, observation, guessed, audit([], { result: { outcomes } }));
  assert.equal(noop.media_mutation_ledger, 'fail');
  assert.equal(noop.media_source_read, 'fail');
  const incomplete = statuses(expected, observation, files(), audit(outcomes, { complete: false }));
  assert.equal(incomplete.media_mutation_ledger, 'unknown');
  assert.equal(incomplete.media_source_read, 'unknown');
  const missing = Object.fromEntries(
    gradeMedia(expected, observation, files(), undefined).map((item) => [item.id, item.status]),
  );
  assert.equal(missing.media_mutation_ledger, 'unknown');
});
test('independent bytes, MIME, transformed name and exact folder are required', () => {
  for (const change of [
    { sha256: 'b'.repeat(64) },
    { bytes: 257 },
    { mimeType: 'text/plain' },
    { name: 'original.bin' },
    { parents: ['other-folder'] },
  ]) {
    const copy = structuredClone(observation);
    Object.assign(copy.targets[0], change);
    assert.equal(statuses(expected, copy).media_transfer, 'fail');
  }
  const extra = structuredClone(observation);
  extra.targets.push({ ...extra.targets[0], id: 'extra' });
  assert.equal(statuses(expected, extra).media_transfer, 'fail');
  const source = structuredClone(observation);
  source.sourceUnchanged = false;
  assert.equal(statuses(expected, source).media_source_preserved, 'fail');
  assert.equal(statuses(expected, observation, files({ fileId: 'guessed' })).media_answer, 'fail');
  assert.equal(
    statuses(expected, observation, { ...files(), 'other.txt': 'AA==' }).media_files_only,
    'fail',
  );
});
test('extra, unknown, rejected and wrong-target writes cannot pass the composition ledger', () => {
  for (const changed of [
    outcomes.concat(outcomes[1]),
    [outcomes[0], { ...outcomes[1], outcome: 'unknown' }],
    [outcomes[0], { ...outcomes[1], outcome: 'rejected' }],
    [outcomes[0], { ...outcomes[1], path: 'drive/v3/files.update' }],
  ])
    assert.equal(
      statuses(expected, observation, files(), audit(changed)).media_mutation_ledger,
      'fail',
    );
  assert.equal(
    statuses(
      expected,
      observation,
      files(),
      audit([{ ...outcomes[0], resourceId: 'unowned' }, outcomes[1]]),
    ).media_source_read,
    'fail',
  );
  const incomplete = structuredClone(observation);
  incomplete.complete = false;
  assert.equal(statuses(expected, incomplete).media_transfer, 'unknown');
});
test('advanced resource must actually be read before execute, without changing old policy criteria', () => {
  const criterion = (events: McpEvent[]) =>
    gradeMechanisms(events, getMediaCase().policy).find((item) => item.id === 'required_resource')!
      .status;
  assert.equal(criterion(audit()), 'pass');
  assert.equal(criterion(audit(outcomes, { guide: false })), 'fail');
  assert.equal(criterion(audit(outcomes, { late: true })), 'fail');
  const malformed = audit();
  delete malformed[0].completedOrdinal;
  assert.equal(criterion(malformed), 'unknown');
  const old = gradeMechanisms(audit(outcomes, { guide: false }), {
    expectedSends: 0,
    allowedMutations: ['drive/v3/files.create'],
  });
  assert.deepEqual(
    old.map((item) => item.id),
    [
      'root_discovery',
      'method_discovery',
      'skill_resource',
      'send_ledger',
      'actor_mutation_surface',
    ],
  );
  assert.ok(old.every((item) => item.status === 'pass'));
});
test('Drive to Gmail draft requires exact independent attachment and unsent single draft', () => {
  const e: MediaExpected = {
    ...expected,
    caseId: 'drive-to-gmail',
    sourceDriveId: 'owned-drive-source',
  };
  const o: MediaObservation = {
    complete: true,
    sourceUnchanged: true,
    targets: [],
    drafts: [
      {
        id: 'created-draft',
        messageId: 'created-message',
        subject: e.subject,
        to: e.recipient,
        attachments: [{ name: e.name, mimeType: e.mimeType, sha256: e.sha256, bytes: e.bytes }],
      },
    ],
    unexpectedDraftIds: [],
  };
  const writes = [
    {
      path: 'drive/v3/files.get',
      mutation: false,
      outcome: 'acknowledged',
      resourceId: e.sourceDriveId,
    },
    {
      path: 'gmail/v1/users.drafts.create',
      resourceId: 'created-draft',
      mutation: true,
      outcome: 'acknowledged',
    },
  ];
  const f = files({ draftId: 'created-draft' });
  assert.ok(Object.values(statuses(e, o, f, audit(writes))).every((status) => status === 'pass'));
  for (const change of [
    { name: 'wrong.bin' },
    { sha256: 'b'.repeat(64) },
    { bytes: 255 },
    { mimeType: 'text/plain' },
  ]) {
    const bad = structuredClone(o);
    Object.assign(bad.drafts[0].attachments[0], change);
    assert.equal(statuses(e, bad, f, audit(writes)).media_transfer, 'fail');
  }
  const extra = structuredClone(o);
  extra.unexpectedDraftIds.push('unexpected');
  assert.equal(statuses(e, extra, f, audit(writes)).media_transfer, 'fail');
  const sent = [writes[0], { ...writes[1], path: 'gmail/v1/users.messages.send' }];
  assert.equal(statuses(e, o, f, audit(sent)).media_mutation_ledger, 'fail');
  const exportExpected = { ...e, exportMimeType: 'text/plain' };
  const exportWrites = [{ ...writes[0], path: 'drive/v3/files.export' }, writes[1]];
  assert.equal(statuses(exportExpected, o, f, audit(exportWrites)).media_source_read, 'pass');
});
test('offline report recognizes the two-case four-cell media declaration without inference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codemode-media-report-'));
  try {
    const report = await summarizeSavedRun(dir, {
      profile: 'media',
      cases: 'all',
      selection: 'required',
    });
    assert.equal(report.counts.selected, 4);
    assert.equal(report.attempts.length, 4);
    assert.ok(
      report.attempts.every((row) => ['gmail-to-drive', 'drive-to-gmail'].includes(row.caseId!)),
    );
    assert.ok(!report.issues.includes('invalid_fallback_declaration'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fixture retains acknowledged create identity loss and cleans only recorded owned resources', async () => {
  const { prepareMediaFixture } = await import('../eval/media.ts');
  const previous = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  const events: any[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    calls.push({ url: url.pathname, method });
    if (method === 'GET' && url.pathname.endsWith('/drafts')) return Response.json({ drafts: [] });
    if (method === 'GET' && url.pathname.endsWith('/profile'))
      return Response.json({ emailAddress: 'test@example.test' });
    if (method === 'GET' && url.pathname.endsWith('/about'))
      return Response.json({ user: { emailAddress: 'test@example.test' } });
    if (method === 'POST' && url.pathname === '/drive/v3/files')
      return Response.json({ id: 'owned-folder' });
    if (method === 'POST' && url.pathname.endsWith('/drafts'))
      return new Response('{unreadable', { status: 200 });
    if (method === 'GET' && url.pathname === '/drive/v3/files')
      return Response.json({ files: [], incompleteSearch: false });
    if (method === 'GET' && url.pathname === '/drive/v3/files/owned-folder')
      return Response.json({ mimeType: 'application/vnd.google-apps.folder' });
    if (method === 'DELETE' && url.pathname === '/drive/v3/files/owned-folder')
      return new Response(null, { status: 204 });
    throw new Error('Unexpected inert fixture request');
  };
  try {
    await assert.rejects(
      prepareMediaFixture({
        accessToken: 'inert-token',
        expectedUser: 'test@example.test',
        caseId: 'gmail-to-drive',
        onEvent: async (event) => {
          events.push(structuredClone(event));
        },
      }),
      /Acknowledged fixture create identity unreadable/,
    );
    const last = events.at(-1);
    assert.equal(last.cleanup.unknownMutations.length, 1);
    assert.equal(last.cleanup.unknownMutations[0].outcome, 'acknowledged');
    assert.equal(last.cleanup.unknownMutations[0].unreconciled, true);
    assert.deepEqual(
      calls.filter((call) => call.method === 'DELETE').map((call) => call.url),
      [],
    );
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/drafts')).length,
      1,
      'no replay after acknowledged identity loss',
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test('trusted create IDs authorize cleanup; associated existing objects and unnamed attachments stay visible', async () => {
  const { prepareMediaFixture } = await import('../eval/media.ts');
  const previous = globalThis.fetch;
  const deleted: string[] = [];
  let sourceBytes = Buffer.alloc(0);
  let sourceMetadata: Record<string, unknown> = {};
  let associated = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/drafts'))
      return Response.json({ drafts: associated ? [{ id: 'victim-existing' }] : [] }); // eventual list lag
    if (method === 'GET' && url.pathname.endsWith('/profile'))
      return Response.json({ emailAddress: 'test@example.test' });
    if (method === 'GET' && url.pathname.endsWith('/about'))
      return Response.json({ user: { emailAddress: 'test@example.test' } });
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const body = Buffer.from(init!.body as Uint8Array);
      const boundary = new Headers(init?.headers).get('content-type')!.split('boundary=')[1];
      const separator = Buffer.from('\r\nContent-Type: application/octet-stream\r\n\r\n');
      const start = body.indexOf(separator) + separator.length;
      const end = body.lastIndexOf(Buffer.from('\r\n--' + boundary + '--'));
      sourceBytes = body.subarray(start, end);
      const metadataStart = body.indexOf(Buffer.from('\r\n\r\n')) + 4;
      const metadataEnd = body.indexOf(Buffer.from('\r\n--' + boundary), metadataStart);
      const metadata = JSON.parse(body.subarray(metadataStart, metadataEnd).toString('utf8'));
      sourceMetadata = {
        id: 'owned-source',
        name: metadata.name,
        mimeType: metadata.mimeType,
        description: metadata.description,
        trashed: false,
        parents: [],
      };
      return Response.json({ id: 'owned-source' });
    }
    if (method === 'GET' && url.pathname === '/drive/v3/files/owned-source')
      return url.searchParams.get('alt') === 'media'
        ? new Response(sourceBytes)
        : Response.json(sourceMetadata);
    if (method === 'GET' && url.pathname === '/drive/v3/files')
      return Response.json({
        files: [
          sourceMetadata,
          ...(associated
            ? [
                {
                  id: 'victim-existing-file',
                  name: sourceMetadata.description,
                  mimeType: 'application/octet-stream',
                  parents: [],
                },
              ]
            : []),
        ],
        incompleteSearch: false,
      });
    if (method === 'GET' && url.pathname === '/drive/v3/files/victim-existing-file')
      return new Response(sourceBytes);
    if (method === 'GET' && url.pathname === '/gmail/v1/users/me/drafts/victim-existing')
      return Response.json({
        id: 'victim-existing',
        message: {
          id: 'victim-message',
          payload: {
            headers: [
              {
                name: 'Subject',
                value: associated ? String(sourceMetadata.description) : 'Unrelated existing draft',
              },
            ],
            parts: [],
          },
        },
      });
    if (method === 'GET' && url.pathname === '/gmail/v1/users/me/drafts/actor-wrong-subject')
      return Response.json({
        id: 'actor-wrong-subject',
        message: {
          id: 'actor-message',
          payload: {
            headers: [
              { name: 'Subject', value: 'Incorrect subject' },
              { name: 'To', value: 'test@example.test' },
            ],
            parts: [
              {
                filename: 'wrong.bin',
                mimeType: 'application/octet-stream',
                body: { data: sourceBytes.toString('base64url'), size: sourceBytes.length },
              },
              ...(associated
                ? [
                    {
                      mimeType: 'application/octet-stream',
                      headers: [{ name: 'Content-Disposition', value: 'attachment' }],
                      body: { data: 'AP8', size: 2 },
                    },
                  ]
                : []),
            ],
          },
        },
      });
    if (method === 'DELETE') {
      deleted.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected inert request: ' + url.pathname);
  };
  try {
    const fixture = await prepareMediaFixture({
      accessToken: 'inert-token',
      expectedUser: 'test@example.test',
      caseId: 'drive-to-gmail',
    });
    const ledger = [
      {
        path: 'drive/v3/files.get',
        mutation: false,
        outcome: 'acknowledged',
        resourceId: 'owned-source',
      },
      {
        path: 'gmail/v1/users.drafts.create',
        mutation: true,
        outcome: 'acknowledged',
        resourceId: 'actor-wrong-subject',
      },
    ];
    const trace = audit(ledger);
    const observed = await fixture.observe(files({ draftId: 'victim-existing' }), trace);
    assert.equal(observed.complete, true);
    assert.equal(observed.drafts[0].id, 'actor-wrong-subject');
    assert.deepEqual(observed.unexpectedDraftIds, ['victim-existing']);
    assert.equal(
      gradeMedia(fixture.expected, observed, files({ draftId: 'actor-wrong-subject' }), trace).find(
        (item) => item.id === 'media_transfer',
      )!.status,
      'fail',
    );
    associated = true;
    const extra = await fixture.observe(files({ draftId: 'actor-wrong-subject' }), trace);
    assert.equal(extra.complete, true);
    const actor = extra.drafts.find((draft) => draft.id === 'actor-wrong-subject')!;
    assert.equal(actor.attachments.length, 2);
    assert.equal(actor.attachments[1].name, '');
    assert.equal(actor.attachments[1].bytes, 2);
    const cleanup = await fixture.cleanup();
    assert.deepEqual(cleanup, {
      failures: ['unowned-target-associated', 'unowned-draft-associated'],
      unknownMutations: [],
    });
    assert.deepEqual(deleted, [
      '/gmail/v1/users/me/drafts/actor-wrong-subject',
      '/drive/v3/files/owned-source',
    ]);
  } finally {
    globalThis.fetch = previous;
  }
});

test('forward cleanup never recursively deletes folders with unknown or incompletely listed children', async () => {
  const { prepareMediaFixture } = await import('../eval/media.ts');
  const previous = globalThis.fetch;
  try {
    for (const children of [
      { files: [] },
      { files: [{ id: 'existing-child' }] },
      { files: [], incompleteSearch: true },
      { files: [], nextPageToken: 'more' },
    ]) {
      const deleted: string[] = [];
      const manifests: any[] = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
          deleted.push(url.pathname);
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith('/profile'))
          return Response.json({ emailAddress: 'test@example.test' });
        if (url.pathname.endsWith('/about'))
          return Response.json({ user: { emailAddress: 'test@example.test' } });
        if (url.pathname.endsWith('/drafts'))
          return Response.json(method === 'POST' ? { id: 'owned-draft' } : { drafts: [] });
        if (url.pathname === '/drive/v3/files') {
          if (method === 'POST') return Response.json({ id: 'owned-folder' });
          return Response.json(
            url.searchParams.get('q')?.startsWith("'owned-folder' in parents")
              ? children
              : { files: [] },
          );
        }
        if (url.pathname === '/drive/v3/files/owned-folder')
          return Response.json({ mimeType: 'application/vnd.google-apps.folder' });
        throw new Error('Unexpected inert request');
      };
      await assert.rejects(
        prepareMediaFixture({
          accessToken: 'inert',
          expectedUser: 'test@example.test',
          caseId: 'gmail-to-drive',
          onEvent: async (event) => {
            manifests.push(structuredClone(event));
          },
        }),
        /Fixture draft message identity absent/,
      );
      assert.ok(deleted.includes('/gmail/v1/users/me/drafts/owned-draft'));
      assert.equal(
        deleted.includes('/drive/v3/files/owned-folder'),
        children.files.length === 0 &&
          !('incompleteSearch' in children) &&
          !('nextPageToken' in children),
      );
      assert.equal(manifests.at(-1).cleanup.failures.length, deleted.length === 2 ? 0 : 1);
      assert.ok(!deleted.some((path) => path.includes('existing-child')));
    }
  } finally {
    globalThis.fetch = previous;
  }
});
