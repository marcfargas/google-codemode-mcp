import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCredentials } from './support/credentials.mjs';
import { acquireLocalEvalLock, retainCandidateSource } from './eval/act.mjs';

function gitOutput(args, purpose) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot retain ${purpose}`);
  return result.stdout;
}

const target = process.argv[2] ?? 'check';
if (!['check', 'live', 'live-drive'].includes(target))
  throw new Error('Use check, live, or live-drive');
const live = target.startsWith('live');
const release = live ? await acquireLocalEvalLock() : undefined;
const directory = await mkdtemp(join(tmpdir(), 'google-codemode-act-'));
try {
  const empty = join(directory, 'empty');
  const secrets = join(directory, 'secrets');
  const event = join(directory, 'event.json');
  await writeFile(empty, '', { mode: 0o600 });
  const credentials = live ? await localCredentials() : {};
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
  if (live) {
    const candidate = join(artifacts, `candidate-${randomUUID()}`);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const manifest = await retainCandidateSource(candidate);
    const head = gitOutput(['rev-parse', 'HEAD'], 'candidate Git HEAD').trim();
    // Restrict the diff to the same source allowlist; credentials are never evidence.
    const patch = gitOutput(
      ['diff', '--binary', 'HEAD', '--', ...Object.keys(manifest)],
      'candidate source diff',
    );
    await writeFile(join(candidate, 'source.patch'), patch, { mode: 0o600 });
    await writeFile(
      join(candidate, 'source.json'),
      JSON.stringify(
        {
          head,
          diffSha256: createHash('sha256').update(patch).digest('hex'),
          sourceManifestSha256: createHash('sha256')
            .update(await readFile(join(candidate, 'candidate-source.json')))
            .digest('hex'),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    console.log(`Local candidate source: ${candidate}`);
  }
  const args = [
    live ? 'workflow_dispatch' : 'push',
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
    ...(live ? ['--artifact-server-path', artifacts] : []),
    ...(process.env.ACT_NODE_OPTIONS !== undefined
      ? ['--env', `NODE_OPTIONS=${process.env.ACT_NODE_OPTIONS}`]
      : []),
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
  try {
    await rm(directory, { recursive: true, force: true });
  } finally {
    await release?.();
  }
}
