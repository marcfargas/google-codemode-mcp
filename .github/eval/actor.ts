import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import {
  parseResponsesTranscript,
  summarizeResponsesUsage,
  RESPONSES_RUNNER_VERSION,
} from './responses.ts';
import type { Runner } from './matrix.ts';

const ACTOR_UID = 61337;
const CLI_VERSION = '2.1.318';
const ACTOR_HOME = '/tmp/google-mcp-actor-home';
const ACTOR_WORKSPACE = '/tmp/google-mcp-actor';
const SYSTEM_PATH = `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
const WALL_MS = 300_000;
export const ACTOR_SYSTEM_PROMPT =
  'Complete the user task using the connected Google MCP server and files in your working directory. Discover available server capabilities and instructions. When a tool schema requires accessToken, use the literal placeholder injected-by-eval-caller; the trusted caller supplies authentication. You may read and write task files only within your working directory. Report actual outcomes and uncertainty.';

export function parseActorTranscript(
  text: string,
  exitCode: number | null,
  timedOut = false,
  runner: Runner = 'claude',
) {
  return runner === 'responses'
    ? parseResponsesTranscript(text, exitCode, timedOut)
    : parseTranscript(text, exitCode, timedOut);
}

export function summarizeActorUsage(
  native: unknown[],
  model: string,
  runner: Runner = 'claude',
): any {
  return runner === 'responses'
    ? summarizeResponsesUsage(native, model)
    : summarizeUsage(native, model);
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseTranscript(text: string, exitCode: number | null, timedOut = false) {
  const native: unknown[] = [];
  const errors: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      native.push(JSON.parse(line));
    } catch {
      errors.push(`Malformed native JSON at line ${index + 1}`);
    }
  }
  const results = native.map(object).filter((event) => event.type === 'result');
  if (results.length !== 1) errors.push(`Expected one native result; observed ${results.length}`);
  if (results.some((event) => event.is_error !== false || event.subtype !== 'success'))
    errors.push('Native result did not report success');
  if (exitCode !== 0) errors.push(`Native process exit ${exitCode}`);
  if (timedOut) errors.push('Native process exceeded wall deadline');
  return { native, transcript: { valid: errors.length === 0, errors } };
}

export function summarizeUsage(native: unknown[], requestedModel: string) {
  // Native result aggregates and assistant per-turn counters are separate evidence.
  // Never replace a missing counter with zero, or add aggregate and per-turn usage.
  const seen = new Map<string, ObjectValue>();
  const observedModels = new Set<string>();
  for (const value of native) {
    const event = object(value);
    const message = object(event.message);
    if (event.type !== 'assistant') continue;
    if (typeof message.model === 'string') observedModels.add(message.model);
    const usage = object(message.usage);
    const key = typeof message.id === 'string' ? message.id : `event-${seen.size}`;
    const previous = seen.get(key) ?? {};
    // Stream events can repeat a message id as blocks arrive. Preserve positive
    // counters if a later duplicate contains zero or omits a field.
    for (const field of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ]) {
      const current = counter(usage[field]);
      const prior = counter(previous[field]);
      if (current !== null) previous[field] = prior === null ? current : Math.max(prior, current);
    }
    previous.id = key;
    previous.model = message.model ?? previous.model ?? null;
    seen.set(key, previous);
  }
  const turns = [...seen.values()].map((usage) => ({
    id: usage.id,
    model: usage.model,
    inputTokens: counter(usage.input_tokens),
    outputTokens: counter(usage.output_tokens),
    cacheReadInputTokens: counter(usage.cache_read_input_tokens),
    cacheCreationInputTokens: counter(usage.cache_creation_input_tokens),
  }));
  const sum = (
    field: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens',
  ) =>
    turns.length && turns.every((turn) => turn[field] !== null)
      ? turns.reduce((total, turn) => total + (turn[field] as number), 0)
      : null;
  const results = native.map(object).filter((event) => event.type === 'result');
  for (const result of results)
    for (const model of Object.keys(object(result.modelUsage))) observedModels.add(model);
  return {
    requestedModel,
    observedModels: [...observedModels],
    turns,
    // Assistant stream messages can carry message_start counts rather than
    // terminal message_delta usage. Only the terminal native result is a total.
    totalsSource: results.length === 1 ? 'terminal_native_result' : 'unknown',
    totals: {
      inputTokens: counter(object(results.length === 1 ? results[0].usage : null).input_tokens),
      outputTokens: counter(object(results.length === 1 ? results[0].usage : null).output_tokens),
      cacheReadInputTokens: counter(
        object(results.length === 1 ? results[0].usage : null).cache_read_input_tokens,
      ),
      cacheCreationInputTokens: counter(
        object(results.length === 1 ? results[0].usage : null).cache_creation_input_tokens,
      ),
    },
    assistantObservations: {
      completeness: 'partial',
      sums: {
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cacheReadInputTokens: sum('cacheReadInputTokens'),
        cacheCreationInputTokens: sum('cacheCreationInputTokens'),
      },
    },
    nativeResults: results.map((result) => ({
      sessionId: result.session_id ?? null,
      usage: result.usage ?? null,
      modelUsage: result.modelUsage ?? null,
      cliEstimatedCostUsd: counter(result.total_cost_usd),
    })),
    providerBilledCostUsd: null,
  };
}

function minimalEnv(home = ACTOR_HOME): NodeJS.ProcessEnv {
  return {
    PATH: SYSTEM_PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'config'),
    TMPDIR: join(home, 'tmp'),
    LANG: 'C.UTF-8',
  };
}
function requireRoot() {
  if (process.getuid?.() !== 0)
    throw new Error('Actor isolation requires root; run the trusted harness with sudo -E node');
}
async function privateDirectory(path: string, uid: number) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Refusing non-directory ${path}`);
  await chown(path, uid, uid);
  await chmod(path, 0o700);
}

export async function probeIsolation(options: {
  workspace: string;
  protectedPaths: string[];
  output: string;
  parentPid?: number;
}) {
  requireRoot();
  const probePath = join(options.workspace, '.actor-isolation-probe');
  const script = `const fs=require('node:fs'); const paths=JSON.parse(process.argv[1]); const denied=paths.map(path=>{try{fs.readFileSync(path);return {path,denied:false}}catch(error){return {path,denied:error.code==='EACCES'||error.code==='EPERM',code:error.code}}}); let workspace=false;try{fs.writeFileSync(process.argv[2],'isolation');workspace=fs.readFileSync(process.argv[2],'utf8')==='isolation';fs.unlinkSync(process.argv[2])}catch{}; console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),workspace,denied}));`;
  const paths = [...options.protectedPaths, `/proc/${options.parentPid ?? process.pid}/environ`];
  const child = spawnSync(process.execPath, ['-e', script, JSON.stringify(paths), probePath], {
    cwd: options.workspace,
    uid: ACTOR_UID,
    gid: ACTOR_UID,
    env: minimalEnv(),
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (child.status !== 0)
    throw new Error(`Isolation probe failed: ${child.error?.message ?? child.stderr}`);
  const evidence = JSON.parse(child.stdout) as {
    uid: number;
    gid: number;
    groups: number[];
    workspace: boolean;
    denied: { path: string; denied: boolean }[];
  };
  await writeFile(join(options.output, 'isolation.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  if (
    evidence.uid !== ACTOR_UID ||
    evidence.gid !== ACTOR_UID ||
    evidence.groups.some((gid) => gid !== ACTOR_UID) ||
    !evidence.workspace ||
    evidence.denied.some((item) => !item.denied)
  )
    throw new Error('Actor OS isolation probe did not pass');
  return evidence;
}

export async function collectFiles(workspace: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new Error(`Unsupported actor output: ${relative}`);
      if (info.isDirectory()) await walk(path, `${relative}/`);
      else {
        if (info.nlink !== 1) throw new Error(`Refusing linked actor output: ${relative}`);
        bytes += info.size;
        if (bytes > 16 * 1024 * 1024 || Object.keys(files).length >= 100)
          throw new Error('Actor output exceeded retained file limit');
        files[relative] = (await readFile(path)).toString('base64');
      }
    }
  }
  await walk(workspace, '');
  return files;
}

async function nativeCli() {
  for (const directory of SYSTEM_PATH.split(':')) {
    const candidate = join(directory, 'claude');
    try {
      await access(candidate, constants.X_OK);
      const native = await realpath(candidate);
      const info = await lstat(native);
      if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || native.includes('cpa-clients'))
        continue;
      const version = spawnSync(candidate, ['--version'], {
        env: minimalEnv(),
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (version.status !== 0 || version.stdout.trim() !== `${CLI_VERSION} (Claude Code)`)
        throw new Error(`Expected native Claude ${CLI_VERSION}; observed ${version.stdout.trim()}`);
      return { executable: candidate, version: version.stdout.trim() };
    } catch (error) {
      if (object(error).code !== 'ENOENT' && object(error).code !== 'EACCES') throw error;
    }
  }
  throw new Error('Root-owned globally installed native Claude CLI not found on system PATH');
}
function loopbackUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('Actor relay URLs must be credential-free loopback HTTP');
  return url.href;
}

export function actorLaunchArguments(options: {
  model: string;
  mcpUrl: string;
  workspace: string;
}) {
  const { mcpUrl } = options;
  // In 2.1.318 --bare suppresses Write. Restricted mode enforces the cwd
  // boundary before these explicit allow rules; the native offline probe checks
  // both a successful workspace write and a denied outside write.
  return [
    '--restricted',
    '--print',
    '--model',
    options.model,
    '--effort',
    'low',
    '--max-turns',
    '18',
    '--max-budget-usd',
    '1',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { google: { type: 'http', url: mcpUrl } } }),
    '--permission-mode',
    'dontAsk',
    '--system-prompt',
    ACTOR_SYSTEM_PROMPT,
    '--tools',
    'Read,Write,ListMcpResourcesTool,ReadMcpResourceTool',
    '--allowedTools',
    'Read,Write,ListMcpResourcesTool,ReadMcpResourceTool,mcp__google__*',
    '--settings',
    JSON.stringify({
      permissions: {
        defaultMode: 'dontAsk',
        allow: ['Read', 'Write', 'mcp__google__*'],
        deny: ['Bash', 'Agent', 'Task', 'WebFetch', 'WebSearch'],
      },
    }),
  ];
}

interface ActorOptions {
  prompt: string;
  model: string;
  mcpUrl: string;
  proxyUrl: string;
  output: string;
  workspace?: string;
  runner?: Runner;
}

export async function runActor(options: ActorOptions) {
  requireRoot();
  let runtime: string | undefined;
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const originalCheckout = await lstat(checkout);
  try {
    if (options.runner === 'responses') {
      runtime = await mkdtemp(join(tmpdir(), 'google-mcp-responses-runtime-'));
      await chmod(runtime, 0o755);
      await build({
        entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'responses.ts')],
        outfile: join(runtime, 'runner.mjs'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
      });
      await chmod(join(runtime, 'runner.mjs'), 0o644);
    }
    return await runIsolatedActor(options, runtime);
  } finally {
    try {
      if (runtime) await rm(runtime, { recursive: true, force: true });
    } finally {
      await chown(checkout, originalCheckout.uid, originalCheckout.gid);
      await chmod(checkout, originalCheckout.mode & 0o7777);
    }
  }
}

async function runIsolatedActor(options: ActorOptions, runtime?: string) {
  requireRoot();
  if (!options.model.trim()) throw new Error('An explicit actor model is required');
  const output = resolve(options.output);
  const workspace = options.workspace ?? ACTOR_WORKSPACE;
  if (!isAbsolute(options.output) || workspace !== ACTOR_WORKSPACE)
    throw new Error('Use an absolute output and the fixed actor workspace');
  if (
    output === workspace ||
    output.startsWith(`${workspace}/`) ||
    output === ACTOR_HOME ||
    output.startsWith(`${ACTOR_HOME}/`)
  )
    throw new Error('Evidence must be outside actor directories');
  const proxyUrl = loopbackUrl(options.proxyUrl);
  const mcpUrl = loopbackUrl(options.mcpUrl);
  await privateDirectory(output, 0);
  await rm(workspace, { recursive: true, force: true });
  await rm(ACTOR_HOME, { recursive: true, force: true });
  await privateDirectory(workspace, ACTOR_UID);
  await privateDirectory(ACTOR_HOME, ACTOR_UID);
  await privateDirectory(join(ACTOR_HOME, 'config'), ACTOR_UID);
  await privateDirectory(join(ACTOR_HOME, 'tmp'), ACTOR_UID);
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  await chown(checkout, 0, 0);
  await chmod(checkout, 0o700);
  const canary = join(output, 'protected-isolation-canary');
  await writeFile(canary, 'synthetic protected canary', { mode: 0o600 });
  const isolation = await probeIsolation({
    workspace,
    protectedPaths: [fileURLToPath(import.meta.url), canary],
    output,
  });
  const runner = options.runner ?? 'claude';
  const cli =
    runner === 'claude'
      ? await nativeCli()
      : { executable: process.execPath, version: RESPONSES_RUNNER_VERSION };
  const args =
    runner === 'claude'
      ? actorLaunchArguments({ model: options.model, mcpUrl, workspace })
      : [
          join(runtime!, 'runner.mjs'),
          '--responses-runner',
          JSON.stringify({
            model: options.model,
            mcpUrl,
            proxyUrl,
            systemPrompt: `${ACTOR_SYSTEM_PROMPT}\nWorking directory: ${workspace}.`,
          }),
        ];
  const env =
    runner === 'claude'
      ? {
          ...minimalEnv(),
          ANTHROPIC_API_KEY: 'local-eval-relay',
          ANTHROPIC_BASE_URL: proxyUrl,
          MCP_PROTOCOL_NEGOTIATION: 'auto',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_MAX_RETRIES: '0',
          CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0',
        }
      : { ...minimalEnv() };
  await writeFile(join(output, 'prompt.txt'), options.prompt, { mode: 0o600 });
  await writeFile(
    join(output, 'launch.json'),
    JSON.stringify(
      {
        executable: cli.executable,
        cliVersion: cli.version,
        runner,
        runnerSha256: runtime
          ? (await import('node:crypto'))
              .createHash('sha256')
              .update(await readFile(join(runtime, 'runner.mjs')))
              .digest('hex')
          : null,
        args,
        cwd: workspace,
        uid: ACTOR_UID,
        gid: ACTOR_UID,
        environment: env,
        wallMs: WALL_MS,
        cliBudgetUsd: runner === 'claude' ? 1 : null,
        billingGuarantee: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const stdout = createWriteStream(join(output, 'performer.jsonl'), { mode: 0o600 });
  const stderr = createWriteStream(join(output, 'performer.stderr'), { mode: 0o600 });
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(cli.executable, args, {
      cwd: workspace,
      env,
      uid: ACTOR_UID,
      gid: ACTOR_UID,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdin.on('error', () => {});
    child.stdin.end(options.prompt);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch (error) {
        if (object(error).code !== 'ESRCH') throw error;
      }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 2_000);
    }, WALL_MS);
    child.on('error', (error) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      kill('SIGKILL');
      resolveExit(code);
    });
  });
  await Promise.all([
    new Promise<void>((done, fail) => {
      if (stdout.writableFinished) done();
      else stdout.on('finish', done).on('error', fail);
    }),
    new Promise<void>((done, fail) => {
      if (stderr.writableFinished) done();
      else stderr.on('finish', done).on('error', fail);
    }),
  ]);
  const parsed = parseActorTranscript(
    await readFile(join(output, 'performer.jsonl'), 'utf8'),
    exitCode,
    timedOut,
    runner,
  );
  const usage = summarizeActorUsage(parsed.native, options.model, runner);
  let files: Record<string, string> = {};
  try {
    files = await collectFiles(workspace);
  } catch (error) {
    parsed.transcript.valid = false;
    parsed.transcript.errors.push(
      error instanceof Error ? error.message : 'Actor file collection failed',
    );
  }
  const result = {
    exitCode,
    timedOut,
    files,
    ...parsed,
    usage,
    cliVersion: cli.version,
    runner,
    isolation,
  };
  await writeFile(join(output, 'actor-result.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  return result;
}
