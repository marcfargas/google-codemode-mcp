import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';

export interface SnippetDefinition {
  name: string;
  description: string;
  /** Async function body. Receives inputs, google and snippets. */
  code: string;
  inputSchema: Record<string, unknown>;
  services: readonly string[];
  /** Required scope alternatives; metadata cannot grant OAuth access. */
  scopes: readonly string[];
  readOnly?: boolean;
  tool?: { name: string; description?: string };
}

export function validateSnippets(definitions: readonly SnippetDefinition[]) {
  const names = new Set<string>();
  const tools = new Set(['describe', 'execute']);
  for (const snippet of definitions) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(snippet.name) || names.has(snippet.name)) {
      throw new Error('Invalid or duplicate snippet name');
    }
    names.add(snippet.name);
    if (!snippet.description || !snippet.code || snippet.code.length > 64_000) {
      throw new Error(`Invalid snippet definition: ${snippet.name}`);
    }
    if (!snippet.services.length || snippet.services.some((s) => s !== 'gmail/v1')) {
      throw new Error(`Unsupported snippet service: ${snippet.name}`);
    }
    if (snippet.scopes.some((s) => !s.startsWith('https://www.googleapis.com/auth/'))) {
      throw new Error(`Invalid snippet scopes: ${snippet.name}`);
    }
    if (snippet.inputSchema.type !== 'object') {
      throw new Error(`Snippet inputSchema must describe an object: ${snippet.name}`);
    }
    new Validator(structuredClone(snippet.inputSchema) as Schema);
    if (snippet.tool) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(snippet.tool.name) || tools.has(snippet.tool.name)) {
        throw new Error('Invalid or duplicate snippet tool name');
      }
      tools.add(snippet.tool.name);
    }
  }
  // Clone deployment configuration so later caller mutation cannot alter the registry.
  return Object.freeze(structuredClone(definitions).map((s) => deepFreeze(s)));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateSnippetInput(snippet: SnippetDefinition, input: unknown) {
  if (!new Validator(structuredClone(snippet.inputSchema) as Schema).validate(input).valid) {
    throw new Error(`Invalid inputs for snippet ${snippet.name}`);
  }
}

export const bundledSnippets: readonly SnippetDefinition[] = [
  {
    name: 'gmailInbox',
    description: 'List one page of inbox message IDs with the native nextPageToken.',
    code: `return (await google.gmail({version: 'v1'}).users.messages.list({
      userId: 'me', labelIds: ['INBOX'], maxResults: inputs.maxResults ?? 10,
      ...(inputs.pageToken ? {pageToken: inputs.pageToken} : {})
    })).data;`,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
        pageToken: { type: 'string' },
      },
      additionalProperties: false,
    },
    services: ['gmail/v1'],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    readOnly: true,
    tool: { name: 'gmail_inbox' },
  },
];
