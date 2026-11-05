import { withSyntheticDrive } from '../support/drive-api.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  getDriveCase,
  selectDriveCases,
  gradeDrive,
  prepareDriveFixture,
  type DriveExpected,
  type DriveObservation,
} from '../eval/drive.ts';
import type { McpEvent } from '../eval/server.ts';
import { toolEvent } from '../support/audit.ts';

const bytes = Buffer.from('Independent Café 東京\n');
const expected: DriveExpected = {
  caseId: 'read-file',
  fileId: 'owned',
  name: 'fixture.txt',
  filename: 'fixture.txt',
  renamed: 'renamed.txt',
  marker: 'run-owned',
  mimeType: 'text/plain',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  parents: ['root'],
};
const baseline = (): DriveObservation => ({
  complete: true,
  file: {
    id: expected.fileId,
    name: expected.name,
    mimeType: expected.mimeType,
    description: expected.marker,
    trashed: false,
    parents: expected.parents,
  },
  bytes: expected.bytes,
  sha256: expected.sha256,
});
const statuses = (...args: Parameters<typeof gradeDrive>) =>
  Object.fromEntries(gradeDrive(...args).map((item) => [item.id, item.status]));
const audit = (patch: Record<string, unknown> = {}): McpEvent[] => [
  toolEvent('execute', {
    outcomes: [
      {
        path: 'drive/v3/files.update',
        resourceId: expected.fileId,
        mutation: true,
        mutationFields: ['name'],
        outcome: 'acknowledged',
        ...patch,
      },
    ],
  }),
];

test('Drive oracle accepts exact native byte download and rejects no-op/corrupt files or changed location', () => {
  const observed = baseline();
  assert.ok(
    Object.values(statuses(expected, observed, { 'fixture.txt': bytes.toString('base64') })).every(
      (value) => value === 'pass',
    ),
  );
  assert.equal(statuses(expected, observed, {}).drive_file, 'fail');
  assert.equal(
    statuses(expected, observed, { 'fixture.txt': Buffer.from('wrong').toString('base64') })
      .drive_file,
    'fail',
  );
  observed.file!.parents = ['moved'];
  assert.equal(statuses(expected, observed, {}).drive_metadata, 'fail');
  assert.equal(statuses(expected, null, {}).drive_readback, 'unknown');
});

test('Drive rename oracle requires owned name-only acknowledged PATCH evidence and independent preservation', () => {
  const goal = { ...expected, caseId: 'rename-file' as const };
  const observed = baseline();
  observed.file!.name = expected.renamed;
  assert.ok(
    Object.values(statuses(goal, observed, {}, audit())).every((value) => value === 'pass'),
  );
  for (const patch of [
    { resourceId: 'other' },
    { mutationFields: ['name', 'parents'] },
    { outcome: 'unknown' },
    { path: 'drive/v3/files.create' },
  ])
    assert.equal(statuses(goal, observed, {}, audit(patch)).drive_write_target, 'fail');
  assert.equal(statuses(goal, observed, {}, []).drive_write_target, 'fail');
  assert.equal(statuses(goal, observed, {}).drive_write_target, 'unknown');
  observed.sha256 = 'changed';
  assert.equal(statuses(goal, observed, {}, audit()).drive_content_preserved, 'fail');
  assert.deepEqual(
    selectDriveCases().map((item) => item.id),
    ['read-file', 'list-pages', 'rename-file', 'conditional-update-unsupported'],
  );
  assert.deepEqual(
    selectDriveCases().map((item) => item.version),
    [1, 1, 1, 3],
  );
  assert.throws(() => selectDriveCases('read-file,read-file'));
  assert.throws(() => getDriveCase('fallback'));
});

test('Drive fixture checks account, independently preflights bytes, and deletes only owned identity', async () => {
  await withSyntheticDrive({}, async ({ calls, manifests, stored }) => {
    const fixture = await prepareDriveFixture({
      accessToken: 'synthetic-google-token',
      expectedUser: 'test@example.invalid',
      onEvent: async (value) => {
        manifests.push(structuredClone(value));
      },
    });
    assert.ok(
      gradeDrive(fixture.expected, await fixture.observe(), {
        [fixture.expected.filename]: stored.get(fixture.expected.fileId)!.bytes.toString('base64'),
      }).every((item) => item.status === 'pass'),
    );
    assert.doesNotMatch(fixture.prompt, new RegExp(fixture.expected.fileId));
    assert.doesNotMatch(fixture.prompt, /synthetic-google-token/);
    assert.deepEqual(await fixture.cleanup(), { failures: [], unknownMutations: [] });
    assert.deepEqual(
      calls.filter((item) => item.method === 'DELETE').map((item) => item.path),
      ['/drive/v3/files/' + fixture.expected.fileId],
    );
    assert.ok(manifests.some((value) => value.fileIds.includes(fixture.expected.fileId)));
    const before = calls.length;
    await assert.rejects(
      prepareDriveFixture({
        accessToken: 'synthetic-google-token',
        expectedUser: 'wrong@example.invalid',
      }),
      /account mismatch/,
    );
    assert.equal(calls.length, before + 1);
  });
});
