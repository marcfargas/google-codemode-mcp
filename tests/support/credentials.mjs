import { readFile, writeFile, mkdir, chmod, rename, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const configDirectory = (home) => join(home, '.config/google-codemode-mcp');
export const defaultTokenFile = join(configDirectory(homedir()), 'test-oauth.json');
export const defaultClientFile = join(configDirectory(homedir()), 'test-oauth-client.json');
export const legacyClientFile = '/tmp/google-codemode-mcp-oauth-client.json';

/** Private temporary bytes become visible at the destination only when complete. */
export async function writePrivateJson(
  file,
  value,
  { privateDirectory = false, exclusive = false } = {},
) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (privateDirectory) await chmod(directory, 0o700);
  const temporary = join(directory, `.oauth-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(file, label, allowMissing = false) {
  let bytes;
  try {
    bytes = await readFile(file, 'utf8');
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return undefined;
    throw new Error(`OAuth ${label} unavailable; existing grant preserved`);
  }
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`OAuth ${label} is malformed; existing grant preserved`);
  }
}
function validateClient(client) {
  if (
    typeof client?.installed?.client_id !== 'string' ||
    !client.installed.client_id ||
    typeof client.installed.client_secret !== 'string' ||
    !client.installed.client_secret
  )
    throw new Error(
      'OAuth client must contain installed-app client_id and client_secret; existing grant preserved',
    );
}
function validateGrant(grant, client, user) {
  if (grant === undefined) return;
  if (
    typeof grant?.user !== 'string' ||
    grant.user !== user ||
    grant.clientId !== client.installed.client_id ||
    typeof grant.refreshToken !== 'string' ||
    !grant.refreshToken
  )
    throw new Error(
      'OAuth grant does not match the configured test account/client or is malformed; existing grant preserved',
    );
}

/** Options are an isolated filesystem seam for tests, never remote OAuth endpoints. */
export async function loadLocalOAuth({
  requireToken = true,
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  legacy = legacyClientFile,
} = {}) {
  let user;
  try {
    user = parseEnv(await readFile(join(cwd, '.test.env'), 'utf8')).GOOGLE_TEST_USER;
  } catch {
    throw new Error('Missing or unreadable local .test.env test-user configuration');
  }
  if (!user) throw new Error('Missing GOOGLE_TEST_USER in .test.env');
  const tokenFile = env.GOOGLE_TEST_TOKEN_FILE ?? join(configDirectory(home), 'test-oauth.json');
  if (!tokenFile) throw new Error('OAuth grant path is empty; existing grant preserved');
  const grant = await readJson(tokenFile, 'grant', !requireToken);
  const durableClient = join(configDirectory(home), 'test-oauth-client.json');
  const explicitClient = env.GOOGLE_OAUTH_CLIENT_FILE !== undefined;
  let client = await readJson(
    explicitClient ? env.GOOGLE_OAUTH_CLIENT_FILE : durableClient,
    'client registration',
    !explicitClient,
  );
  if (client === undefined) {
    client = await readJson(legacy, 'legacy client registration', true);
    if (client === undefined)
      throw new Error(
        'Missing OAuth client registration; restore the matching client file; existing grant preserved',
      );
    validateClient(client);
    validateGrant(grant, client, user);
    try {
      await writePrivateJson(durableClient, client, { privateDirectory: true, exclusive: true });
    } catch (error) {
      if (error.code !== 'EEXIST')
        throw new Error('OAuth client installation failed; existing grant preserved');
      client = await readJson(durableClient, 'client registration');
    }
  }
  validateClient(client);
  validateGrant(grant, client, user);
  return {
    client,
    grant,
    tokenFile,
    privateTokenDirectory: env.GOOGLE_TEST_TOKEN_FILE === undefined,
    credentials: {
      GOOGLE_TEST_USER: user,
      GOOGLE_OAUTH_CLIENT_JSON: JSON.stringify(client),
      ...(requireToken ? { GOOGLE_TEST_REFRESH_TOKEN: grant.refreshToken } : {}),
    },
  };
}

export async function localCredentials(options) {
  return (await loadLocalOAuth(options)).credentials;
}
