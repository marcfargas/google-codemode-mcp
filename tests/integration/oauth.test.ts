import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const omitScheme of [false, true])
  test(
    `OAuth CLI accepts a private pasted redirect (omit scheme: ${omitScheme}) and rejects foreign or ambiguous URLs`,
    {
      timeout: 15_000,
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'codemode-oauth-paste-'));
      const clientFile = join(directory, 'client.json');
      const grantFile = join(directory, 'grant.json');
      await writeFile(
        clientFile,
        JSON.stringify({
          installed: {
            client_id: 'synthetic-client',
            client_secret: 'synthetic-private-client-secret',
          },
        }),
      );
      await writeFile(join(directory, '.test.env'), 'GOOGLE_TEST_USER=test@example.invalid\n');
      const child = spawn(process.execPath, [resolve('tests/support/oauth.mjs')], {
        cwd: directory,
        env: {
          ...process.env,
          GOOGLE_OAUTH_CLIENT_FILE: clientFile,
          GOOGLE_TEST_TOKEN_FILE: grantFile,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      let output = '';
      let errors = '';
      child.stderr.on('data', (chunk) => {
        errors += String(chunk);
      });
      const authorization = new Promise<URL>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          const match = output.match(/https:\/\/accounts\.google\.com\/[^\s]+/);
          if (match) resolve(new URL(match[0]));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('OAuth CLI exited before authorization URL')));
      });
      try {
        const url = await authorization;
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('state', url.searchParams.get('state')!);
        redirect.searchParams.set('code', 'pasted-private-code-must-not-be-logged');
        const invalid: string[] = ['not a URL'];
        for (const mutate of [
          (u: URL) => {
            u.hostname = 'example.invalid';
          },
          (u: URL) => {
            u.port = u.port === '1' ? '2' : '1';
          },
          (u: URL) => {
            u.pathname = '/different-callback';
          },
          (u: URL) => {
            u.searchParams.set('state', 'foreign-state');
          },
          (u: URL) => {
            u.searchParams.append('code', 'second-code');
          },
          (u: URL) => {
            u.searchParams.append('state', url.searchParams.get('state')!);
          },
          (u: URL) => {
            u.searchParams.set('error', 'access_denied');
          },
          (u: URL) => {
            u.username = 'foreign-user';
          },
          (u: URL) => {
            u.hash = '#unexpected';
          },
        ]) {
          const wrong = new URL(redirect);
          mutate(wrong);
          invalid.push(wrong.href);
        }
        child.stdin.write(invalid.join('\n') + '\n');
        // A valid pasted denial proves stdin reached the same consent handler,
        // without exchanging any code or contacting Google.
        redirect.searchParams.delete('code');
        redirect.searchParams.set('error', 'access_denied');
        child.stdin.end((omitScheme ? redirect.href.replace('http://', '') : redirect.href) + '\n');
        const [code, signal] = await exited;
        assert.equal(signal, null);
        assert.equal(code, 1);
        assert.equal(output.match(/Invalid OAuth redirect URL;/g)?.length, invalid.length);
        assert.match(errors, /Google consent was denied/);
        assert.doesNotMatch(output + errors, /pasted-private-code|synthetic-private-client-secret/);
        await assert.rejects(access(grantFile));
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await exited;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

// Exercise the public CLI without real Google credentials or a browser.
test(
  'OAuth CLI uses loopback, state and PKCE, refuses foreign callbacks without storing a grant',
  { timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codemode-oauth-test-'));
    const secret = 'synthetic-client-secret-must-stay-private';
    const clientFile = join(directory, 'client.json');
    const grantFile = join(directory, 'grant.json');
    await writeFile(
      clientFile,
      JSON.stringify({ installed: { client_id: 'synthetic-client', client_secret: secret } }),
    );
    await writeFile(
      join(directory, '.test.env'),
      'GOOGLE_TEST_USER=test@example.invalid\nGOOGLE_TEST_PASSWORD=unused-password\nGOOGLE_TEST_TOPT_KEY=unused-seed\n',
    );
    const child = spawn(process.execPath, [resolve('tests/support/oauth.mjs')], {
      cwd: directory,
      env: {
        ...process.env,
        GOOGLE_OAUTH_CLIENT_FILE: clientFile,
        GOOGLE_TEST_TOKEN_FILE: grantFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const errors: string[] = [];
    child.stderr.on('data', (chunk) => errors.push(String(chunk)));
    try {
      const url = await new Promise<URL>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          const match = output.match(/https:\/\/accounts\.google\.com\/[^\s]+/);
          if (match) resolve(new URL(match[0]));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('OAuth CLI exited before authorization URL')));
      });
      assert.equal(url.searchParams.get('access_type'), 'offline');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok((url.searchParams.get('code_challenge')?.length ?? 0) > 40);
      assert.ok((url.searchParams.get('state')?.length ?? 0) >= 32);
      assert.equal(url.searchParams.has('client_secret'), false);
      assert.equal(url.searchParams.has('code_verifier'), false);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      assert.equal(callback.hostname, '127.0.0.1');
      callback.searchParams.set('state', 'foreign-state');
      callback.searchParams.set('code', 'not-a-real-code');
      assert.equal((await fetch(callback)).status, 400);
      await assert.rejects(access(grantFile));
      assert.ok(!output.includes(secret));
      assert.ok(!output.includes('unused-password'));
      assert.deepEqual(errors, []);
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      await rm(directory, { recursive: true, force: true });
    }
  },
);
