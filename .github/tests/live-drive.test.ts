import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { gradeDrive, prepareDriveFixture } from '../eval/drive.ts';
import type { McpEvent } from '../eval/server.ts';
import type { CallOutcome } from '../../src/dispatcher.ts';
import { openBuiltWorker, type ExecutionReceipt } from '../worker-client.ts';

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
  'live Drive read/download and rename through the built sessionless Worker',
  { timeout: 240_000 },
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
