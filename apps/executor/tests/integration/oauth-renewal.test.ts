import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { loadLocalOAuth, localCredentials, writePrivateJson } = await import(
  new URL('../support/credentials.mjs', import.meta.url).href
);
const { runOAuth } = await import(new URL('../support/oauth.mjs', import.meta.url).href);

const gmail = 'https://www.googleapis.com/auth/gmail.modify';
const drive = 'https://www.googleapis.com/auth/drive.file';
const user = 'test@example.invalid';
const client = {
  installed: { client_id: 'synthetic-client', client_secret: 'synthetic-client-secret' },
};
const grant = {
  user,
  clientId: client.installed.client_id,
  refreshToken: 'synthetic-old-grant',
  scopes: `${gmail} ${drive}`,
  createdAt: '2026-01-01T00:00:00Z',
};

async function custody(exercise: (fixture: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'codemode-oauth-custody-'));
  const directory = join(root, 'home/.config/google-codemode-mcp');
  const paths = {
    cwd: join(root, 'project'),
    home: join(root, 'home'),
    env: {},
    legacy: join(root, 'legacy.json'),
  };
  const clientFile = join(directory, 'test-oauth-client.json');
  const tokenFile = join(directory, 'test-oauth.json');
  await mkdir(paths.cwd, { recursive: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.cwd, '.test.env'), `GOOGLE_TEST_USER=${user}\n`);
  try {
    await exercise({ root, directory, paths, clientFile, tokenFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('local credentials migrate a matched legacy client once into durable private storage', async () => {
  await custody(async ({ directory, paths, clientFile, tokenFile }) => {
    await writeFile(paths.legacy, JSON.stringify(client));
    await writeFile(tokenFile, JSON.stringify(grant));
    const original = await readFile(tokenFile);
    const credentials = await localCredentials(paths);
    assert.deepEqual(Object.keys(credentials).sort(), [
      'GOOGLE_OAUTH_CLIENT_JSON',
      'GOOGLE_TEST_REFRESH_TOKEN',
      'GOOGLE_TEST_USER',
    ]);
    assert.deepEqual(JSON.parse(credentials.GOOGLE_OAUTH_CLIENT_JSON), client);
    assert.equal(credentials.GOOGLE_TEST_REFRESH_TOKEN, grant.refreshToken);
    assert.deepEqual(JSON.parse(await readFile(clientFile, 'utf8')), client);
    assert.equal((await stat(clientFile)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await readFile(tokenFile), original);
    await rm(paths.legacy);
    assert.equal((await localCredentials(paths)).GOOGLE_TEST_REFRESH_TOKEN, grant.refreshToken);
    assert.deepEqual((await readdir(directory)).sort(), [
      'test-oauth-client.json',
      'test-oauth.json',
    ]);
    await assert.rejects(
      writePrivateJson(clientFile, { unexpected: true }, { exclusive: true }),
      /EEXIST/,
    );
    assert.deepEqual(JSON.parse(await readFile(clientFile, 'utf8')), client);
  });
});

test('invalid client/grant bindings cannot install legacy registrations or replace retained grants', async () => {
  for (const value of [
    { ...grant, clientId: 'different-client' },
    { ...grant, user: 'other@example.invalid' },
    { ...grant, refreshToken: '' },
    null,
    'not-json',
  ]) {
    await custody(async ({ paths, clientFile, tokenFile }) => {
      await writeFile(paths.legacy, JSON.stringify(client));
      const bytes = value === 'not-json' ? '{invalid grant' : JSON.stringify(value);
      await writeFile(tokenFile, bytes);
      await assert.rejects(loadLocalOAuth({ ...paths, requireToken: false }), /OAuth grant/);
      await assert.rejects(access(clientFile));
      assert.equal(await readFile(tokenFile, 'utf8'), bytes);
    });
  }
});

test('explicit overrides win while invalid explicit or durable credentials never fall back', async () => {
  await custody(async ({ root, paths, clientFile, tokenFile }) => {
    await writeFile(clientFile, JSON.stringify(client));
    await writeFile(tokenFile, JSON.stringify(grant));
    await writeFile(paths.legacy, JSON.stringify(client));
    const alternateClient = join(root, 'alternate-client.json');
    const alternateGrant = join(root, 'alternate-grant.json');
    await writeFile(
      alternateClient,
      JSON.stringify({ installed: { client_id: 'alternate', client_secret: 'alternate-secret' } }),
    );
    await writeFile(alternateGrant, JSON.stringify({ ...grant, clientId: 'alternate' }));
    const env = {
      GOOGLE_OAUTH_CLIENT_FILE: alternateClient,
      GOOGLE_TEST_TOKEN_FILE: alternateGrant,
    };
    const loaded = await loadLocalOAuth({ ...paths, env });
    assert.equal(loaded.client.installed.client_id, 'alternate');
    assert.equal(loaded.tokenFile, alternateGrant);
    assert.equal(loaded.privateTokenDirectory, false);
    for (const value of ['null', '{malformed', '{}']) {
      await writeFile(alternateClient, value);
      await assert.rejects(loadLocalOAuth({ ...paths, env }), /OAuth client/);
      assert.equal(await readFile(alternateClient, 'utf8'), value);
    }
    await assert.rejects(
      loadLocalOAuth({ ...paths, env: { GOOGLE_OAUTH_CLIENT_FILE: join(root, 'absent.json') } }),
      /client registration unavailable/,
    );
    await assert.rejects(
      loadLocalOAuth({ ...paths, env: { GOOGLE_OAUTH_CLIENT_FILE: '' } }),
      /client registration unavailable/,
    );
    await assert.rejects(
      loadLocalOAuth({ ...paths, env: { GOOGLE_TEST_TOKEN_FILE: '' }, requireToken: false }),
      /grant path is empty/,
    );
    await writeFile(clientFile, 'null');
    await assert.rejects(loadLocalOAuth(paths), /OAuth client must/);
    assert.equal(await readFile(clientFile, 'utf8'), 'null');
    assert.deepEqual(JSON.parse(await readFile(tokenFile, 'utf8')), grant);
  });
});

interface RenewalScenario {
  argv?: string[];
  absent?: boolean;
  oldScopes?: string[];
  newScopes?: string[] | null;
  refreshError?: any;
  malformedRefresh?: boolean;
  infoError?: boolean;
  malformedInfo?: boolean;
  profileFailure?: boolean;
  wrongOldAccount?: boolean;
  wrongNewAccount?: boolean;
  exchangeFailure?: boolean;
  saveFailure?: boolean;
}
async function renewal(scenario: RenewalScenario, exercise: (fixture: any) => Promise<void>) {
  await custody(async ({ paths, clientFile, tokenFile, directory }) => {
    await writeFile(clientFile, JSON.stringify(client));
    if (!scenario.absent) await writeFile(tokenFile, JSON.stringify(grant));
    const state = {
      refreshes: 0,
      consents: 0,
      saves: 0,
      profiles: [] as string[],
      logs: [] as string[],
    };
    const fakeOAuth = {
      setCredentials(value: any) {
        assert.deepEqual(value, { refresh_token: grant.refreshToken });
      },
      async refreshAccessToken() {
        state.refreshes++;
        if (scenario.refreshError) throw scenario.refreshError;
        return {
          credentials: scenario.malformedRefresh ? {} : { access_token: 'synthetic-old-access' },
        };
      },
      async getTokenInfo(token: string) {
        if (scenario.infoError) throw new Error('private-upstream-diagnostic');
        if (scenario.malformedInfo) return { scopes: null };
        return {
          scopes:
            token === 'synthetic-old-access'
              ? (scenario.oldScopes ?? [gmail, drive])
              : scenario.newScopes === undefined
                ? [gmail, drive]
                : scenario.newScopes,
        };
      },
    };
    const options = {
      argv: scenario.argv ?? [],
      load: () => loadLocalOAuth({ ...paths, requireToken: false }),
      createOAuth: (id: string, secret: string) => {
        assert.equal(id, client.installed.client_id);
        assert.equal(secret, client.installed.client_secret);
        return fakeOAuth;
      },
      transport: async (url: string, init: RequestInit) => {
        assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
        const token = new Headers(init.headers).get('Authorization')!;
        state.profiles.push(token);
        if (scenario.profileFailure) throw new Error('private-upstream-diagnostic');
        const wrong =
          token === 'Bearer synthetic-old-access'
            ? scenario.wrongOldAccount
            : scenario.wrongNewAccount;
        return Response.json({ emailAddress: wrong ? 'wrong@example.invalid' : user });
      },
      authorize: async ({ requestedScopes }: any) => {
        state.consents++;
        assert.deepEqual(requestedScopes, [
          gmail,
          ...(scenario.argv?.includes('--drive') ? [drive] : []),
        ]);
        if (scenario.exchangeFailure) throw new Error('private-upstream-diagnostic');
        return { refresh_token: 'synthetic-new-grant', access_token: 'synthetic-new-access' };
      },
      save: async (...args: any[]) => {
        state.saves++;
        if (scenario.saveFailure) throw new Error('private-upstream-diagnostic');
        await writePrivateJson(...args);
      },
      log: (value: string) => state.logs.push(value),
    };
    await exercise({ state, options, tokenFile, directory });
    assert.ok(!state.logs.join('\n').includes('synthetic-old-grant'));
    assert.ok(!state.logs.join('\n').includes('synthetic-new-grant'));
    assert.ok(!state.logs.join('\n').includes('synthetic-client-secret'));
  });
}

test('OAuth reuses verified refresh grants without consent, writes, or changing retained bytes', async () => {
  for (const argv of [[], ['--drive'], ['--automate']])
    await renewal({ argv }, async ({ state, options, tokenFile }) => {
      const before = await readFile(tokenFile);
      const modification = (await stat(tokenFile)).mtimeMs;
      assert.deepEqual(await runOAuth(options), { status: 'refreshed' });
      assert.equal(state.refreshes, 1);
      assert.equal(state.consents, 0);
      assert.equal(state.saves, 0);
      assert.deepEqual(state.profiles, ['Bearer synthetic-old-access']);
      assert.deepEqual(await readFile(tokenFile), before);
      assert.equal((await stat(tokenFile)).mtimeMs, modification);
    });
});

test('OAuth consents only for absence, confirmed invalid_grant, requested scope expansion or explicit reauth', async () => {
  for (const scenario of [
    { absent: true },
    { refreshError: { response: { status: 400, data: { error: 'invalid_grant' } } } },
    { argv: ['--drive'], oldScopes: [gmail] },
    { oldScopes: [drive] },
    { argv: ['--reauth'] },
  ])
    await renewal(scenario, async ({ state, options, tokenFile, directory }) => {
      assert.deepEqual(await runOAuth(options), { status: 'authorized' });
      assert.equal(state.consents, 1);
      assert.equal(state.saves, 1);
      assert.equal(state.refreshes, scenario.absent || scenario.argv?.includes('--reauth') ? 0 : 1);
      if (scenario.oldScopes?.includes(drive) && !scenario.oldScopes.includes(gmail))
        assert.deepEqual(state.profiles, ['Bearer synthetic-new-access']);
      assert.equal(
        JSON.parse(await readFile(tokenFile, 'utf8')).refreshToken,
        'synthetic-new-grant',
      );
      assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.match(state.logs.join('\n'), /just github-secrets/);
    });
});

test('OAuth refresh and verification failures preserve grants and never launch consent', async () => {
  for (const scenario of [
    { refreshError: new Error('private-upstream-diagnostic') },
    { refreshError: { response: { status: 401, data: { error: 'invalid_client' } } } },
    { refreshError: { response: { status: 500, data: { error: 'invalid_grant' } } } },
    { refreshError: { response: { status: 400, data: {} } } },
    { malformedRefresh: true },
    { infoError: true },
    { malformedInfo: true },
    { profileFailure: true },
    { wrongOldAccount: true },
    { argv: ['--drive'], oldScopes: [gmail], wrongOldAccount: true },
  ])
    await renewal(scenario, async ({ state, options, tokenFile }) => {
      const before = await readFile(tokenFile);
      await assert.rejects(runOAuth(options), (error: any) => {
        assert.match(error.message, /existing grant preserved/);
        assert.doesNotMatch(error.message, /private-upstream-diagnostic/);
        return true;
      });
      assert.equal(state.consents, 0);
      assert.equal(state.saves, 0);
      assert.deepEqual(await readFile(tokenFile), before);
    });
});

test('OAuth exchange, replacement-account, scope and installation failures preserve the original grant', async () => {
  for (const patch of [
    { exchangeFailure: true },
    { wrongNewAccount: true },
    { profileFailure: true },
    { newScopes: [drive] },
    { newScopes: null },
    { saveFailure: true },
  ])
    await renewal({ argv: ['--reauth'], ...patch }, async ({ options, tokenFile, directory }) => {
      const before = await readFile(tokenFile);
      await assert.rejects(runOAuth(options), (error: any) => {
        assert.match(error.message, /existing grant preserved/);
        assert.doesNotMatch(error.message, /private-upstream-diagnostic/);
        return true;
      });
      assert.deepEqual(await readFile(tokenFile), before);
      assert.ok((await readdir(directory)).every((name: string) => !name.endsWith('.tmp')));
    });
});
