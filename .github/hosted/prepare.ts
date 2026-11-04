import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../', import.meta.url).href);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Prepare exact retained deploy bytes without authenticating or publishing. */
export async function prepareHosted(output: string) {
  const relativeOutput = relative(checkout, output);
  if (!isAbsolute(output) || !(relativeOutput === '..' || relativeOutput.startsWith('../')))
    throw new Error('Use a new absolute evidence directory outside the checkout');
  await mkdir(output, { mode: 0o700 });
  const sourcePaths = ['package-lock.json', '.github/hosted/wrangler.json'];
  for (const directory of ['src', '.github/hosted'])
    for (const file of await readdir(join(checkout, directory)))
      if (file.endsWith('.ts')) sourcePaths.push(`${directory}/${file}`);
  const sourceFiles: Record<string, string> = {};
  for (const path of sourcePaths.sort())
    sourceFiles[path] = hash(await readFile(join(checkout, path)));
  const sourceDigest = hash(JSON.stringify(sourceFiles));
  const result = spawnSync(
    join(checkout, 'node_modules/.bin/wrangler'),
    [
      'deploy',
      '--dry-run',
      '--config',
      join(checkout, '.github/hosted/wrangler.json'),
      '--outdir',
      output,
    ],
    { cwd: checkout, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  await writeFile(join(output, 'prepare.log'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.error || result.status !== 0)
    throw new Error('Verification bundle preparation failed; inspect retained prepare.log');
  const bundle = await readFile(join(output, 'worker.js'));
  const config = JSON.parse(await readFile(join(checkout, '.github/hosted/wrangler.json'), 'utf8'));
  delete config.$schema;
  const deployment = {
    ...config,
    main: join(output, 'worker.js'),
    no_bundle: true,
    vars: { CANDIDATE_DIGEST: sourceDigest },
  };
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: checkout,
    encoding: 'utf8',
  }).stdout.trim();
  const manifest = {
    harnessVersion: 1,
    sourceDigest,
    sourceFiles,
    bundleSha256: hash(bundle),
    revision,
    preparedAt: new Date().toISOString(),
    hostedExecution: false,
  };
  await writeFile(join(output, 'wrangler.json'), JSON.stringify(deployment, null, 2) + '\n', {
    mode: 0o600,
  });
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  });
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareHosted(process.argv[2] ?? '')
    .then((manifest) => console.log(`Prepared ${manifest.sourceDigest}; no deployment performed`))
    .catch(() => {
      console.error(
        'Hosted verification preparation failed; inspect retained evidence and prerequisites',
      );
      process.exitCode = 1;
    });
}
