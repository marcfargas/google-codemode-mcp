import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  gradeDrive,
  prepareDriveFixture,
  getDriveCase,
  type DriveExpected,
  type DriveObservation,
} from '../eval/drive.ts';
import type { McpEvent } from '../eval/server.ts';

const content = Buffer.from('Owned fixture content\n');
const targets: DriveExpected[] = [1, 2, 3].map((index) => ({
  caseId: 'read-file',
  fileId: `owned-${index}`,
  name: `run-owned-${index}.txt`,
  renamed: 'unused.txt',
  filename: `run-owned-${index}.txt`,
  marker: 'run-owned',
  parents: ['root'],
  mimeType: 'text/plain',
  bytes: content.length,
  sha256: createHash('sha256').update(content).digest('hex'),
}));
const expected: DriveExpected = { ...targets[0], caseId: 'list-pages', pagination: targets };
const observeFile = (target: DriveExpected): DriveObservation => ({
  complete: true,
  file: {
    id: target.fileId,
    name: target.name,
    description: target.marker,
    mimeType: target.mimeType,
    parents: target.parents,
    trashed: false,
  },
  bytes: target.bytes,
  sha256: target.sha256,
});
const observation = (): DriveObservation => ({
  ...observeFile(targets[0]),
  pagination: targets.map(observeFile),
});
const files = (name: string, value: unknown) => ({
  [name]: Buffer.from(JSON.stringify(value)).toString('base64'),
});
const answer = () =>
  files('answer.json', {
    count: 3,
    files: targets.map((target) => ({ id: target.fileId, name: target.name })),
  });
const page = (id: string | null, requested?: string, next?: string): any => ({
  path: 'drive/v3/files.list',
  mutation: false,
  outcome: 'acknowledged',
  pagination: {
    query: "name contains 'run-owned' and trashed = false",
    pageSize: 1,
    fields: 'nextPageToken,incompleteSearch,files(id,name)',
    orderBy: 'name',
    returnedIds: id ? [id] : [],
    incompleteSearch: false,
    ...(requested !== undefined ? { requestedPageToken: requested } : {}),
    ...(next !== undefined ? { nextPageToken: next } : {}),
  },
});
const pages = () => [
  page('owned-1', undefined, 't+/=1'),
  page('owned-2', 't+/=1', 'last'),
  page('owned-3', 'last'),
];
const audit = (outcomes: any[] = pages()): McpEvent[] => [
  {
    method: 'tools/call',
    params: { name: 'execute' },
    status: 200,
    response: {
      result: {
        structuredContent: {
          status: 'completed',
          outcomesComplete: true,
          hasUnknownOutcome: outcomes.some(
            (entry) => entry.mutation && entry.outcome === 'unknown',
          ),
          outcomes,
        },
      },
    },
  },
];
const statuses = (...args: Parameters<typeof gradeDrive>) =>
  Object.fromEntries(gradeDrive(...args).map((criterion) => [criterion.id, criterion.status]));
const checked = (outcomes: any[] = pages()) =>
  statuses(expected, observation(), answer(), audit(outcomes));

test('Drive page oracle accepts native continuation, empty intermediate and empty terminal pages', () => {
  for (const outcomes of [
    pages(),
    [
      page('owned-1', undefined, 'empty'),
      page(null, 'empty', 't+/=1'),
      page('owned-2', 't+/=1', 'last'),
      page('owned-3', 'last'),
    ],
    [
      ...pages().slice(0, 2),
      page('owned-3', 'last', 'empty-terminal'),
      page(null, 'empty-terminal'),
    ],
  ]) {
    assert.ok(Object.values(checked(outcomes)).every((status) => status === 'pass'));
  }
  const reversed = pages()
    .map((outcome, index) => ({
      ...audit([outcome])[0],
      startedOrdinal: index * 2 + 1,
      completedOrdinal: index * 2 + 2,
    }))
    .reverse();
  assert.equal(
    statuses(expected, observation(), answer(), reversed).drive_pagination_chain,
    'pass',
  );
  for (const fields of [
    ' files( name, id ), incompleteSearch, nextPageToken ',
    '*',
    'nextPageToken,incompleteSearch,files/*',
    'incompleteSearch,files/id,nextPageToken,files/name',
  ]) {
    const outcomes = pages();
    for (const outcome of outcomes) outcome.pagination.fields = fields;
    assert.equal(checked(outcomes).drive_pagination_chain, 'pass', fields);
  }
  const omitted = [
    page('owned-1', undefined, 'empty'),
    page(null, 'empty', 't+/=1'),
    page('owned-2', 't+/=1', 'last'),
    page('owned-3', 'last', 'terminal'),
    page(null, 'terminal'),
  ];
  delete omitted[1].pagination.returnedIds;
  delete omitted[4].pagination.returnedIds;
  assert.ok(Object.values(checked(omitted)).every((status) => status === 'pass'));
  const missingItem = pages();
  delete missingItem[1].pagination.returnedIds;
  assert.equal(checked(missingItem).drive_page_ids, 'fail');
});

test('Drive page oracle rejects fabricated answers, wrong IDs, duplicate files and extra artifacts', () => {
  assert.equal(
    statuses(expected, observation(), answer(), audit([])).drive_pagination_chain,
    'fail',
  );
  assert.equal(statuses(expected, observation(), answer(), audit([])).drive_page_ids, 'fail');
  for (const value of [
    { count: 2, files: [] },
    { count: 3, files: targets.map(() => ({ id: 'owned-1', name: targets[0].name })) },
    { count: 3, files: targets.map((target) => ({ id: target.fileId, name: 'wrong' })) },
    {
      count: 3,
      files: targets.map((target) => ({ id: target.fileId, name: target.name, invented: true })),
    },
  ]) {
    assert.equal(
      statuses(expected, observation(), files('answer.json', value), audit()).drive_page_answer,
      'fail',
    );
  }
  assert.equal(
    statuses(expected, observation(), { ...answer(), extra: '' }, audit()).drive_files_only,
    'fail',
  );
  const wrong = pages();
  wrong[2].pagination.returnedIds = ['unowned'];
  assert.equal(checked(wrong).drive_page_ids, 'fail');
  const duplicate = pages();
  duplicate[2].pagination.returnedIds = ['owned-1'];
  assert.equal(checked(duplicate).drive_page_ids, 'fail');
  const reordered = files('answer.json', {
    files: targets
      .slice()
      .reverse()
      .map((target) => ({ name: target.name, id: target.fileId })),
    count: 3,
  });
  assert.equal(statuses(expected, observation(), reordered, audit()).drive_page_answer, 'pass');
});

test('Drive page oracle distinguishes absent causal evidence and explicit incomplete search from known chain violations', () => {
  for (const missing of [undefined, null] as const) {
    const result = statuses(expected, observation(), answer(), missing as undefined);
    assert.equal(result.drive_pagination_chain, 'unknown');
    assert.equal(result.drive_no_mutations, 'unknown');
  }
  for (const field of ['query', 'fields', 'pageSize', 'incompleteSearch']) {
    const outcomes = pages();
    delete outcomes[0].pagination[field];
    assert.equal(checked(outcomes).drive_pagination_chain, 'unknown', field);
  }
  const unannotated = pages();
  delete unannotated[0].pagination;
  assert.equal(checked(unannotated).drive_pagination_chain, 'unknown');
  const incomplete = pages();
  incomplete[1].pagination.incompleteSearch = true;
  assert.equal(checked(incomplete).drive_pagination_chain, 'unknown');
  for (const mutate of [
    (items: any[]) => {
      items[0].pagination.requestedPageToken = 'invented';
    },
    (items: any[]) => {
      items[1].pagination.requestedPageToken = 'wrong';
    },
    (items: any[]) => {
      items[2].pagination.requestedPageToken = 't+/=1';
    },
    (items: any[]) => {
      items[2].pagination.nextPageToken = 'not-terminal';
    },
    (items: any[]) => {
      items[1].pagination.fields = 'files(id,name),nextPageToken';
    },
    (items: any[]) => {
      items[1].pagination.fields = 'files(id,name,incompleteSearch,nextPageToken)';
    },
    (items: any[]) => {
      items[0].pagination.returnedIds.push('owned-2');
    },
    (items: any[]) => {
      items[1].outcome = 'rejected';
    },
  ]) {
    const outcomes = pages();
    mutate(outcomes);
    assert.equal(checked(outcomes).drive_pagination_chain, 'fail');
  }
  for (const key of [
    'query',
    'pageSize',
    'fields',
    'orderBy',
    'corpora',
    'driveId',
    'spaces',
    'includeItemsFromAllDrives',
    'supportsAllDrives',
  ]) {
    const outcomes = pages();
    outcomes[1].pagination[key] = key === 'pageSize' ? 2 : key === 'fields' ? '*' : 'changed';
    assert.equal(checked(outcomes).drive_pagination_chain, 'fail', key);
  }
  const tooMany = Array.from({ length: 101 }, (_, index) =>
    page(null, index ? `p${index}` : undefined, index < 100 ? `p${index + 1}` : undefined),
  );
  assert.equal(checked(tooMany).drive_pagination_chain, 'fail');
});

test('new Drive criteria require complete native ledgers and independent preservation', () => {
  for (const mutate of [
    (event: any) => {
      delete event.response.result.structuredContent.outcomes;
    },
    (event: any) => {
      event.response.result.structuredContent.outcomesComplete = false;
    },
    (event: any) => {
      event.response.result.structuredContent.hasUnknownOutcome = true;
    },
    (event: any) => {
      delete event.status;
    },
    (event: any) => {
      event.response.result.isError = true;
    },
    (event: any) => {
      delete event.response.result.structuredContent.status;
    },
  ]) {
    const events = audit();
    mutate(events[0]);
    assert.equal(
      statuses(expected, observation(), answer(), events).drive_pagination_chain,
      'unknown',
    );
  }
  const forged = audit([]);
  forged[0].response.result.structuredContent.result = { outcomes: pages() };
  assert.equal(statuses(expected, observation(), answer(), forged).drive_page_ids, 'fail');
  assert.equal(statuses(expected, null, answer(), audit()).drive_pagination_preserved, 'unknown');
  const changed = observation();
  changed.pagination![2].sha256 = 'changed';
  assert.equal(statuses(expected, changed, answer(), audit()).drive_pagination_preserved, 'fail');
  const mutated = [
    ...pages(),
    { path: 'drive/v3/files.update', mutation: true, outcome: 'not_dispatched' },
  ];
  assert.equal(checked(mutated).drive_no_mutations, 'fail');
});

test('conditional limit oracle requires exact unsupported artifact, actual owned read and no mutation attempts', () => {
  const goal: DriveExpected = {
    ...targets[0],
    caseId: 'conditional-update-unsupported',
    version: '7',
  };
  const observed = observeFile(goal);
  observed.file!.version = '7';
  const artifact = files('status.json', {
    fileId: goal.fileId,
    renamed: false,
    reason: 'conditional-update-unsupported',
  });
  const read = {
    path: 'drive/v3/files.get',
    resourceId: goal.fileId,
    mutation: false,
    outcome: 'acknowledged',
  };
  assert.ok(
    Object.values(statuses(goal, observed, artifact, audit([read]))).every(
      (status) => status === 'pass',
    ),
  );
  assert.deepEqual(getDriveCase(goal.caseId).policy, {
    expectedSends: 0,
    allowedMutations: [],
    requiredDescriptionsBeforeExecution: ['drive/v3/files.update'],
  });
  for (const reason of ['done', 'conditional-update-completed'])
    assert.equal(
      statuses(
        goal,
        observed,
        files('status.json', { fileId: goal.fileId, renamed: false, reason }),
        audit([read]),
      ).drive_conditional_answer,
      'fail',
    );
  assert.equal(
    statuses(
      goal,
      observed,
      files('status.json', {
        fileId: 'other',
        renamed: false,
        reason: 'conditional-update-unsupported',
      }),
      audit([read]),
    ).drive_conditional_answer,
    'fail',
  );
  assert.equal(statuses(goal, observed, artifact, audit([])).drive_conditional_read, 'fail');
  assert.equal(statuses(goal, observed, artifact).drive_conditional_read, 'unknown');
  assert.equal(
    statuses(goal, observed, artifact, audit([{ ...read, resourceId: 'other' }]))
      .drive_conditional_read,
    'fail',
  );
  for (const outcome of ['not_dispatched', 'rejected', 'acknowledged', 'unknown'])
    assert.equal(
      statuses(
        goal,
        observed,
        artifact,
        audit([read, { path: 'drive/v3/files.update', mutation: true, outcome }]),
      ).drive_no_mutations,
      'fail',
    );
  const changed = structuredClone(observed);
  changed.file!.version = '8';
  assert.equal(statuses(goal, changed, artifact, audit([read])).drive_version_preserved, 'fail');
  const renamed = structuredClone(observed);
  renamed.file!.name = goal.renamed;
  assert.equal(statuses(goal, renamed, artifact, audit([read])).drive_metadata, 'fail');
});

test('Drive page fixture independently reads all three shared-prefix files and cleans only owned IDs', async () => {
  await withSyntheticDrive({}, async ({ manifests, calls }) => {
    const fixture = await prepareDriveFixture({
      accessToken: 'synthetic-google-token',
      expectedUser: 'test@example.invalid',
      caseId: 'list-pages',
      onEvent: async (manifest) => {
        manifests.push(structuredClone(manifest));
      },
    });
    assert.equal(fixture.expected.pagination?.length, 3);
    assert.equal(new Set(fixture.expected.pagination!.map((file) => file.fileId)).size, 3);
    assert.ok(
      fixture.expected.pagination!.every(
        (file) =>
          file.marker === fixture.expected.marker && file.name.startsWith(fixture.expected.marker),
      ),
    );
    for (const file of fixture.expected.pagination!)
      assert.ok(!fixture.prompt.includes(file.fileId));
    assert.match(fixture.prompt, /pageSize 1/);
    assert.match(fixture.prompt, /nextPageToken, incompleteSearch/);
    const observed = await fixture.observe();
    assert.equal(observed.complete, true);
    assert.equal(observed.pagination?.length, 3);
    assert.deepEqual(
      observed.pagination?.map((file) => file.file?.id),
      fixture.expected.pagination?.map((file) => file.fileId),
    );
    assert.deepEqual(await fixture.cleanup(), { failures: [], unknownMutations: [] });
    assert.deepEqual(
      calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
      [
        '/drive/v3/files/synthetic-owned-1',
        '/drive/v3/files/synthetic-owned-2',
        '/drive/v3/files/synthetic-owned-3',
      ],
    );
    const manifest = manifests.at(-1);
    assert.equal(manifest.fixtures.length, 3);
    assert.equal(manifest.readiness.length, 1);
    assert.equal(manifest.readiness[0].response.incompleteSearch, false);
    assert.deepEqual(
      manifest.fileIds,
      fixture.expected.pagination!.map((file) => file.fileId),
    );
    assert.ok(!JSON.stringify(manifest).includes('synthetic-google-token'));
  });
});

test('conditional fixture retains output-only version and makes the special inspection order explicit', async () => {
  await withSyntheticDrive({}, async ({ calls }) => {
    const fixture = await prepareDriveFixture({
      accessToken: 'synthetic-google-token',
      expectedUser: 'test@example.invalid',
      caseId: 'conditional-update-unsupported',
    });
    assert.equal(fixture.expected.version, '7');
    assert.match(fixture.prompt, /Inspect the update method before executing any code/);
    assert.match(fixture.prompt, /only if the available API can make Google atomically enforce/);
    assert.ok(calls.some((call) => call.fields?.endsWith(',version')));
    assert.deepEqual(await fixture.cleanup(), { failures: [], unknownMutations: [] });
  });
});

test('Drive page fixture refuses wrong accounts, retains ambiguous partial creates and reports cleanup failures', async () => {
  await withSyntheticDrive({}, async ({ calls }) => {
    await assert.rejects(
      prepareDriveFixture({
        accessToken: 'synthetic-google-token',
        expectedUser: 'other@example.invalid',
        caseId: 'list-pages',
      }),
      /account mismatch/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
  });
  for (const failure of ['http', 'missing-id'] as const) {
    await withSyntheticDrive({ failSecondCreate: failure }, async ({ manifests, calls }) => {
      await assert.rejects(
        prepareDriveFixture({
          accessToken: 'synthetic-google-token',
          expectedUser: 'test@example.invalid',
          caseId: 'list-pages',
          onEvent: async (manifest) => {
            manifests.push(structuredClone(manifest));
          },
        }),
        failure === 'http' ? /HTTP 503/ : /no identity/,
      );
      assert.deepEqual(
        calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
        ['/drive/v3/files/synthetic-owned-1'],
      );
      const cleanup = manifests.at(-1).cleanup;
      assert.deepEqual(cleanup.failures, []);
      assert.equal(cleanup.unknownMutations.length, 1);
      assert.equal(cleanup.unknownMutations[0].unreconciled, true);
    });
  }
  await withSyntheticDrive({ failDelete: 'synthetic-owned-2' }, async () => {
    const fixture = await prepareDriveFixture({
      accessToken: 'synthetic-google-token',
      expectedUser: 'test@example.invalid',
      caseId: 'list-pages',
    });
    const cleanup = await fixture.cleanup();
    assert.deepEqual(cleanup.failures, ['synthetic-owned-2']);
    assert.equal(cleanup.unknownMutations.length, 1);
    assert.match(cleanup.unknownMutations[0].operation, /^DELETE /);
  });
});

test('Drive page readiness deadline fails before actor preparation and reconciles every known fixture', async () => {
  await withSyntheticDrive({ expireReadiness: true }, async ({ manifests, calls }) => {
    await assert.rejects(
      prepareDriveFixture({
        accessToken: 'synthetic-google-token',
        expectedUser: 'test@example.invalid',
        caseId: 'list-pages',
        onEvent: async (manifest) => {
          manifests.push(structuredClone(manifest));
        },
      }),
      /readiness unavailable; no actor started/,
    );
    assert.equal(calls.filter((call) => call.path === '/drive/v3/files').length, 1);
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 3);
    assert.deepEqual(manifests.at(-1).cleanup, { failures: [], unknownMutations: [] });
  });
});

async function withSyntheticDrive(
  options: {
    failSecondCreate?: 'http' | 'missing-id';
    failDelete?: string;
    expireReadiness?: boolean;
  },
  exercise: (fixture: {
    calls: { path: string; method: string; fields: string | null }[];
    manifests: any[];
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  if (options.expireReadiness) Date.now = () => now;
  const stored = new Map<string, { metadata: Record<string, unknown>; bytes: Buffer }>();
  const calls: { path: string; method: string; fields: string | null }[] = [];
  const manifests: any[] = [];
  let creates = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ path: url.pathname, method, fields: url.searchParams.get('fields') });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-google-token');
    if (url.pathname === '/drive/v3/about')
      return Response.json({ user: { emailAddress: 'test@example.invalid' } });
    if (url.pathname === '/upload/drive/v3/files') {
      creates++;
      if (creates === 2 && options.failSecondCreate === 'http')
        return Response.json({ error: {} }, { status: 503 });
      if (creates === 2 && options.failSecondCreate === 'missing-id') return Response.json({});
      const boundary = new Headers(init?.headers).get('Content-Type')!.split('boundary=')[1];
      const sections = Buffer.from(init!.body as Uint8Array)
        .toString('utf8')
        .split(`--${boundary}`);
      const metadata = JSON.parse(sections[1].split('\r\n\r\n')[1].trim());
      const bytes = Buffer.from(sections[2].split('\r\n\r\n')[1].slice(0, -2));
      const id = `synthetic-owned-${creates}`;
      stored.set(id, { metadata, bytes });
      return Response.json({ id });
    }
    if (url.pathname === '/drive/v3/files') {
      if (options.expireReadiness) {
        now += 30_001;
        return Response.json({ files: [], incompleteSearch: false });
      }
      return Response.json({
        files: [...stored].map(([id, file]) => ({ id, name: file.metadata.name })),
        incompleteSearch: false,
      });
    }
    const id = url.pathname.split('/').at(-1)!;
    const file = stored.get(id);
    assert.ok(file, 'fixture accesses only a known owned identity');
    if (method === 'DELETE')
      return options.failDelete === id
        ? Response.json({ error: {} }, { status: 503 })
        : new Response(null, { status: 204 });
    if (url.searchParams.get('alt') === 'media') return new Response(file.bytes);
    return Response.json({ ...file.metadata, id, trashed: false, parents: ['root'], version: '7' });
  }) as typeof fetch;
  try {
    await exercise({ calls, manifests });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}
