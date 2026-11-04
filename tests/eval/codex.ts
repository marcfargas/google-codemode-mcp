import { createHash } from 'node:crypto';

export const CODEX_CLI_VERSION = '0.166.0';
type Event = Record<string, any>;
const object = (value: unknown): value is Event =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Native host probe: its broader advertised surface is distinct from the Responses performer. */
export function codexConfiguration(options: {
  model: string;
  mcpUrl: string;
  proxyUrl: string;
  systemPrompt: string;
}) {
  const quote = (value: string) => JSON.stringify(value);
  return `model = ${quote(options.model)}
model_provider = "evaluation"
model_reasoning_effort = "low"
developer_instructions = ${quote(options.systemPrompt)}
approval_policy = "never"
sandbox_mode = "workspace-write"
project_doc_max_bytes = 0
web_search = "disabled"
[sandbox_workspace_write]
exclude_slash_tmp = true
exclude_tmpdir_env_var = true
[analytics]
enabled = false
[feedback]
enabled = false
[tools.update_plan]
enabled = false
[tools.experimental_request_user_input]
enabled = false
[features]
mcp_2026_07_28 = true
shell_tool = false
unified_exec = false
multi_agent = false
multi_agent_v2 = false
skill_search = false
skip_host_skill_discovery = true
tool_suggest = false
sleep_tool = false
memories = false
apps = false
browser_use = false
browser_use_external = false
in_app_browser = false
api_key_model_discovery = false
[model_providers.evaluation]
name = "Local evaluation relay"
base_url = ${quote(options.proxyUrl.replace(/\/$/, '') + '/v1')}
wire_api = "responses"
env_key = "CODEX_EVAL_RELAY_KEY"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
stream_idle_timeout_ms = 90000
[mcp_servers.google]
url = ${quote(options.mcpUrl)}
enabled_tools = ["describe", "execute"]
startup_timeout_sec = 10
tool_timeout_sec = 90
required = true
[mcp_servers.google.tools.execute]
approval_mode = "approve"
`;
}

export function codexLaunchArguments(workspace: string) {
  return [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    '-C',
    workspace,
    '-',
  ];
}

export function parseCodexTranscript(text: string, exitCode: number | null, timedOut = false) {
  const native: Event[] = [];
  const errors: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!object(event)) throw new Error();
      native.push(event);
    } catch {
      errors.push(`Malformed native Codex JSON at line ${index + 1}`);
    }
  }
  if (native.filter((event) => event.type === 'thread.started').length !== 1)
    errors.push('Expected one native Codex thread');
  if (native.filter((event) => event.type === 'turn.completed').length !== 1)
    errors.push('Expected one completed native Codex turn');
  if (native.some((event) => ['error', 'turn.failed'].includes(event.type)))
    errors.push('Native Codex reported a failed turn');
  if (
    !native.some(
      (event) =>
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string' &&
        event.item.text.trim(),
    )
  )
    errors.push('Native Codex final response missing');
  if (exitCode !== 0) errors.push(`Native Codex process exit ${exitCode}`);
  if (timedOut) errors.push('Native Codex process exceeded wall deadline');
  return { native, transcript: { valid: errors.length === 0, errors } };
}

export function summarizeCodexUsage(native: unknown[], requestedModel: string) {
  const completed = native.filter(object).filter((event) => event.type === 'turn.completed');
  const usage = completed.length === 1 && object(completed[0].usage) ? completed[0].usage : {};
  return {
    requestedModel,
    // The JSONL terminal contains no served-model identity. The trusted relay
    // separately verifies every upstream terminal; the requested ID is not proof.
    observedModels: [],
    modelIdentitySource: 'trusted_relay_required',
    totalsSource: completed.length === 1 ? 'terminal_native_codex_turn' : 'unknown',
    totals: {
      inputTokens: counter(usage.input_tokens),
      outputTokens: counter(usage.output_tokens),
      cacheReadInputTokens: counter(usage.cached_input_tokens),
      cacheCreationInputTokens: counter(usage.cache_write_input_tokens),
      reasoningOutputTokens: counter(usage.reasoning_output_tokens),
    },
    nativeResults: completed.map((event) => ({ usage: event.usage ?? null })),
    providerBilledCostUsd: null,
  };
}

function textParts(value: unknown) {
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        object(part) &&
        (['input_text', 'output_text'].includes(part.type)
          ? typeof part.text === 'string'
          : part.type === 'refusal' && typeof part.refusal === 'string'),
    )
  );
}
function reasoning(item: Event) {
  return (
    Array.isArray(item.summary) &&
    item.summary.every(
      (part: any) => object(part) && part.type === 'summary_text' && typeof part.text === 'string',
    ) &&
    (item.encrypted_content == null || typeof item.encrypted_content === 'string')
  );
}
const collaborationTools = new Set([
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'spawn_agent',
  'wait_agent',
]);

function declarations(item: Event) {
  if (item.role !== 'developer' || !Array.isArray(item.tools) || !item.tools.length) return false;
  const names = new Set<string>();
  return item.tools.every((namespace: any) => {
    if (
      !object(namespace) ||
      namespace.type !== 'namespace' ||
      !['functions', 'collaboration'].includes(namespace.name) ||
      !Array.isArray(namespace.tools)
    )
      return false;
    return namespace.tools.every((tool: any) => {
      if (!object(tool) || typeof tool.name !== 'string') return false;
      const name = `${namespace.name}.${tool.name}`;
      if (names.has(name)) return false;
      names.add(name);
      return namespace.name === 'functions'
        ? (tool.name === 'exec' && tool.type === 'custom') ||
            (tool.name === 'wait' && tool.type === 'function')
        : collaborationTools.has(tool.name) && tool.type === 'function';
    });
  });
}

/** Only these executable output shapes may ever be delivered to the native host. */
function executable(item: Event, partial: boolean) {
  return (
    // Native Responses producers may omit the namespace. The declaration
    // allowlist keeps these exact type/name pairs unique across namespaces.
    (item.namespace == null || item.namespace === 'functions') &&
    typeof item.call_id === 'string' &&
    item.call_id.length > 0 &&
    (item.type === 'custom_tool_call'
      ? item.name === 'exec' && (partial || typeof item.input === 'string')
      : item.type === 'function_call' &&
        item.name === 'wait' &&
        (partial || typeof item.arguments === 'string'))
  );
}

export function validateCodexInput(payload: Event) {
  if (payload.store !== false) throw new Error('Native Codex storage must be disabled');
  if (payload.previous_response_id != null || payload.conversation != null || payload.background)
    throw new Error('Native Codex remote context is not allowed');
  if (payload.tools != null && (!Array.isArray(payload.tools) || payload.tools.length))
    throw new Error('Native Codex tools must use its explicit developer declarations');
  if (
    payload.stream !== true ||
    payload.parallel_tool_calls !== false ||
    !Array.isArray(payload.include) ||
    !payload.include.includes('reasoning.encrypted_content') ||
    typeof payload.prompt_cache_key !== 'string' ||
    !payload.prompt_cache_key
  )
    throw new Error('Native Codex requires bounded streaming and self-contained reasoning');
  if (payload.tool_choice != null && payload.tool_choice !== 'auto')
    throw new Error('Native Codex tool selection must remain automatic');
  if (!Array.isArray(payload.input)) throw new Error('Native Codex history must be self-contained');
  let declared = false;
  for (const item of payload.input) {
    if (!object(item)) throw new Error('Invalid native Codex input item');
    if (item.type === 'additional_tools') {
      if (!declarations(item)) throw new Error('Native Codex tool declaration is not allowed');
      declared = true;
      continue;
    }
    if (['custom_tool_call', 'function_call'].includes(item.type)) {
      if (!executable(item, false))
        throw new Error('Native Codex retained executable is not allowed');
      continue;
    }
    if (['custom_tool_call_output', 'function_call_output'].includes(item.type)) {
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        (typeof item.output !== 'string' && !textParts(item.output))
      )
        throw new Error('Native Codex tool outputs must be self-contained text');
      continue;
    }
    if (item.type === 'reasoning') {
      if (!reasoning(item)) throw new Error('Invalid native Codex reasoning');
      continue;
    }
    if (
      (item.type != null && item.type !== 'message') ||
      !['user', 'assistant', 'system', 'developer'].includes(item.role) ||
      (typeof item.content !== 'string' && !textParts(item.content))
    )
      throw new Error('Native Codex input must contain only supported text history');
  }
  if (!declared) throw new Error('Native Codex developer tool declarations missing');
}

export function codexRequestHashes(payload: Event) {
  return {
    systemHash: hash(
      payload.input
        .filter(
          (item: Event) =>
            ['system', 'developer'].includes(item.role) && item.type !== 'additional_tools',
        )
        .map((item: Event) => ({ role: item.role, content: item.content })),
    ),
    toolsHash: hash(
      payload.input
        .filter((item: Event) => item.type === 'additional_tools')
        .map((item: Event) => item.tools),
    ),
    promptCacheKey: payload.prompt_cache_key,
    prefixSource: 'native_developer_messages_and_additional_tools',
  };
}

/** Inspect the buffered stream, including transient items missing from the terminal. */
export function validateCodexOutput(events: Event[], streaming: boolean) {
  const inspect = (item: unknown, partial: boolean) => {
    if (!object(item)) throw new Error('Native Codex output item is malformed');
    if (['custom_tool_call', 'function_call'].includes(item.type)) {
      if (!executable(item, partial)) throw new Error('Native Codex executable output refused');
      return;
    }
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !textParts(item.content))
        throw new Error('Native Codex message output refused');
      return;
    }
    if (item.type === 'reasoning' && reasoning(item)) return;
    throw new Error('Native Codex output item type refused');
  };
  for (const event of events) {
    if (!object(event)) throw new Error('Native Codex event is malformed');
    if (event.item != null) inspect(event.item, event.type === 'response.output_item.added');
    for (const value of [event.response, ...(!streaming ? [event] : [])]) {
      if (value?.output != null) {
        if (!Array.isArray(value.output)) throw new Error('Native Codex output must be an array');
        for (const item of value.output) inspect(item, value.status !== 'completed');
      }
    }
  }
}
