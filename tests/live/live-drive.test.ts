import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OAuth2Client } from 'google-auth-library';
import { gradeDrive, prepareDriveFixture } from '../eval/drive.ts';
import type { McpEvent } from '../eval/server.ts';
import type { CallOutcome } from '../../src/dispatcher.ts';
import { openBuiltWorker, type ExecutionReceipt } from '../support/worker-client.ts';

type Receipt<T> = Omit<ExecutionReceipt<T>, 'outcomes'> & { outcomes: CallOutcome[] };
type Native<T> = { data: T; status: number; headers: Record<string, string> };
type Media = { encoding: 'base64'; data: string; size: number; mimeType: string; sha256: string };
type File = {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  description: string;
  trashed: boolean;
  parents?: string[];
};

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Live Drive verification requires ${name}`);
  return value;
}

async function credentials() {
  const expectedUser = required('GOOGLE_TEST_USER');
  const configuration = required('GOOGLE_OAUTH_CLIENT_JSON');
  const refreshToken = required('GOOGLE_TEST_REFRESH_TOKEN');
  try {
    assert.match(expectedUser, /^[^\s@<>\r\n]+@[^\s@<>\r\n]+$/);
    const { installed } = JSON.parse(configuration);
    assert.equal(typeof installed.client_id, 'string');
    assert.equal(typeof installed.client_secret, 'string');
    const oauth = new OAuth2Client({
      clientId: installed.client_id,
      clientSecret: installed.client_secret,
    });
    oauth.setCredentials({ refresh_token: refreshToken });
    const { credentials: refreshed } = await oauth.refreshAccessToken();
    const accessToken = refreshed.access_token;
    assert.ok(typeof accessToken === 'string' && accessToken.length);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::add-mask::${accessToken}`);
      console.log(`::add-mask::${installed.client_secret}`);
    }
    const scopes = refreshed.scope
      ? refreshed.scope.split(' ')
      : (await oauth.getTokenInfo(accessToken)).scopes;
    assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.modify'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
    const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(profile.ok, true);
    const account = (await profile.json()) as { emailAddress?: string };
    assert.equal(account.emailAddress?.toLowerCase(), expectedUser.toLowerCase());
    return { expectedUser, accessToken };
  } catch {
    throw new Error(
      'Live Drive OAuth scope/account guard failed; credentials and remote diagnostics suppressed',
    );
  }
}

test(
  'live Drive files, refusal and pagination through the built sessionless Worker',
  { timeout: 420_000 },
  async (t) => {
    // This file is selected only by the explicit credentialed workflow.
    const run = randomUUID();
    const evidence: {
      caseId: string;
      manifest?: unknown;
      expected?: unknown;
      outcomes: CallOutcome[];
      criteria?: ReturnType<typeof gradeDrive>;
      cleanup?: unknown;
      failed?: boolean;
      qualification?: Record<string, unknown>;
    }[] = [];
    const failures: string[] = [];
    await mkdir('dist', { recursive: true });
    const retain = () =>
      writeFile(
        'dist/live-drive-receipt.json',
        JSON.stringify(
          {
            run,
            source: process.env.GITHUB_SHA ?? null,
            cases: evidence,
            failures,
            note: 'Only recorded fixture IDs are cleaned. Unknown writes may require reconciliation using retained markers.',
          },
          null,
          2,
        ),
      );
    await retain();
    let worker: Awaited<ReturnType<typeof openBuiltWorker>> | undefined;
    try {
      const { expectedUser, accessToken } = await credentials();
      worker = await openBuiltWorker();
      for (const caseId of ['read-file', 'rename-file'] as const) {
        const entry: (typeof evidence)[number] = { caseId, outcomes: [] };
        const audit: McpEvent[] = [];
        evidence.push(entry);
        let fixture: Awaited<ReturnType<typeof prepareDriveFixture>> | undefined;
        let passed = false;
        await t.test(caseId, async () => {
          try {
            fixture = await prepareDriveFixture({
              accessToken,
              expectedUser,
              caseId,
              onEvent: async (manifest) => {
                entry.manifest = structuredClone(manifest);
                await retain();
              },
            });
            entry.expected = fixture.expected;
            await retain();
            const expected = fixture.expected;
            const used = [
              'drive/v3/files.list',
              'drive/v3/files.get',
              ...(caseId === 'rename-file' ? ['drive/v3/files.update'] : []),
            ];
            for (const path of used) {
              const described = await worker!.tool<Record<string, unknown>>('describe', { path });
              assert.equal(described.path, path);
              assert.equal(typeof described.revision, 'string');
              assert.equal(
                described.source,
                'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
              );
              assert.equal(described.supported, true);
            }
            const execute = async <T>(method: string, params: Record<string, unknown>) => {
              const receipt = await worker!.tool<Receipt<Native<T>>>('execute', {
                accessToken,
                code: `return await google.drive({version:'v3'}).files.${method}(inputs);`,
                inputs: params,
              });
              entry.outcomes.push(...receipt.outcomes);
              // Trusted outcomes are taken directly from this actual product response.
              // Retain only the receipt fields needed by the independent write oracle.
              audit.push({
                method: 'tools/call',
                params: { name: 'execute' },
                status: 200,
                response: { result: { structuredContent: { outcomes: receipt.outcomes } } },
              });
              await retain();
              assert.equal(receipt.status, 'completed');
              assert.equal(receipt.hasUnknownOutcome, false);
              assert.equal(receipt.outcomes.length, 1);
              assert.equal(receipt.outcomes[0].outcome, 'acknowledged');
              assert.equal(receipt.outcomes[0].path, `drive/v3/files.${method}`);
              assert.equal(receipt.result.status, 200);
              return receipt.result;
            };
            const found = await execute<{ files?: { id: string; name: string }[] }>('list', {
              q: `name = '${expected.name}' and trashed = false`,
              pageSize: 2,
              fields: 'files(id,name)',
            });
            assert.deepEqual(found.data.files, [{ id: expected.fileId, name: expected.name }]);
            const metadata = await execute<File>('get', {
              fileId: expected.fileId,
              fields: 'id,name,mimeType,size,description,trashed,parents',
            });
            assert.equal(metadata.data.id, expected.fileId);
            assert.equal(metadata.data.name, expected.name);
            assert.equal(metadata.data.description, expected.marker);
            assert.equal(metadata.data.mimeType, expected.mimeType);
            assert.equal(Number(metadata.data.size), expected.bytes);
            assert.equal(metadata.data.trashed, false);
            assert.deepEqual(
              [...(metadata.data.parents ?? [])].sort(),
              [...expected.parents].sort(),
            );
            const files: Record<string, string> = {};
            if (caseId === 'read-file') {
              const downloaded = await execute<Media>('get', {
                fileId: expected.fileId,
                alt: 'media',
              });
              const media = downloaded.data;
              assert.equal(media.encoding, 'base64');
              assert.match(
                media.data,
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
              );
              const bytes = Buffer.from(media.data, 'base64');
              assert.equal(bytes.toString('base64'), media.data);
              assert.equal(bytes.length, expected.bytes);
              assert.equal(media.size, expected.bytes);
              assert.equal(media.mimeType.split(';')[0].trim(), expected.mimeType);
              assert.equal(media.sha256, expected.sha256);
              assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
              files[expected.filename] = media.data;
            } else {
              const renamed = await execute<File>('update', {
                fileId: expected.fileId,
                requestBody: { name: expected.renamed },
                fields: 'id,name,mimeType,size,description,trashed,parents',
              });
              assert.equal(renamed.data.id, expected.fileId);
              assert.equal(renamed.data.name, expected.renamed);
              assert.equal(renamed.data.description, expected.marker);
              assert.equal(renamed.data.mimeType, expected.mimeType);
              assert.equal(Number(renamed.data.size), expected.bytes);
              assert.equal(renamed.data.trashed, false);
              assert.deepEqual(
                [...(renamed.data.parents ?? [])].sort(),
                [...expected.parents].sort(),
              );
              const mutation = entry.outcomes.at(-1)!;
              assert.equal(mutation.resourceId, expected.fileId);
              assert.deepEqual(mutation.mutationFields, ['name']);
            }
            const observed = await fixture.observe();
            entry.criteria = gradeDrive(expected, observed, files, audit);
            await retain();
            assert.ok(entry.criteria.every((criterion) => criterion.status === 'pass'));
            passed = true;
          } catch {
            entry.failed = true;
            throw new Error('Live Drive case failed; credentials and file diagnostics suppressed');
          } finally {
            if (fixture) {
              try {
                const cleanup = await fixture.cleanup();
                entry.cleanup = cleanup;
                if (cleanup.failures.length || cleanup.unknownMutations.length)
                  failures.push(`${caseId}:cleanup`);
              } catch {
                failures.push(`${caseId}:cleanup-interrupted`);
              }
            }
            await retain();
          }
        });
        if (!passed || failures.length)
          throw new Error('Live Drive dependent cases stopped after a failed prerequisite');
      }

      await t.test('conditional-options-refused', async () => {
        const entry: (typeof evidence)[number] = {
          caseId: 'conditional-options-refused',
          outcomes: [],
        };
        evidence.push(entry);
        let fixture: Awaited<ReturnType<typeof prepareDriveFixture>> | undefined;
        try {
          fixture = await prepareDriveFixture({
            accessToken,
            expectedUser,
            onEvent: async (manifest) => {
              entry.manifest = structuredClone(manifest);
              await retain();
            },
          });
          entry.expected = fixture.expected;
          const described = await worker!.tool<Record<string, unknown>>('describe', {
            path: 'drive/v3/files.update',
          });
          const parameters = Object.keys(described.parameters as Record<string, unknown>);
          const refusals: { shape: string; receipt: Receipt<unknown> }[] = [];
          entry.qualification = {
            discovery: { revision: described.revision, source: described.source, parameters },
            conditionalMutation: 'unsupported; not qualified',
            refusals,
          };
          await retain();
          assert.equal(typeof described.revision, 'string');
          assert.equal(described.supported, true);
          assert.equal(
            parameters.some((key) =>
              /^(ifMatch|ifNoneMatch|etag|precondition|version)$/i.test(key),
            ),
            false,
          );
          const inputs = {
            fileId: fixture.expected.fileId,
            requestBody: { name: fixture.expected.renamed },
          };
          for (const [shape, suffix, extra] of [
            ['second-argument', ", {headers:{'If-Match':'\\\"deliberately-mismatched\\\"'}}", {}],
            ['headers-parameter', '', { headers: { 'If-Match': '"deliberately-mismatched"' } }],
            ['invented-ifMatch', '', { ifMatch: '"deliberately-mismatched"' }],
          ] as const) {
            const receipt = await worker!.tool<Receipt<unknown>>('execute', {
              accessToken,
              code: `return await google.drive({version:'v3'}).files.update(inputs${suffix});`,
              inputs: { ...inputs, ...extra },
            });
            refusals.push({ shape, receipt });
            entry.outcomes.push(...receipt.outcomes);
            await retain();
            assert.equal(receipt.status, 'error');
            assert.equal(receipt.hasUnknownOutcome, false);
            assert.equal(receipt.outcomesComplete, true);
            if (shape === 'second-argument') assert.deepEqual(receipt.outcomes, []);
            else {
              assert.equal(receipt.outcomes.length, 1);
              assert.equal(receipt.outcomes[0].path, 'drive/v3/files.update');
              assert.equal(receipt.outcomes[0].outcome, 'not_dispatched');
              assert.equal(receipt.outcomes[0].httpStatus, undefined);
            }
          }
          const observation = await fixture.observe();
          entry.qualification.observation = observation;
          const criteria = gradeDrive(
            { ...fixture.expected, caseId: 'rename-file', renamed: fixture.expected.name },
            observation,
            {},
          ).filter((criterion) => criterion.id !== 'drive_write_target');
          entry.criteria = criteria;
          await retain();
          assert.ok(criteria.every((criterion) => criterion.status === 'pass'));
        } catch {
          entry.failed = true;
          throw new Error('Drive refusal qualification failed; inspect retained receipt');
        } finally {
          if (fixture) {
            try {
              const cleanup = await fixture.cleanup();
              entry.cleanup = cleanup;
              if (cleanup.failures.length || cleanup.unknownMutations.length)
                failures.push('conditional-options-refused:cleanup');
            } catch {
              failures.push('conditional-options-refused:cleanup-interrupted');
            }
          }
          await retain();
        }
      });
      if (evidence.at(-1)?.failed || failures.length)
        throw new Error('Live Drive dependent cases stopped after refusal failure');

      await t.test('list-pages', async () => {
        const entry: (typeof evidence)[number] = { caseId: 'list-pages', outcomes: [] };
        evidence.push(entry);
        const fixtures: Awaited<ReturnType<typeof prepareDriveFixture>>[] = [];
        const fixtureEvidence: {
          manifest?: unknown;
          expected?: unknown;
          observation?: unknown;
          cleanup?: unknown;
        }[] = [];
        type Page = {
          files?: { id: string; name: string }[];
          nextPageToken?: string;
          incompleteSearch?: boolean;
        };
        const pages: { params: Record<string, unknown>; receipt: Receipt<Native<Page>> }[] = [];
        const readiness: { attempt: number; response: Page }[] = [];
        entry.qualification = { fixtures: fixtureEvidence, readiness, pages };
        try {
          const described = await worker!.tool<Record<string, unknown>>('describe', {
            path: 'drive/v3/files.list',
          });
          entry.qualification.discovery = {
            revision: described.revision,
            source: described.source,
          };
          assert.equal(described.supported, true);
          assert.equal(typeof described.revision, 'string');
          for (let index = 0; index < 3; index++) {
            const item: (typeof fixtureEvidence)[number] = {};
            fixtureEvidence.push(item);
            const fixture = await prepareDriveFixture({
              accessToken,
              expectedUser,
              onEvent: async (manifest) => {
                item.manifest = structuredClone(manifest);
                await retain();
              },
            });
            fixtures.push(fixture);
            item.expected = fixture.expected;
            await retain();
          }
          const expected = fixtures.map((fixture) => ({
            id: fixture.expected.fileId,
            name: fixture.expected.name,
          }));
          const expectedIds = expected.map((file) => file.id).sort();
          const escape = (name: string) => name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const q = `(${expected.map((file) => `name = '${escape(file.name)}'`).join(' or ')}) and trashed = false`;
          const common = {
            q,
            orderBy: 'name',
            fields: 'nextPageToken,incompleteSearch,files(id,name)',
          };
          let ready = false;
          const readinessDeadline = Date.now() + 30_000;
          // This direct fixture readiness check precedes a single product traversal.
          for (let attempt = 1; attempt <= 10 && Date.now() < readinessDeadline; attempt++) {
            const query = new URLSearchParams({ ...common, pageSize: '10' });
            const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
              redirect: 'error',
              signal: AbortSignal.timeout(Math.min(20_000, readinessDeadline - Date.now())),
            });
            assert.equal(response.ok, true);
            const data = (await response.json()) as Page;
            readiness.push({ attempt, response: data });
            await retain();
            ready =
              data.incompleteSearch !== true &&
              !data.nextPageToken &&
              JSON.stringify((data.files ?? []).map((file) => file.id).sort()) ===
                JSON.stringify(expectedIds);
            if (ready) break;
            if (attempt < 10) await delay(2_000);
          }
          assert.ok(
            ready,
            'Fixture search readiness was not established; no product traversal qualified',
          );
          const observed: { id: string; name: string }[] = [];
          const tokens = new Set<string>();
          let pageToken: string | undefined;
          for (let page = 0; page < 12; page++) {
            const params = {
              ...common,
              pageSize: 1,
              ...(pageToken === undefined ? {} : { pageToken }),
            };
            const receipt = await worker!.tool<Receipt<Native<Page>>>('execute', {
              accessToken,
              code: "return await google.drive({version:'v3'}).files.list(inputs);",
              inputs: params,
            });
            pages.push({ params, receipt });
            entry.outcomes.push(...receipt.outcomes);
            await retain();
            assert.equal(receipt.status, 'completed');
            assert.equal(receipt.hasUnknownOutcome, false);
            assert.equal(receipt.outcomesComplete, true);
            assert.equal(receipt.outcomes.length, 1);
            assert.equal(receipt.outcomes[0].path, 'drive/v3/files.list');
            assert.equal(receipt.outcomes[0].outcome, 'acknowledged');
            assert.equal(receipt.result.status, 200);
            const data = receipt.result.data;
            assert.deepEqual(receipt.outcomes[0].pagination, {
              query: q,
              orderBy: common.orderBy,
              fields: common.fields,
              pageSize: 1,
              ...(pageToken === undefined ? {} : { requestedPageToken: pageToken }),
              ...(data.nextPageToken === undefined ? {} : { nextPageToken: data.nextPageToken }),
              ...(data.incompleteSearch === undefined
                ? {}
                : { incompleteSearch: data.incompleteSearch }),
              ...(data.files === undefined
                ? {}
                : { returnedIds: data.files.map((file) => file.id) }),
            });
            assert.equal(
              data.incompleteSearch,
              false,
              'Explicit completeness evidence is required',
            );
            assert.notEqual(
              data.incompleteSearch,
              true,
              'Incomplete search cannot qualify completeness',
            );
            assert.ok((data.files ?? []).length <= 1);
            observed.push(...(data.files ?? []));
            const next = data.nextPageToken;
            if (next === undefined) {
              pageToken = undefined;
              break;
            }
            assert.equal(typeof next, 'string');
            assert.ok(next.length > 0 && !tokens.has(next));
            tokens.add(next);
            pageToken = next;
          }
          assert.equal(
            pageToken,
            undefined,
            'Traversal must reach a terminal page within 12 requests',
          );
          assert.ok(pages.length >= 3, 'Three files with pageSize 1 must cross page boundaries');
          assert.deepEqual(observed.map((file) => file.id).sort(), expectedIds);
          assert.deepEqual(
            observed,
            expected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          );
          for (let index = 0; index < fixtures.length; index++) {
            const fixture = fixtures[index];
            const observation = await fixture.observe();
            fixtureEvidence[index].observation = observation;
            const criteria = gradeDrive(
              { ...fixture.expected, caseId: 'rename-file', renamed: fixture.expected.name },
              observation,
              {},
            ).filter((criterion) => criterion.id !== 'drive_write_target');
            await retain();
            assert.ok(criteria.every((criterion) => criterion.status === 'pass'));
          }
          entry.qualification.complete = true;
        } catch {
          entry.failed = true;
          throw new Error('Drive pagination qualification failed; inspect retained receipt');
        } finally {
          for (let index = 0; index < fixtures.length; index++) {
            try {
              const cleanup = await fixtures[index].cleanup();
              fixtureEvidence[index].cleanup = cleanup;
              if (cleanup.failures.length || cleanup.unknownMutations.length)
                failures.push(`list-pages:${index}:cleanup`);
            } catch {
              failures.push(`list-pages:${index}:cleanup-interrupted`);
            }
          }
          await retain();
        }
      });
      if (evidence.at(-1)?.failed || failures.length)
        throw new Error('Live Drive pagination failed');
    } catch {
      failures.push('verification');
      throw new Error('Live Drive verification failed; inspect retained receipt');
    } finally {
      if (worker) {
        try {
          await worker.close();
        } catch {
          failures.push('worker.close');
        }
      }
      await retain();
      console.log(`Fixture run ${run}; receipt: dist/live-drive-receipt.json`);
      if (failures.length)
        throw new Error('Live Drive verification or cleanup failed; inspect retained receipt');
    }
  },
);
