import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localCredentials } from '../apps/executor/tests/support/credentials.mjs';

export async function installGitHubSecrets(options) {
  const credentials = await localCredentials(options);
  for (const [name, value] of Object.entries(credentials)) {
    const result = spawnSync(
      'gh',
      ['secret', 'set', name, '--repo', 'marcfargas/google-codemode-mcp'],
      {
        input: value,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (result.status !== 0) throw new Error(`Cannot set GitHub secret ${name}`);
    console.log(`Configured repository secret ${name}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await installGitHubSecrets({ requireToken: !process.argv.includes('--client-only') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
