import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCredentials } from './secrets.mjs';

const target = process.argv[2] ?? 'check';
if (!['check', 'live'].includes(target)) throw new Error('Use check or live');
const directory = await mkdtemp(join(tmpdir(), 'google-codemode-act-'));
try {
  const empty = join(directory, 'empty');
  const secrets = join(directory, 'secrets');
  const event = join(directory, 'event.json');
  await writeFile(empty, '', { mode: 0o600 });
  const credentials = target === 'live' ? await localCredentials() : {};
  await writeFile(
    secrets,
    Object.entries(credentials)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join('\n'),
    { mode: 0o600 },
  );
  await writeFile(
    event,
    JSON.stringify({
      ref: 'refs/heads/main',
      repository: {
        default_branch: 'main',
        full_name: 'marcfargas/google-codemode-mcp',
        private: true,
      },
    }),
    { mode: 0o600 },
  );
  const artifacts = join(process.cwd(), 'dist', 'act-artifacts');
  if (target === 'live') await mkdir(artifacts, { recursive: true });
  const args = [
    target === 'live' ? 'workflow_dispatch' : 'push',
    '-W',
    `.github/workflows/${target}.yml`,
    '-j',
    target,
    '--use-gitignore=true',
    '--env-file',
    empty,
    '--secret-file',
    secrets,
    '--eventpath',
    event,
    '-P',
    'ubuntu-latest=catthehacker/ubuntu:act-latest',
    ...(target === 'live' ? ['--artifact-server-path', artifacts] : []),
    '--container-daemon-socket',
    '-',
  ];
  const child = spawn('act', args, { stdio: 'inherit', env: process.env });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = status;
} finally {
  await rm(directory, { recursive: true, force: true });
}
