import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localCredentials } from '../secrets.mjs';
import { getCellByModel, selectCells } from './matrix.ts';

// flock is held by a subprocess until release; the kernel also releases it if
// this launcher exits unexpectedly. The pathname is shared across checkouts.
export async function acquireLocalEvalLock(path = '/tmp/google-codemode-mcp-eval.lock') {
  const holder = spawn(
    'flock',
    [
      '--no-fork',
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      '73',
      path,
      process.execPath,
      '-e',
      "process.stdout.write('locked\\n'); process.stdin.resume();",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  holder.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolveExit, reject) => {
    holder.on('error', reject);
    holder.on('exit', (code) => resolveExit(code));
  });
  await Promise.race([
    new Promise((resolveReady) => holder.stdout.once('data', resolveReady)),
    finished.then((code) => {
      throw new Error(
        code === 73
          ? 'Another local agent evaluation holds the dummy-account/actor lock; no evaluation started'
          : `Cannot acquire local evaluation lock (${code}): ${stderr.trim()}`,
      );
    }),
  ]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    holder.stdin.end();
    await finished;
  };
}

export async function retainCandidateSource(destination) {
  const list = spawnSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.github/eval',
      '.github/tests/eval-*.test.ts',
      '.github/workflows/evaluate.yml',
      '.github/worker-client.ts',
      '.github/run.mjs',
      '.github/secrets.mjs',
      'src',
      'skills',
      'package.json',
      'package-lock.json',
      'wrangler.jsonc',
      'snippets.config.ts',
      'tsconfig.json',
      'justfile',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (list.status !== 0) throw new Error('Cannot enumerate candidate source');
  const manifest = {};
  for (const file of [...new Set(list.stdout.split('\0').filter(Boolean))].sort()) {
    const bytes = await readFile(file);
    const target = join(destination, 'candidate-source', file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    manifest[file] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(
    join(destination, 'candidate-source.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 },
  );
  return manifest;
}

async function main() {
  const {
    profile,
    model,
    proxy_url: proxy,
    output,
    repeats = '1',
    selection,
    cases,
    preflight_only,
  } = process.env;
  if (
    !profile ||
    (!model && !selection) ||
    (model && selection) ||
    !proxy ||
    !output ||
    !['1', '2'].includes(repeats)
  )
    throw new Error('Use just eval PROFILE MODEL PROXY_URL NEW_ABSOLUTE_OUTPUT [1|2]');
  if (selection) {
    selectCells(selection);
    if (repeats !== '1') throw new Error('Matrix uses one attempt per selected cell');
  } else getCellByModel(model);
  if (cases) {
    if (profile === 'gmail') {
      const { selectGmailCases } = await import('./cases.ts');
      selectGmailCases(cases);
    } else if (profile === 'drive') {
      const { selectDriveCases } = await import('./drive.ts');
      selectDriveCases(cases);
    }
    if (!selection) throw new Error('Case suites require a model selection');
  }
  if (!['gmail', 'drive'].includes(profile))
    throw new Error(
      'Coverage unavailable: Gmail and Drive implemented; Sheets, Docs, Calendar remain pending',
    );
  if (!isAbsolute(output)) throw new Error('Output must be an absolute path outside the checkout');
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  const destination = join(parent, output.split('/').at(-1));
  const checkout = await realpath(process.cwd());
  if (!relative(checkout, destination).startsWith('..'))
    throw new Error('Evidence must be outside the checkout');
  const releaseLock = await acquireLocalEvalLock();
  let directory;
  try {
    await mkdir(destination, { mode: 0o700 });
    directory = await mkdtemp(join(tmpdir(), 'codemode-agent-act-'));
    const key =
      preflight_only === 'true'
        ? ''
        : (process.env.CPA_CLIENT_API_KEY ??
          (await readFile(join(homedir(), '.config/cpa-manager-plus/client-key'), 'utf8')).trim());
    if (!key && preflight_only !== 'true') throw new Error('Missing CPA_CLIENT_API_KEY');
    const credentials =
      preflight_only === 'true' ? {} : { ...(await localCredentials()), CPA_CLIENT_API_KEY: key };
    const secrets = join(directory, 'secrets');
    const empty = join(directory, 'empty');
    await writeFile(empty, '', { mode: 0o600 });
    await writeFile(
      secrets,
      Object.entries(credentials)
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join('\n'),
      { mode: 0o600 },
    );
    const patch = await new Promise((resolve, reject) => {
      const child = spawn('git', ['diff', 'HEAD', '--binary'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let data = '';
      child.stdout.on('data', (chunk) => {
        data += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve(data) : reject(new Error('Cannot retain source diff')),
      );
    });
    await writeFile(join(destination, 'source.patch'), patch);
    await retainCandidateSource(destination);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const child = spawn(
      'act',
      [
        'workflow_dispatch',
        '-W',
        '.github/workflows/evaluate.yml',
        '-j',
        'evaluate',
        '--use-gitignore=true',
        '--env-file',
        empty,
        '--secret-file',
        secrets,
        '--network',
        'host',
        '--container-daemon-socket',
        '-',
        '--container-options',
        `--volume ${quote(`${destination}:/eval-evidence`)}`,
        '--env',
        `EVAL_OWNER_UID=${process.getuid()}`,
        '--env',
        `EVAL_OWNER_GID=${process.getgid()}`,
        '--input',
        `profile=${profile}`,
        '--input',
        selection ? `selection=${selection}` : `model=${model}`,
        '--input',
        `cases=${cases ?? ''}`,
        '--input',
        `proxy_url=${proxy}`,
        '--input',
        'output=/eval-evidence',
        '--input',
        `repeats=${repeats}`,
        '--input',
        `preflight_only=${preflight_only === 'true'}`,
        '-P',
        'ubuntu-latest=catthehacker/ubuntu:act-latest',
      ],
      { stdio: 'inherit', env: process.env },
    );
    const forward = (signal) => child.kill(signal);
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    }
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      await releaseLock();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
