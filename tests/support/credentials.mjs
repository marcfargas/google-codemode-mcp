import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultTokenFile = join(homedir(), '.config/google-codemode-mcp/test-oauth.json');
export const defaultClientFile = '/tmp/google-codemode-mcp-oauth-client.json';
export async function localCredentials({ requireToken = true } = {}) {
  const envFile = parseEnv(await readFile('.test.env', 'utf8'));
  const client = JSON.parse(
    await readFile(process.env.GOOGLE_OAUTH_CLIENT_FILE ?? defaultClientFile, 'utf8'),
  );
  if (!client.installed?.client_id || !client.installed?.client_secret)
    throw new Error('Expected installed-app OAuth client JSON');
  const credentials = {
    GOOGLE_TEST_USER: envFile.GOOGLE_TEST_USER,
    GOOGLE_OAUTH_CLIENT_JSON: JSON.stringify(client),
  };
  if (!credentials.GOOGLE_TEST_USER) throw new Error('Missing GOOGLE_TEST_USER in .test.env');
  if (requireToken) {
    let tokens;
    try {
      tokens = JSON.parse(
        await readFile(process.env.GOOGLE_TEST_TOKEN_FILE ?? defaultTokenFile, 'utf8'),
      );
    } catch {
      throw new Error('No local OAuth grant; run just oauth first');
    }
    if (
      tokens.user !== credentials.GOOGLE_TEST_USER ||
      tokens.clientId !== client.installed.client_id ||
      !tokens.refreshToken
    ) {
      throw new Error(
        'OAuth grant does not match the configured test account/client; run just oauth',
      );
    }
    credentials.GOOGLE_TEST_REFRESH_TOKEN = tokens.refreshToken;
  }
  return credentials;
}
