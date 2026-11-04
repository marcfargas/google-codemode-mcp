import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    const child = spawn(process.execPath, [resolve('.github/oauth.mjs')], {
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
