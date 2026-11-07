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
      for (const [caseId, exportSource, references] of [
        ['gmail-to-drive', false, false],
        ['drive-to-gmail', false, false],
        ['drive-to-gmail', true, false],
        ['drive-to-gmail', false, true],
      ] as const) {
        const entry: Record<string, any> = { caseId, exportSource, references };
        evidence.push(entry);
        let fixture: Awaited<ReturnType<typeof prepareMediaFixture>> | undefined;
        let passed = false;
        let audit: McpEvent[] | undefined;
        const artifactUris = new Set<string>();
        let ledgerIngested = false;
        await t.test(
          caseId + (references ? '-stored-roundtrip-256KiB' : exportSource ? '-native-export' : ''),
          async () => {
            try {
              fixture = await prepareMediaFixture({
                caseId,
                exportSource,
                ...(references ? { byteLength: 262144 } : {}),
                accessToken,
                expectedUser,
                onEvent: async (manifest) => {
                  entry.manifest = manifest;
                  await retain();
                },
              });
              if (references) {
                await worker!.close();
                worker = await openBuiltWorker({ artifacts: true });
              }
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
                      ...(references
                        ? [
                            'gmail/v1/users.drafts.get',
                            'gmail/v1/users.messages.attachments.get',
                            'drive/v3/files.create',
                          ]
                        : []),
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
                  code: references
                    ? `
const drive=google.drive({version:'v3'}), gmail=google.gmail({version:'v1'});
const {data:source}=await drive.files.get({fileId:inputs.sourceDriveId,alt:'media'});
const mime=await artifacts.composeMime({to:inputs.recipient,subject:inputs.subject,text:'Controlled reference trial',attachments:[{artifact:source.uri,name:inputs.name,mimeType:source.mimeType}]});
const {data:draft}=await gmail.users.drafts.create({userId:'me',requestBody:{},media:{mimeType:'message/rfc822',body:{artifact:mime.uri}}});
return {draftId:draft.id};`
                    : mediaControlProgram(e),
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
              if (references) {
                for (const ref of (receipt as any).artifacts?.references ?? [])
                  artifactUris.add(ref.uri);
                // Ingest acknowledged identities before a later call could fail.
                await fixture.observe(undefined, audit);
                audit.push({
                  method: 'tools/call',
                  params: { name: 'execute' },
                  status: 0,
                  response: {},
                });
                await retain();
                const copied = await worker!.tool<ExecutionReceipt<Record<string, string>>>(
                  'execute',
                  {
                    accessToken,
                    inputs: { draftId: receipt.result.draftId },
                    code: `
const gmail=google.gmail({version:'v1'});
const {data:draft}=await gmail.users.drafts.get({userId:'me',id:inputs.draftId,format:'full'});
function parts(p){return [p,...(p.parts??[]).flatMap(parts)];}
const selected=parts(draft.message.payload).filter(p=>p.filename);
if(selected.length!==1 || !selected[0].body.attachmentId)throw Error('Expected external attachment');
const part=selected[0];
const file=await artifacts.fromGmailAttachment({userId:'me',messageId:draft.message.id,id:part.body.attachmentId},{name:part.filename,mimeType:part.mimeType});
const {data:copy}=await google.drive({version:'v3'}).files.create({requestBody:{name:file.name},media:{mimeType:file.mimeType,body:{artifact:file.uri}}});
return {fileId:copy.id};`,
                  },
                );
                entry.copyReceipt = copied;
                for (const ref of (copied as any).artifacts?.references ?? [])
                  artifactUris.add(ref.uri);
                audit[audit.length - 1] = {
                  method: 'tools/call',
                  params: { name: 'execute' },
                  status: 200,
                  response: { result: { structuredContent: copied } },
                };
                assert.equal(copied.status, 'completed');
                assert.equal(copied.outcomesComplete, true);
                assert.equal(copied.hasUnknownOutcome, false);
                assert.ok(
                  audit.every((event) => JSON.stringify(event.response).length < 16000),
                  'receipts contain metadata only',
                );
              }
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
              entry.criteria = references
                ? [
                    {
                      id: 'stored-roundtrip-256KiB',
                      status:
                        observed.complete &&
                        observed.sourceUnchanged &&
                        observed.targets.length === 1 &&
                        observed.drafts.length === 1 &&
                        !observed.unexpectedDraftIds.length &&
                        observed.targets[0].sha256 === e.sha256 &&
                        observed.targets[0].bytes === 262144 &&
                        observed.targets[0].name === e.name &&
                        observed.targets[0].mimeType === e.mimeType &&
                        observed.drafts[0].attachments.length === 1 &&
                        observed.drafts[0].attachments[0].sha256 === e.sha256 &&
                        observed.drafts[0].attachments[0].bytes === 262144 &&
                        observed.drafts[0].attachments[0].name === e.name &&
                        observed.drafts[0].attachments[0].mimeType === e.mimeType &&
                        observed.drafts[0].to === e.recipient &&
                        observed.drafts[0].subject === e.subject
                          ? 'pass'
                          : 'fail',
                    },
                  ]
                : gradeMedia(
                    e,
                    observed,
                    {
                      'answer.json': Buffer.from(JSON.stringify(receipt.result)).toString('base64'),
                    },
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
              if (references && worker) {
                try {
                  const deleted = await worker.tool<ExecutionReceipt>('execute', {
                    accessToken,
                    inputs: { uris: [...artifactUris] },
                    code: 'for(const uri of inputs.uris)await artifacts.delete(uri); return true;',
                  });
                  assert.equal(deleted.status, 'completed');
                  assert.equal((await worker.artifactBucket!.list()).objects.length, 0);
                  entry.artifactCleanup = { deleted: [...artifactUris], empty: true };
                } catch {
                  failures.push(caseId + ':artifact-cleanup');
                }
              }
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
                  if (!cleanup.failures.length && !cleanup.unknownMutations.length) {
                    const absent = [];
                    for (const [kind, ids] of [
                      ['drive/v3/files', entry.manifest.fileIds],
                      ['gmail/v1/users/me/drafts', entry.manifest.draftIds],
                    ] as const) {
                      for (const id of ids) {
                        const response: Response = await fetch(
                          'https://www.googleapis.com/' + kind + '/' + encodeURIComponent(id),
                          {
                            headers: { Authorization: 'Bearer ' + accessToken },
                            redirect: 'error',
                            signal: AbortSignal.timeout(20000),
                          },
                        );
                        await response.body?.cancel();
                        absent.push({ kind, id, status: response.status });
                        assert.equal(
                          response.status,
                          404,
                          'owned fixture still readable after cleanup',
                        );
                      }
                    }
                    entry.cleanup.absence = absent;
                  }
                  if (cleanup.failures.length || cleanup.unknownMutations.length)
                    failures.push(caseId + ':cleanup');
                } catch {
                  failures.push(caseId + ':cleanup-interrupted');
                }
              }
              await retain();
            }
          },
        );
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
