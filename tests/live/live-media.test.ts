import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import {
  MEDIA_RESOURCE,
  gradeMedia,
  mediaControlProgram,
  prepareMediaFixture,
} from '../eval/media.ts';
import type { McpEvent } from '../eval/server.ts';
import { openBuiltWorker, type ExecutionReceipt } from '../support/worker-client.ts';
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Live media requires ${key}`);
  return value;
};

test(
  'live Gmail/Drive byte composition and native export through built Worker',
  { timeout: 420000 },
  async (t) => {
    const evidence: Record<string, any>[] = [];
    const failures: string[] = [];
    await mkdir('dist', { recursive: true });
    const retain = () =>
      writeFile(
        'dist/live-media-receipt.json',
        JSON.stringify(
          {
            source: process.env.GITHUB_SHA ?? null,
            cases: evidence,
            failures,
            note: 'Cleanup deletes only fixture-created IDs and trusted native create IDs. Associated inventories never authorize deletion. No send or automatic retry.',
          },
          null,
          2,
        ) + '\n',
      );
    let worker: Awaited<ReturnType<typeof openBuiltWorker>> | undefined;
    try {
      const expectedUser = required('GOOGLE_TEST_USER');
      const { installed } = JSON.parse(required('GOOGLE_OAUTH_CLIENT_JSON'));
      const oauth = new OAuth2Client({
        clientId: installed.client_id,
        clientSecret: installed.client_secret,
      });
      oauth.setCredentials({ refresh_token: required('GOOGLE_TEST_REFRESH_TOKEN') });
      const refreshed = (await oauth.refreshAccessToken()).credentials;
      const accessToken = refreshed.access_token;
      if (!accessToken) throw new Error('OAuth grant unavailable');
      const scopes = (await oauth.getTokenInfo(accessToken)).scopes;
      assert.ok(
        ['gmail.modify', 'drive.file'].every((scope) =>
          scopes.includes('https://www.googleapis.com/auth/' + scope),
        ),
      );
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${accessToken}`);
      worker = await openBuiltWorker();
      for (const [caseId, exportSource] of [
        ['gmail-to-drive', false],
        ['drive-to-gmail', false],
        ['drive-to-gmail', true],
      ] as const) {
        const entry: Record<string, any> = { caseId, exportSource };
        evidence.push(entry);
        let fixture: Awaited<ReturnType<typeof prepareMediaFixture>> | undefined;
        let passed = false;
        let audit: McpEvent[] | undefined;
        let ledgerIngested = false;
        await t.test(caseId + (exportSource ? '-native-export' : ''), async () => {
          try {
            fixture = await prepareMediaFixture({
              caseId,
              exportSource,
              accessToken,
              expectedUser,
              onEvent: async (manifest) => {
                entry.manifest = manifest;
                await retain();
              },
            });
            entry.expected = fixture.expected;
            await retain();
            const resource = await worker!.resource(MEDIA_RESOURCE);
            assert.ok(
              resource.contents.some(
                (part: any) =>
                  part.uri === MEDIA_RESOURCE &&
                  typeof part.text === 'string' &&
                  part.text.length > 0,
              ),
            );
            entry.resource = { uri: MEDIA_RESOURCE, retrieved: true };
            const methods =
              caseId === 'gmail-to-drive'
                ? [
                    'gmail/v1/users.messages.get',
                    'gmail/v1/users.messages.attachments.get',
                    'drive/v3/files.create',
                  ]
                : [
                    `drive/v3/files.${exportSource ? 'export' : 'get'}`,
                    'gmail/v1/users.drafts.create',
                  ];
            entry.discovery = [];
            for (const path of methods) {
              const described = await worker!.tool<Record<string, any>>('describe', { path });
              assert.equal(described.path, path);
              assert.equal(described.supported, true);
              entry.discovery.push({
                path,
                revision: described.revision,
                runtime: described.runtime,
              });
            }
            const e = fixture.expected;
            audit = [
              { method: 'tools/call', params: { name: 'execute' }, status: 0, response: {} },
            ];
            entry.audit = audit;
            await retain();
            const receipt = await worker!.tool<ExecutionReceipt<Record<string, string>>>(
              'execute',
              {
                accessToken,
                code: mediaControlProgram(e),
                inputs: {
                  sourceMessageId: e.sourceMessageId,
                  folderId: e.folderId,
                  sourceDriveId: e.sourceDriveId,
                  name: e.name,
                  recipient: e.recipient,
                  subject: e.subject,
                  exportMimeType: e.exportMimeType,
                },
              },
            );
            entry.receipt = receipt;
            audit = [
              {
                method: 'tools/call',
                params: { name: 'execute' },
                status: 200,
                response: { result: { structuredContent: receipt } },
              },
            ];
            entry.audit = audit;
            await retain();
            const observed = await fixture.observe(
              {
                'answer.json': Buffer.from(JSON.stringify(receipt.result)).toString('base64'),
              },
              audit,
            );
            ledgerIngested = true;
            entry.observation = observed;
            assert.equal(receipt.status, 'completed');
            assert.equal(receipt.outcomesComplete, true);
            assert.equal(receipt.hasUnknownOutcome, false);
            entry.criteria = gradeMedia(
              e,
              observed,
              { 'answer.json': Buffer.from(JSON.stringify(receipt.result)).toString('base64') },
              audit,
            );
            await retain();
            assert.ok(entry.criteria.every((criterion: any) => criterion.status === 'pass'));
            passed = true;
          } catch {
            entry.failed = true;
            throw new Error(
              'Live media transfer failed; inspect retained receipt, remote diagnostics suppressed',
            );
          } finally {
            if (fixture) {
              if (audit && !ledgerIngested) {
                try {
                  await fixture.observe(undefined, audit);
                } catch {
                  failures.push(caseId + ':ledger-ingest');
                }
              }
              try {
                const cleanup = await fixture.cleanup();
                entry.cleanup = cleanup;
                if (cleanup.failures.length || cleanup.unknownMutations.length)
                  failures.push(caseId + ':cleanup');
              } catch {
                failures.push(caseId + ':cleanup-interrupted');
              }
            }
            await retain();
          }
        });
        if (!passed || failures.length)
          throw new Error('Media controls stopped after failure or incomplete cleanup');
      }
    } catch {
      failures.push('verification');
      throw new Error('Live media verification failed; inspect retained receipt');
    } finally {
      if (worker)
        try {
          await worker.close();
        } catch {
          failures.push('worker.close');
        }
      await retain();
      if (failures.length) throw new Error('Live media verification or cleanup failed');
    }
  },
);
