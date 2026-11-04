import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('deployment CLI maps environment settings and preserves native credentials and Builds guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codemode-deploy-'));
  const executable = join(directory, 'node_modules', '.bin', 'wrangler');
  const helper = resolve('.github/deploy.mjs');
  try {
    await mkdir(join(directory, 'node_modules', '.bin'), { recursive: true });
    await writeFile(
      executable,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  args: process.argv.slice(2),
  account: process.env.CLOUDFLARE_ACCOUNT_ID,
  token: process.env.CLOUDFLARE_API_TOKEN,
  tag: process.env.WRANGLER_CI_MATCH_TAG,
  expectedName: process.env.WRANGLER_CI_OVERRIDE_NAME,
}));
process.exitCode = Number(process.env.DEPLOY_TEST_EXIT || 0);
`,
      { mode: 0o700 },
    );
    function invoke(values: Record<string, string> = {}, args: string[] = []) {
      return spawnSync(process.execPath, [helper, ...args], {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...values },
      });
    }
    const defaults = invoke();
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.deepEqual(JSON.parse(defaults.stdout).args, ['deploy']);

    const builds = invoke(
      {
        CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
        CLOUDFLARE_API_TOKEN: 'synthetic-deployment-token',
        WRANGLER_CI_MATCH_TAG: 'synthetic-worker-tag',
        WRANGLER_CI_OVERRIDE_NAME: 'builds-selected-worker',
        WORKER_DOMAIN: 'mcp.example.invalid',
      },
      ['--dry-run'],
    );
    assert.equal(builds.status, 0, builds.stderr);
    assert.deepEqual(JSON.parse(builds.stdout), {
      args: [
        'deploy',
        '--name',
        'builds-selected-worker',
        '--domain',
        'mcp.example.invalid',
        '--dry-run',
        '--outdir',
        'dist',
      ],
      account: 'synthetic-account',
      token: 'synthetic-deployment-token',
      tag: 'synthetic-worker-tag',
      expectedName: 'builds-selected-worker',
    });

    const routed = invoke({ WORKER_NAME: 'my-worker', WORKER_ROUTE: 'example.invalid/mcp*' });
    assert.equal(routed.status, 0, routed.stderr);
    assert.deepEqual(JSON.parse(routed.stdout).args, [
      'deploy',
      '--name',
      'my-worker',
      '--route',
      'example.invalid/mcp*',
    ]);
    assert.equal(invoke({ WORKER_NAME: 'same', WRANGLER_CI_OVERRIDE_NAME: 'same' }).status, 0);
    assert.equal(invoke({ DEPLOY_TEST_EXIT: '7' }).status, 7);

    for (const [values, args] of [
      [{ WORKER_NAME: 'wrong', WRANGLER_CI_OVERRIDE_NAME: 'selected' }, []],
      [{ WORKER_NAME: '--dry-run' }, []],
      [{ WORKER_NAME: 'name with spaces' }, []],
      [{ WORKER_DOMAIN: 'mcp.example.invalid', WORKER_ROUTE: 'example.invalid/*' }, []],
      ...[
        'https://mcp.example.invalid',
        'mcp.example.invalid/path',
        '*.example.invalid',
        'mcp.example.invalid:443',
        '-bad.example.invalid',
      ].map((domain) => [{ WORKER_DOMAIN: domain }, []]),
      [{ WORKER_ROUTE: '--route=value/' }, []],
      [{ WORKER_ROUTE: 'missing-path.example.invalid' }, []],
      [{}, ['--unknown']],
      [{}, ['--dry-run', '--dry-run']],
    ] as [Record<string, string>, string[]][]) {
      const refused = invoke(values, args);
      assert.notEqual(refused.status, 0);
      assert.equal(refused.stdout, '', 'Invalid input must fail before invoking Wrangler');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('README wire examples work against the pinned MCP handler', async () => {
  const { handleMcp } = await import('../../src/protocol.ts');
  const readme = await readFile('README.md', 'utf8');
  const listBody = readme.match(/--data-binary '(\{"jsonrpc"[^\n]+\})'/)?.[1];
  assert.ok(listBody, 'README tools/list curl body');
  const call = readme.match(/```http\nPOST \/mcp HTTP\/1\.1\n([\s\S]+?)\n```/)?.[1];
  assert.ok(call, 'README execute HTTP example');
  const [rawHeaders, callBody] = call.split('\n\n');
  let execution: unknown;
  const app = {
    snippets: [],
    describe: async () => ({}),
    execute: async (args: unknown) => {
      execution = args;
      return { status: 'completed', outcomes: [] };
    },
    runSnippet: async () => ({}),
  };
  const listed = await handleMcp(
    new Request('https://mcp.example.invalid/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'MCP-Method': 'tools/list',
      },
      body: listBody,
    }),
    app,
  );
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as any).result.tools[0].name, 'describe');
  const called = await handleMcp(
    new Request('https://mcp.example.invalid/mcp', {
      method: 'POST',
      headers: Object.fromEntries(
        rawHeaders.split('\n').map((line) => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator), line.slice(separator + 1).trim()];
        }),
      ),
      body: callBody,
    }),
    app,
  );
  assert.equal(called.status, 200);
  assert.equal(((await called.json()) as any).result.structuredContent.status, 'completed');
  assert.deepEqual(execution, JSON.parse(callBody).params.arguments);
});
