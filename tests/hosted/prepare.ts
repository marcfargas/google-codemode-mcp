import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../', import.meta.url).href);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Prepare exact retained deploy bytes without authenticating or publishing. */
export async function prepareHosted(
  output: string,
  mode: 'probes' | 'product' = 'probes',
  options: { artifactBucket?: string } = { artifactBucket: process.env.ARTIFACTS_BUCKET },
) {
  if (!['probes', 'product'].includes(mode))
    throw new Error('Select probes or product preparation');
  const artifactBucket = options.artifactBucket;
  if (
    artifactBucket !== undefined &&
    (mode !== 'product' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(artifactBucket))
  )
    throw new Error(
      'Artifact storage requires product preparation and a valid private bucket name',
    );
  const relativeOutput = relative(checkout, output);
  if (!isAbsolute(output) || !(relativeOutput === '..' || relativeOutput.startsWith('../')))
    throw new Error('Use a new absolute evidence directory outside the checkout');
  await mkdir(output, { mode: 0o700 });
  const sourcePaths = [
    'package.json',
    'package-lock.json',
    'snippets.config.ts',
    'wrangler.jsonc',
    'skills/google-workspace/SKILL.md',
    'skills/google-workspace/references/media-transfers.md',
    'skills/google-workspace/references/artifacts.md',
    'tests/hosted/wrangler.json',
  ];
  for (const directory of ['src', 'tests/hosted'])
    for (const file of await readdir(join(checkout, directory)))
      if (file.endsWith('.ts')) sourcePaths.push(`${directory}/${file}`);
  const sourceFiles: Record<string, string> = {};
  for (const path of sourcePaths.sort())
    sourceFiles[path] = hash(await readFile(join(checkout, path)));
  const effectiveStorage = artifactBucket ? { artifactBucket } : {};
  const sourceDigest = hash(JSON.stringify({ mode, sourceFiles, ...effectiveStorage }));
  const result = spawnSync(
    join(checkout, 'node_modules/.bin/wrangler'),
    [
      'deploy',
      join(checkout, `tests/hosted/${mode === 'product' ? 'product' : 'worker'}.ts`),
      '--dry-run',
      '--config',
      join(checkout, 'tests/hosted/wrangler.json'),
      '--outdir',
      output,
    ],
    { cwd: checkout, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  await writeFile(join(output, 'prepare.log'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.error || result.status !== 0)
    throw new Error('Verification bundle preparation failed; inspect retained prepare.log');
  const bundle = await readFile(join(output, mode === 'product' ? 'product.js' : 'worker.js'));
  if (mode === 'product') await writeFile(join(output, 'worker.js'), bundle, { mode: 0o600 });
  const config = JSON.parse(await readFile(join(checkout, 'tests/hosted/wrangler.json'), 'utf8'));
  delete config.$schema;
  const deployment = {
    ...config,
    main: join(output, 'worker.js'),
    no_bundle: true,
    vars: { CANDIDATE_DIGEST: sourceDigest },
    ...(artifactBucket
      ? { r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: artifactBucket }] }
      : {}),
  };
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: checkout,
    encoding: 'utf8',
  }).stdout.trim();
  const manifest = {
    harnessVersion: 1,
    mode,
    sourceDigest,
    sourceFiles,
    bundleSha256: hash(bundle),
    revision,
    preparedAt: new Date().toISOString(),
    hostedExecution: false,
    ...effectiveStorage,
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
  prepareHosted(process.argv[2] ?? '', (process.argv[3] ?? 'probes') as 'probes' | 'product')
    .then((manifest) => console.log(`Prepared ${manifest.sourceDigest}; no deployment performed`))
    .catch(() => {
      console.error(
        'Hosted verification preparation failed; inspect retained evidence and prerequisites',
      );
      process.exitCode = 1;
    });
}
