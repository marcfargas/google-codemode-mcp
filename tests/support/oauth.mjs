import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { OAuth2Client } from 'google-auth-library';
import { loadLocalOAuth, writePrivateJson } from './credentials.mjs';

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/[\s=-]/g, '')) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid local TOTP key');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((v) => parseInt(v, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', bytes).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

async function automate(url, expectedUser, argv) {
  const { chromium } = await import('playwright');
  const local = parseEnv(await readFile('.test.env', 'utf8'));
  if (!local.GOOGLE_TEST_PASSWORD || !local.GOOGLE_TEST_TOPT_KEY)
    throw new Error('Missing local sign-in credentials');
  const browser = await chromium.launch({
    headless: !argv.includes('--headed'),
    ...(process.env.GOOGLE_CHROME_PATH ? { executablePath: process.env.GOOGLE_CHROME_PATH } : {}),
  });
  const page = await browser.newPage({ locale: 'en-US' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log('Opened Google consent in a temporary local browser');
  let passwordEntered = false,
    emailEntered = false;
  const started = Date.now();
  try {
    while (Date.now() - started < 180000) {
      if (new URL(page.url()).hostname === '127.0.0.1') return browser;
      if (
        await page
          .locator('input#identifierId, input[type="email"]')
          .isVisible()
          .catch(() => false)
      ) {
        if (emailEntered) {
          await page.waitForTimeout(1000);
          continue;
        }
        await page.locator('input#identifierId, input[type="email"]').fill(expectedUser);
        await page.getByRole('button', { name: /^Next$/i }).click();
        emailEntered = true;
        console.log('Submitted test account identifier');
      } else if (
        await page
          .locator('input[type="password"]:visible')
          .isVisible()
          .catch(() => false)
      ) {
        if (passwordEntered) {
          await page.waitForTimeout(1000);
          continue;
        }
        await page.locator('input[type="password"]:visible').fill(local.GOOGLE_TEST_PASSWORD);
        await page.getByRole('button', { name: /^Next$/i }).click();
        passwordEntered = true;
        console.log('Submitted local test account password');
      } else if (
        await page
          .locator('input[name="totpPin"]')
          .isVisible()
          .catch(() => false)
      ) {
        await page.locator('input[name="totpPin"]').fill(totp(local.GOOGLE_TEST_TOPT_KEY));
        await page.getByRole('button', { name: /^Next$/i }).click();
        console.log('Submitted local authenticator code');
      } else {
        const text = await page.locator('body').innerText();
        if (
          /couldn.t sign you in|browser or app may not be secure|access blocked|app.*not.*verified.*developer|Error 403/i.test(
            text,
          )
        ) {
          throw new Error(
            'Google blocked automated consent; complete just oauth manually in a browser',
          );
        }
        const authenticator = page
          .getByText(/Get a verification code from the Google Authenticator app/i)
          .first();
        const advanced = page.getByRole('button', { name: /^Advanced$/i });
        const unsafe = page.getByRole('link', { name: /Go to .+\(unsafe\)/i });
        const allow = page.getByRole('button', { name: /^(Continue|Allow)$/i }).last();
        if (await authenticator.isVisible().catch(() => false)) await authenticator.click();
        else if (await advanced.isVisible().catch(() => false)) await advanced.click();
        else if (await unsafe.isVisible().catch(() => false)) await unsafe.click();
        else if (await allow.isVisible().catch(() => false)) await allow.click();
      }
      await page.waitForTimeout(1000);
    }
    throw new Error('Automated consent did not complete; use interactive just oauth');
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function browserConsent({ credentials, config, requestedScopes, argv, createOAuth }) {
  let server, browser, pasteInput;
  try {
    const state = randomBytes(32).toString('hex');
    let accept, reject;
    const callback = new Promise((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    callback.catch(() => {});
    function parseCallback(url) {
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state)
        throw new Error('Invalid OAuth state');
      const codes = url.searchParams.getAll('code');
      const errors = url.searchParams.getAll('error');
      if (errors.length === 1 && errors[0] && codes.length === 0) return { denied: true };
      if (codes.length === 1 && codes[0] && errors.length === 0) return { code: codes[0] };
      throw new Error('Invalid OAuth response');
    }
    function settleCallback(result) {
      if (result.denied) reject(new Error('Google consent was denied'));
      else accept(result.code);
    }
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404).end();
        return;
      }
      let result;
      try {
        result = parseCallback(url);
      } catch {
        response.writeHead(400).end('Invalid OAuth callback');
        return;
      }
      response
        .writeHead(result.denied ? 400 : 200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        })
        .end(
          result.denied
            ? 'Consent was not granted'
            : 'OAuth callback received. You can close this tab.',
        );
      settleCallback(result);
    });
    await new Promise((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
    const oauth = createOAuth(config.client_id, config.client_secret, redirect);
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const url = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: requestedScopes,
      include_granted_scopes: true,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      login_hint: credentials.GOOGLE_TEST_USER,
    });
    const timer = setTimeout(() => reject(new Error('OAuth consent timed out')), 15 * 60 * 1000);
    try {
      if (argv.includes('--automate'))
        browser = await automate(url, credentials.GOOGLE_TEST_USER, argv);
      else {
        pasteInput = createInterface({
          input: process.stdin,
          terminal: Boolean(process.stdin.isTTY),
          output: new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
        });
        pasteInput.on('SIGINT', () => reject(new Error('OAuth consent cancelled')));
        pasteInput.on('line', (line) => {
          if (!line.trim()) return;
          let result;
          try {
            const value = line.trim();
            const pasted = new URL(value.startsWith('127.0.0.1:') ? `http://${value}` : value);
            const expected = new URL(redirect);
            if (
              pasted.origin !== expected.origin ||
              pasted.pathname !== expected.pathname ||
              pasted.username ||
              pasted.password ||
              pasted.hash
            )
              throw new Error('Foreign callback');
            result = parseCallback(pasted);
          } catch {
            console.log(
              'Invalid OAuth redirect URL; paste the full URL from this consent attempt.',
            );
            return;
          }
          pasteInput.close();
          process.stdin.pause();
          settleCallback(result);
        });
        console.log(`Local callback port: ${server.address().port}`);
        console.log(`Open this one-time local authorization URL in your browser:\n${url}`);
        console.log(
          'After consent, paste the full localhost redirect URL here (input is hidden). No port forwarding needed.',
        );
      }
      const code = await callback;
      let tokens;
      try {
        ({ tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirect }));
      } catch {
        throw new Error('OAuth code exchange failed; existing grant preserved');
      }
      return tokens;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await browser?.close();
    pasteInput?.close();
    process.stdin.pause();
    server?.close();
  }
}

async function verifyAccess(
  oauth,
  accessToken,
  expectedUser,
  transport,
  { requestedScopes = [], allowScopeUpgrade = false } = {},
) {
  let info;
  try {
    info = await oauth.getTokenInfo(accessToken);
  } catch {
    throw new Error('OAuth token verification failed; existing grant preserved');
  }
  if (!Array.isArray(info?.scopes) || !info.scopes.every((scope) => typeof scope === 'string'))
    throw new Error('OAuth token verification returned malformed scopes; existing grant preserved');
  // A grant lacking the requested Gmail scope may need expanded consent. Its
  // replacement still must pass account verification before the saved grant changes.
  if (
    allowScopeUpgrade &&
    !info.scopes.includes('https://www.googleapis.com/auth/gmail.modify') &&
    requestedScopes.some((scope) => !info.scopes.includes(scope))
  )
    return info.scopes;
  let account;
  try {
    const profile = await transport('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!profile.ok) throw new Error();
    account = await profile.json();
  } catch {
    throw new Error('Google Gmail account verification failed; existing grant preserved');
  }
  if (
    typeof account?.emailAddress !== 'string' ||
    account.emailAddress.toLowerCase() !== expectedUser.toLowerCase()
  )
    throw new Error('Google account does not match expected test user; existing grant preserved');
  return info.scopes;
}

/** Injectable operations support offline tests; runtime endpoints remain fixed. */
export async function runOAuth({
  argv = process.argv.slice(2),
  load = loadLocalOAuth,
  createOAuth = (...args) => new OAuth2Client(...args),
  transport = fetch,
  authorize = browserConsent,
  save = writePrivateJson,
  log = console.log,
} = {}) {
  const requestedScopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    ...(argv.includes('--drive') ? ['https://www.googleapis.com/auth/drive.file'] : []),
  ];
  const context = await load({ requireToken: false });
  const { credentials, client, grant, tokenFile, privateTokenDirectory } = context;
  const config = client.installed;
  const oauth = createOAuth(config.client_id, config.client_secret);
  if (grant && !argv.includes('--reauth')) {
    oauth.setCredentials({ refresh_token: grant.refreshToken });
    let accessToken;
    try {
      const refreshed = await oauth.refreshAccessToken();
      accessToken = refreshed.credentials?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) throw new Error();
    } catch (error) {
      if (error.response?.status !== 400 || error.response?.data?.error !== 'invalid_grant')
        throw new Error(
          'OAuth refresh failed without confirming an invalid grant; existing grant preserved',
        );
    }
    if (accessToken) {
      const scopes = await verifyAccess(
        oauth,
        accessToken,
        credentials.GOOGLE_TEST_USER,
        transport,
        { requestedScopes, allowScopeUpgrade: true },
      );
      if (requestedScopes.every((scope) => scopes.includes(scope))) {
        log('Verified existing test OAuth grant; no browser consent needed');
        return { status: 'refreshed' };
      }
    }
  }
  let tokens;
  try {
    tokens = await authorize({ credentials, config, requestedScopes, argv, createOAuth });
  } catch (error) {
    // The built-in consent operation reports sanitized callback/browser errors.
    if (authorize === browserConsent) throw error;
    throw new Error('OAuth consent or code exchange failed; existing grant preserved');
  }
  if (
    typeof tokens?.refresh_token !== 'string' ||
    !tokens.refresh_token ||
    typeof tokens.access_token !== 'string' ||
    !tokens.access_token
  )
    throw new Error('Google did not issue an offline refresh grant; existing grant preserved');
  const scopes = await verifyAccess(
    oauth,
    tokens.access_token,
    credentials.GOOGLE_TEST_USER,
    transport,
  );
  if (!requestedScopes.every((scope) => scopes.includes(scope)))
    throw new Error(
      'Google consent did not grant all requested test scopes; existing grant preserved',
    );
  try {
    await save(
      tokenFile,
      {
        user: credentials.GOOGLE_TEST_USER,
        clientId: config.client_id,
        refreshToken: tokens.refresh_token,
        scopes: scopes.join(' '),
        createdAt: new Date().toISOString(),
      },
      { privateDirectory: privateTokenDirectory },
    );
  } catch {
    throw new Error('OAuth grant installation failed; existing grant preserved');
  }
  log(
    'Verified test mailbox and saved private OAuth refresh grant. Run just github-secrets to update CI credentials.',
  );
  return { status: 'authorized' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runOAuth();
  } catch (error) {
    console.error(
      /^(Google |OAuth |Missing |Automated )/.test(error.message)
        ? error.message
        : 'OAuth setup failed; no credentials were logged',
    );
    process.exitCode = 1;
  }
}
