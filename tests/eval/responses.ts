import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const RESPONSES_RUNNER_VERSION = 'responses-loop-2';
const FILE_LIMIT = 1_048_576;
type Event = Record<string, any>;
type FunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: any;
  strict: false;
};
const object = (value: unknown): value is Event =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function parseResponsesTranscript(text: string, exitCode: number | null, timedOut = false) {
  const native: Event[] = [];
  const errors: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!object(event)) throw new Error();
      native.push(event);
    } catch {
      errors.push(`Malformed Responses JSON at line ${index + 1}`);
    }
  }
  const results = native.filter((event) => event.type === 'responses.result');
  if (results.length !== 1 || results[0]?.status !== 'success')
    errors.push('Expected one successful Responses result');
  if (exitCode !== 0) errors.push(`Responses process exit ${exitCode}`);
  if (timedOut) errors.push('Responses process exceeded wall deadline');
  return { native, transcript: { valid: errors.length === 0, errors } };
}

export function summarizeResponsesUsage(native: unknown[], requestedModel: string) {
  const responses = native
    .filter(object)
    .filter((event) => event.type === 'responses.response')
    .map((event) => event.response)
    .filter(object);
  const sum = (field: (response: Event) => unknown) => {
    const values = responses.map((response) => counter(field(response)));
    return values.length && values.every((value) => value !== null)
      ? values.reduce<number>((total, value) => total + value!, 0)
      : null;
  };
  return {
    requestedModel,
    observedModels: [
      ...new Set(
        responses.map((response) => response.model).filter((model) => typeof model === 'string'),
      ),
    ],
    totalsSource: responses.length ? 'terminal_responses_usage' : 'unknown',
    totals: {
      inputTokens: sum((response) => response.usage?.input_tokens),
      outputTokens: sum((response) => response.usage?.output_tokens),
      cacheReadInputTokens: sum((response) => response.usage?.input_tokens_details?.cached_tokens),
      cacheCreationInputTokens: null,
      reasoningOutputTokens: sum(
        (response) => response.usage?.output_tokens_details?.reasoning_tokens,
      ),
    },
    responses: responses.map((response) => ({
      id: response.id ?? null,
      model: response.model ?? null,
      usage: response.usage ?? null,
    })),
    nativeResults: [],
    providerBilledCostUsd: null,
  };
}

/** No shell, imports, URLs, symlinks, or arbitrary filesystem capabilities are exposed to the model. */
export async function createWorkspaceFiles(workspace: string) {
  const root = await realpath(workspace);
  if (root !== resolve(workspace) || (await lstat(root)).isSymbolicLink())
    throw new Error('Workspace must be a real directory');
  const read = new Set<string>();
  async function pathFor(value: unknown, createParents: boolean) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
      throw new Error('file_path must be an absolute workspace path');
    const path = resolve(value);
    const suffix = relative(root, path);
    if (!suffix || suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix))
      throw new Error('File access outside workspace denied');
    const names = suffix.split('/');
    let cursor = root;
    for (const name of names.slice(0, -1)) {
      cursor = join(cursor, name);
      try {
        const info = await lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Workspace symlink or non-directory denied');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createParents) throw error;
        await mkdir(cursor, { mode: 0o700 });
      }
    }
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error('Linked or non-file output denied');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
  return {
    async Read(args: Event) {
      if (Object.keys(args).some((key) => key !== 'file_path'))
        throw new Error('Unsupported Read argument');
      const path = await pathFor(args.file_path, false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > FILE_LIMIT)
          throw new Error('Read exceeds bounded file contract');
        const bytes = await handle.readFile();
        if (bytes.length > FILE_LIMIT) throw new Error('Read exceeds file limit');
        read.add(path);
        return { file_path: path, content: bytes.toString('utf8'), bytes: bytes.length };
      } finally {
        await handle.close();
      }
    },
    async Write(args: Event) {
      if (
        Object.keys(args).some((key) => !['file_path', 'content'].includes(key)) ||
        typeof args.content !== 'string'
      )
        throw new Error('Write requires file_path and UTF-8 content');
      const bytes = Buffer.from(args.content, 'utf8');
      if (bytes.length > FILE_LIMIT) throw new Error('Write exceeds file limit');
      const path = await pathFor(args.file_path, true);
      let exists = false;
      try {
        await lstat(path);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (exists && !read.has(path)) throw new Error('Read an existing file before overwriting it');
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          (exists ? 0 : constants.O_EXCL),
        0o600,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) throw new Error('Linked or non-file output denied');
        await handle.truncate(0);
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return { file_path: path, bytes: bytes.length };
    },
  };
}

const hostTools: FunctionTool[] = [
  {
    type: 'function',
    name: 'ListMcpResourcesTool',
    description:
      'List available resources from the connected MCP server. Resource entries include the server name.',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: 'Optional server name' } },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'ReadMcpResourceTool',
    description: 'Read a resource from an MCP server by its server name and URI.',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string' }, uri: { type: 'string' } },
      required: ['server', 'uri'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'Read',
    description:
      'Read a UTF-8 file in the current workspace. file_path must be absolute. Maximum one MiB; directory and linked-file access is rejected.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'Write',
    description:
      'Write exact UTF-8 content to an absolute file_path in the current workspace. New parent directories are created. Read existing files before overwriting. Maximum one MiB.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    strict: false,
  },
];

export function parseResponsesBody(text: string, contentType: string | null) {
  if (!contentType?.includes('text/event-stream')) return JSON.parse(text);
  const events = text
    .replaceAll('\r\n', '\n')
    .split('\n\n')
    .flatMap((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') return [];
      return [JSON.parse(data)];
    });
  if (
    events.some((event) => ['error', 'response.failed', 'response.incomplete'].includes(event.type))
  )
    throw new Error('Responses stream failed or incomplete');
  const terminal = events.filter((event) => event.type === 'response.completed');
  if (terminal.length !== 1)
    throw new Error('Responses stream lacks one complete terminal response');
  return terminal[0].response;
}

export async function runResponsesLoop(options: {
  model: string;
  mcpUrl: string;
  proxyUrl: string;
  workspace: string;
  systemPrompt: string;
  prompt: string;
  emit?: (event: Event) => void;
}) {
  const emit = options.emit ?? ((event) => process.stdout.write(JSON.stringify(event) + '\n'));
  const client = new Client(
    { name: 'google-codemode-eval-responses', version: RESPONSES_RUNNER_VERSION },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const mcpUrl = new URL(options.mcpUrl);
  const proxyUrl = new URL(options.proxyUrl);
  for (const url of [mcpUrl, proxyUrl])
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('Runner endpoints must be credential-free loopback HTTP');
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(90_000),
        ]),
      }),
  });
  try {
    const files = await createWorkspaceFiles(options.workspace);
    await client.connect(transport);
    const listed = await client.listTools();
    if (listed.nextCursor)
      throw new Error('Paginated tool catalog unsupported by this small runner');
    const resources = await client.listResources();
    // Expose the server's instructions and resource descriptors as a host would,
    // without reading skills or performing model-requested discovery on its behalf.
    const mcpContext = {
      server: 'google',
      instructions: client.getInstructions() ?? null,
      resources: resources.resources.map((resource) => ({ ...resource, server: 'google' })),
    };
    const instructions = `${options.systemPrompt}\n\n# MCP server context\n${JSON.stringify(mcpContext)}`;
    const names = new Map(listed.tools.map((tool) => [`mcp__google__${tool.name}`, tool.name]));
    if (
      names.size !== listed.tools.length ||
      [...names.keys()].some((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    )
      throw new Error('Invalid or duplicate MCP tool names');
    const tools: FunctionTool[] = [
      ...hostTools,
      ...listed.tools.map((tool) => ({
        type: 'function' as const,
        name: `mcp__google__${tool.name}`,
        description: tool.description ?? tool.name,
        parameters: structuredClone(tool.inputSchema),
        strict: false as const,
      })),
    ];
    emit({
      type: 'responses.start',
      runnerVersion: RESPONSES_RUNNER_VERSION,
      model: options.model,
      tools: tools.map((tool) => tool.name),
      mcpContext,
    });
    const input: Event[] = [{ role: 'user', content: options.prompt }];
    const seenCalls = new Set<string>();
    for (let turn = 1; turn <= 18; turn++) {
      const response = await fetch(proxyUrl.href.replace(/\/$/, '') + '/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-eval-relay' },
        redirect: 'error',
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          model: options.model,
          instructions,
          tools,
          input,
          store: false,
          include: ['reasoning.encrypted_content'],
          stream: false,
          parallel_tool_calls: false,
          max_output_tokens: 2048,
          reasoning: { effort: 'low' },
          prompt_cache_key: 'google-codemode-gmail-v1',
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error('Responses request rejected; no retry');
      const result = parseResponsesBody(body, response.headers.get('content-type'));
      if (
        !object(result) ||
        result.status !== 'completed' ||
        result.model !== options.model ||
        !Array.isArray(result.output)
      )
        throw new Error('Responses result incomplete, malformed or model identity mismatched');
      emit({ type: 'responses.response', turn, response: result });
      // Validate the complete turn before executing any model-requested effects.
      for (const item of result.output)
        if (!object(item) || !['reasoning', 'message', 'function_call'].includes(item.type))
          throw new Error('Unsupported Responses output/tool type');
      const calls = result.output.filter((item: Event) => item.type === 'function_call');
      for (const call of calls) {
        if (
          typeof call.call_id !== 'string' ||
          !call.call_id ||
          seenCalls.has(call.call_id) ||
          typeof call.name !== 'string' ||
          !tools.some((tool) => tool.name === call.name) ||
          typeof call.arguments !== 'string'
        )
          throw new Error('Unknown, repeated or malformed function call');
        seenCalls.add(call.call_id);
      }
      input.push(...structuredClone(result.output));
      if (!calls.length) {
        emit({
          type: 'responses.result',
          status: 'success',
          turns: turn,
          runnerVersion: RESPONSES_RUNNER_VERSION,
        });
        return;
      }
      for (const call of calls) {
        let output: unknown;
        try {
          const args = JSON.parse(call.arguments);
          if (!object(args)) throw new Error('Tool arguments must be an object');
          if (names.has(call.name))
            output = await client.callTool({ name: names.get(call.name)!, arguments: args });
          else if (call.name === 'Read') output = await files.Read(args);
          else if (call.name === 'Write') output = await files.Write(args);
          else if (call.name === 'ListMcpResourcesTool') {
            if (
              Object.keys(args).some((key) => key !== 'server') ||
              (args.server !== undefined && args.server !== 'google')
            )
              throw new Error('Unknown MCP server');
            const result = await client.listResources();
            output = {
              ...result,
              resources: result.resources.map((resource) => ({ ...resource, server: 'google' })),
            };
          } else {
            if (
              args.server !== 'google' ||
              typeof args.uri !== 'string' ||
              Object.keys(args).some((key) => !['server', 'uri'].includes(key))
            )
              throw new Error('Invalid MCP resource request');
            output = await client.readResource({ uri: args.uri });
          }
        } catch (error) {
          output = { isError: true, error: error instanceof Error ? error.message : 'Tool failed' };
        }
        emit({ type: 'responses.tool', turn, name: call.name, callId: call.call_id, output });
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(output),
        });
      }
    }
    throw new Error('Responses turn ceiling reached');
  } catch (error) {
    emit({
      type: 'responses.result',
      status: 'error',
      error: error instanceof Error ? error.message : 'Responses runner failed',
      runnerVersion: RESPONSES_RUNNER_VERSION,
    });
    throw error;
  } finally {
    await client.close();
  }
}

if (process.argv[2] === '--responses-runner') {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    const options = JSON.parse(process.argv[3] ?? '{}');
    await runResponsesLoop({
      ...options,
      workspace: process.cwd(),
      prompt: Buffer.concat(chunks).toString('utf8'),
    });
  } catch {
    process.exitCode = 1;
  }
}
