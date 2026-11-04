import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { openBuiltWorker, type ExecutionReceipt } from '../worker-client.ts';

type Native<T> = { data: T; status: number; headers: Record<string, string> };
type Label = { id: string; name: string };
type Message = {
  id: string;
  threadId: string;
  labelIds?: string[];
  raw?: string;
  payload?: { headers?: { name: string; value: string }[] };
};
type Draft = { id: string; message: Message };
type Page = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};
type DraftPage = { drafts?: Draft[]; nextPageToken?: string; resultSizeEstimate?: number };

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Live Gmail verification requires ${name}`);
  return value;
}

async function credentials() {
  const expected = required('GOOGLE_TEST_USER');
  const configuration = required('GOOGLE_OAUTH_CLIENT_JSON');
  const refreshToken = required('GOOGLE_TEST_REFRESH_TOKEN');
  try {
    assert.ok(/^[^\s@<>\r\n]+@[^\s@<>\r\n]+$/.test(expected));
    const { installed } = JSON.parse(configuration);
    assert.equal(typeof installed.client_id, 'string');
    assert.equal(typeof installed.client_secret, 'string');
    const oauth = new OAuth2Client({
      clientId: installed.client_id,
      clientSecret: installed.client_secret,
    });
    oauth.setCredentials({ refresh_token: refreshToken });
    const refreshed = await oauth.refreshAccessToken();
    assert.equal(typeof refreshed.credentials.access_token, 'string');
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::add-mask::${refreshed.credentials.access_token}`);
      console.log(`::add-mask::${installed.client_secret}`);
    }
    const scopes = refreshed.credentials.scope
      ? refreshed.credentials.scope.split(' ')
      : (await oauth.getTokenInfo(refreshed.credentials.access_token!)).scopes;
    assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.modify'));
    return { expected, accessToken: refreshed.credentials.access_token! };
  } catch {
    throw new Error(
      'Installed OAuth client/token refresh validation failed; diagnostics suppressed',
    );
  }
}

function pageShape(page: Page) {
  assert.ok(page !== null && typeof page === 'object');
  if (page.messages !== undefined) {
    assert.ok(Array.isArray(page.messages));
    for (const message of page.messages) {
      assert.equal(typeof message.id, 'string');
      assert.equal(typeof message.threadId, 'string');
    }
  }
  if (page.nextPageToken !== undefined) assert.equal(typeof page.nextPageToken, 'string');
  if (page.resultSizeEstimate !== undefined) assert.equal(typeof page.resultSizeEstimate, 'number');
}

test('live Gmail through the built sessionless Worker', { timeout: 240_000 }, async (t) => {
  // Explicit live target only: missing credentials fail instead of silently skipping.
  const { expected, accessToken } = await credentials();
  let worker: Awaited<ReturnType<typeof openBuiltWorker>>;
  try {
    worker = await openBuiltWorker();
  } catch {
    throw new Error('Live Gmail built Worker setup failed; diagnostics suppressed');
  }
  const run = randomUUID();
  const labelName = `codemode-live-${run}`;
  const messageId = `<codemode-live-${run}@test.invalid>`;
  const drafts = new Set<string>();
  const labels = new Set<string>();
  const sentMessages = new Set<string>();
  let guarded = false;
  const unknownMutations: { path: string; outcome: string }[] = [];

  const execute = <T>(code: string, inputs: Record<string, unknown> = {}, token = accessToken) =>
    worker.tool<ExecutionReceipt<T>>('execute', { accessToken: token, code, inputs });
  function completed<T>(receipt: ExecutionReceipt<T>) {
    for (const outcome of receipt.outcomes) {
      if (outcome.mutation && outcome.outcome === 'unknown')
        unknownMutations.push({ path: outcome.path, outcome: outcome.outcome });
    }
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.hasUnknownOutcome, false);
    assert.ok(receipt.outcomes.every((outcome) => outcome.outcome === 'acknowledged'));
    return receipt.result;
  }
  const method = async <T>(path: string, params: Record<string, unknown>) =>
    execute<Native<T>>(`return await google.gmail({version:'v1'}).${path}(inputs);`, params);
  const native = async <T>(path: string, params: Record<string, unknown>) =>
    completed(await method<T>(path, params));
  const fixtureMutation = async <T extends { id: string }>(
    path: string,
    params: Record<string, unknown>,
    ids: Set<string>,
  ) => {
    const receipt = await method<T>(path, params);
    // Record an available ID before assertions, so later failures still clean up.
    if (typeof receipt.result?.data?.id === 'string') ids.add(receipt.result.data.id);
    return completed(receipt);
  };
  const stage = async (name: string, action: () => Promise<void>) => {
    let passed = false;
    await t.test(name, async () => {
      try {
        await action();
        passed = true;
      } catch {
        throw new Error('Live Gmail stage failed; credentials and mailbox diagnostics suppressed');
      }
    });
    if (!passed) throw new Error('Live Gmail dependent stages stopped after a failed prerequisite');
  };
  const raw = (tag: string, body: string) =>
    Buffer.from(
      `From: ${expected}\r\nTo: ${expected}\r\nSubject: codemode live ${run} ${tag}\r\nMessage-ID: <${tag}-${run}@test.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n`,
      'utf8',
    ).toString('base64url');

  try {
    await stage('expected Gmail profile guard before fixture writes', async () => {
      const profile = await native<{ emailAddress: string }>('users.getProfile', { userId: 'me' });
      assert.equal(profile.data.emailAddress.toLowerCase(), expected.toLowerCase());
      guarded = true;
    });

    await stage(
      'official Discovery, native empty page, and snippet invocation parity',
      async () => {
        const description = await worker.tool<Record<string, unknown>>('describe', {
          path: 'gmail/v1/users.messages.list',
        });
        assert.equal(description.source, 'https://gmail.googleapis.com/$discovery/rest?version=v1');
        assert.equal(typeof description.revision, 'string');
        const empty = await native<Page>('users.messages.list', {
          userId: 'me',
          q: `rfc822msgid:never-created-${run}@test.invalid`,
          maxResults: 1,
        });
        pageShape(empty.data);
        assert.equal(empty.data.messages?.length ?? 0, 0);
        const inline = await execute<Page>(`return await snippets.run('gmailInbox',inputs);`, {
          maxResults: 1,
        });
        const exposed = await worker.tool<ExecutionReceipt<Page>>('gmail_inbox', {
          accessToken,
          inputs: { maxResults: 1 },
        });
        pageShape(completed(inline));
        pageShape(completed(exposed));
        // Concurrent mailbox activity may change IDs between calls. Compare their
        // native shape and dispatcher methods; controlled fixture pagination is below.
        assert.equal(inline.outcomes.length, 1);
        assert.equal(exposed.outcomes.length, 1);
        assert.equal(inline.outcomes[0].path, 'gmail/v1/users.messages.list');
        assert.equal(exposed.outcomes[0].path, inline.outcomes[0].path);
      },
    );

    let labelId: string;
    await stage('temporary label create/get/update', async () => {
      assert.equal(guarded, true);
      const created = await fixtureMutation<Label>(
        'users.labels.create',
        {
          userId: 'me',
          requestBody: {
            name: labelName,
            labelListVisibility: 'labelHide',
            messageListVisibility: 'hide',
          },
        },
        labels,
      );
      labelId = created.data.id;
      const found = await native<Label>('users.labels.get', { userId: 'me', id: labelId });
      assert.equal(found.data.name, labelName);
      const changed = await native<Label>('users.labels.update', {
        userId: 'me',
        id: labelId,
        requestBody: { name: `${labelName}-updated` },
      });
      assert.equal(changed.data.name, `${labelName}-updated`);
    });

    await stage('draft create/get/update preserves base64url message body', async () => {
      const original = raw('draft', `original fixture ${run}`);
      assert.match(original, /^[A-Za-z0-9_-]+$/);
      const created = await fixtureMutation<Draft>(
        'users.drafts.create',
        {
          userId: 'me',
          requestBody: { message: { raw: original } },
        },
        drafts,
      );
      const read = await native<Draft>('users.drafts.get', {
        userId: 'me',
        id: created.data.id,
        format: 'raw',
      });
      assert.ok(
        Buffer.from(read.data.message.raw!, 'base64url')
          .toString('utf8')
          .includes(`original fixture ${run}`),
      );
      const changed = await fixtureMutation<Draft>(
        'users.drafts.update',
        {
          userId: 'me',
          id: created.data.id,
          requestBody: { message: { raw: raw('draft', `updated fixture ${run}`) } },
        },
        drafts,
      );
      const updated = await native<Draft>('users.drafts.get', {
        userId: 'me',
        id: changed.data.id,
        format: 'raw',
      });
      assert.ok(
        Buffer.from(updated.data.message.raw!, 'base64url')
          .toString('utf8')
          .includes(`updated fixture ${run}`),
      );
      await fixtureMutation<Draft>(
        'users.drafts.create',
        {
          userId: 'me',
          requestBody: { message: { raw: raw('page', `pagination fixture ${run}`) } },
        },
        drafts,
      );
    });

    await stage(
      'explicit native pagination visits only this run drafts without duplicates',
      async () => {
        // Gmail drafts cannot have custom labels. Isolate the two fixtures by
        // their exact RFC Message-IDs using the native drafts.list query.
        const q = `{rfc822msgid:draft-${run}@test.invalid rfc822msgid:page-${run}@test.invalid}`;
        let indexed = false;
        for (let attempt = 0; attempt < 6 && !indexed; attempt++) {
          if (attempt) await delay(1_000);
          const response = await native<DraftPage>('users.drafts.list', {
            userId: 'me',
            q,
            maxResults: 5,
          });
          indexed = response.data.drafts?.length === 2;
        }
        assert.equal(indexed, true);
        const ids = new Set<string>();
        let pageToken: string | undefined;
        let pages = 0;
        do {
          const response = await native<DraftPage>('users.drafts.list', {
            userId: 'me',
            q,
            maxResults: 1,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const draft of response.data.drafts ?? []) {
            assert.equal(typeof draft.message.id, 'string');
            assert.equal(typeof draft.message.threadId, 'string');
            assert.ok(drafts.has(draft.id));
            assert.ok(!ids.has(draft.id));
            ids.add(draft.id);
          }
          pageToken = response.data.nextPageToken;
          pages++;
        } while (pageToken && pages < 6);
        assert.equal(pageToken, undefined);
        assert.equal(ids.size, 2);
        assert.ok(pages >= 2);
      },
    );

    await stage('single self-send is acknowledged without an automatic retry', async () => {
      const mime = Buffer.from(
        `From: ${expected}\r\nTo: ${expected}\r\nSubject: codemode self-send ${run}\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nself-send fixture ${run}\r\n`,
      ).toString('base64url');
      // Exactly one submission. A lost/unknown result fails instead of resending.
      const receipt = await method<Message>('users.messages.send', {
        userId: 'me',
        requestBody: { raw: mime },
      });
      if (receipt.result?.data?.id) sentMessages.add(receipt.result.data.id);
      const sent = completed(receipt);
      assert.equal(typeof sent.data.id, 'string');
      assert.equal(receipt.outcomes.length, 1);
      assert.equal(receipt.outcomes[0].mutation, true);
      assert.equal(receipt.outcomes[0].outcome, 'acknowledged');
      const labeled = await native<Message>('users.messages.modify', {
        userId: 'me',
        id: sent.data.id,
        requestBody: { addLabelIds: [labelId!] },
      });
      assert.ok(labeled.data.labelIds?.includes(labelId!));
    });

    await stage(
      'bounded polling separately observes the self-send in the recipient inbox',
      async () => {
        let delivered = false;
        for (let attempt = 0; attempt < 6 && !delivered; attempt++) {
          if (attempt) await delay(1_500);
          const response = await native<Page>('users.messages.list', {
            userId: 'me',
            q: `rfc822msgid:${messageId.slice(1, -1)}`,
            labelIds: ['INBOX'],
            maxResults: 5,
          });
          for (const message of response.data.messages ?? []) {
            sentMessages.add(message.id);
            const read = await native<Message>('users.messages.get', {
              userId: 'me',
              id: message.id,
              format: 'metadata',
              metadataHeaders: ['Message-ID', 'From', 'To'],
            });
            const headers = new Map(
              read.data.payload?.headers?.map((header) => [
                header.name.toLowerCase(),
                header.value,
              ]),
            );
            assert.equal(headers.get('message-id'), messageId);
            assert.ok(headers.get('to')?.toLowerCase().includes(expected.toLowerCase()));
            assert.ok(headers.get('from')?.toLowerCase().includes(expected.toLowerCase()));
            assert.ok(read.data.labelIds?.includes('INBOX'));
            delivered = true;
          }
        }
        assert.equal(delivered, true);
      },
    );

    await stage(
      'invalid token produces an authoritative rejection recorded through catch',
      async () => {
        const rejected = await execute<{ status: number }>(
          `try {await google.gmail({version:'v1'}).users.getProfile({userId:'me'});} catch(error) {return {status:error.httpStatus};} throw new Error('Invalid token unexpectedly accepted');`,
          {},
          'invalid-live-verification-token',
        );
        assert.equal(rejected.status, 'completed');
        assert.equal(rejected.result.status, 401);
        assert.equal(rejected.hasUnknownOutcome, false);
        assert.equal(rejected.outcomes.length, 1);
        assert.equal(rejected.outcomes[0].outcome, 'rejected');
        assert.equal(rejected.outcomes[0].httpStatus, 401);
      },
    );
  } finally {
    const cleanupFailures: string[] = [];
    if (guarded) {
      // Only IDs returned by this run are touched; no mailbox-wide cleanup scans.
      for (const [path, ids] of [
        ['users.drafts.delete', drafts],
        ['users.messages.trash', sentMessages],
        ['users.labels.delete', labels],
      ] as const) {
        for (const id of ids) {
          try {
            const receipt = await method(path, { userId: 'me', id });
            const absent =
              receipt.outcomes.length === 1 &&
              receipt.outcomes[0].outcome === 'rejected' &&
              receipt.outcomes[0].httpStatus === 404;
            if (!absent) {
              const response = completed(receipt);
              if (path === 'users.messages.trash') {
                assert.ok((response.data as Message).labelIds?.includes('TRASH'));
              } else {
                assert.ok(response.status >= 200 && response.status < 300);
                assert.ok(
                  response.data === null ||
                    (typeof response.data === 'object' &&
                      Object.keys(response.data as object).length === 0),
                );
                const getPath =
                  path === 'users.drafts.delete' ? 'users.drafts.get' : 'users.labels.get';
                const verify = await method(getPath, { userId: 'me', id });
                assert.equal(verify.outcomes.length, 1);
                assert.equal(verify.outcomes[0].outcome, 'rejected');
                assert.equal(verify.outcomes[0].httpStatus, 404);
              }
            }
          } catch {
            cleanupFailures.push(path);
          }
        }
      }
    }
    try {
      await worker.close();
    } catch {
      cleanupFailures.push('worker.close');
    }
    await writeFile(
      'dist/live-gmail-receipt.json',
      JSON.stringify(
        {
          run,
          source: process.env.GITHUB_SHA ?? null,
          googleProfileGuardPassed: guarded,
          markers: {
            label: labelName,
            draftMessageIds: [`<draft-${run}@test.invalid>`, `<page-${run}@test.invalid>`],
            sendMessageId: messageId,
          },
          recordedIds: { labels: [...labels], drafts: [...drafts], messages: [...sentMessages] },
          unknownMutations,
          cleanupFailures,
          note: 'Unknown mutations may exist without a returned ID. Markers are reconciliation aids, not proof of absence.',
        },
        null,
        2,
      ),
    );
    console.log(`Fixture run ${run}; receipt: dist/live-gmail-receipt.json`);
    if (cleanupFailures.length) {
      throw new Error('Live Gmail cleanup failed for recorded fixture IDs; diagnostics suppressed');
    }
  }
});
