import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
} from '@modelcontextprotocol/server';
import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

export const MCP_VERSION = '2026-07-28';

// Kept identical to the distributable skill; protocol.test.ts verifies the bytes.
export const WORKSPACE_SKILL = `---
name: google-workspace
description: Discover Google Workspace API methods and run JavaScript through the describe and execute tools. The first deployment supports Gmail v1.
---

# Google Workspace Code Mode

Use \`describe\` to discover the deployment's available APIs, methods, parameters,
request bodies, response schemas, and snippets. Start with \`describe({})\`, then
read the returned Workspace skill URI through MCP Resources. Follow the returned
service and resource paths down to each method you need. Describe each method
before calling it in \`execute\`, including methods familiar from other Google
clients: this deployment's available methods, parameters, schemas and transport
limits come from its Discovery document.

Use \`execute\` to submit JavaScript. The trusted caller supplies a short-lived
OAuth \`accessToken\` as a request argument. The program receives \`google\`, \`inputs\`,
and deployment-provided \`snippets\`; it does not receive the token. Keep user data
in \`inputs\` instead of interpolating it into code.

The following illustrates the native client shape after method discovery. It is
not a substitute for describing \`gmail/v1/users.messages.list\` and checking its
current parameters and response schema.

\`\`\`js
const gmail = google.gmail({ version: 'v1' });
const { data } = await gmail.users.messages.list({
  userId: 'me',
  maxResults: 10,
  q: inputs.query,
});
return data;
\`\`\`

Google method names, parameters, request bodies, and the \`.data\` response envelope
are preserved. Handle \`nextPageToken\` explicitly when more results are needed.
Use discovered snippet metadata for its inputs, required services and OAuth
scopes. Some deployment snippets also appear as tools; tool arguments contain
\`accessToken\`, \`inputs\`, and an optional correlation \`requestId\`.

Inspect the execution's mutation outcomes even if the program catches an error.
An uncertain mutation outcome requires reconciliation before repeating the write.
An execution identifier or \`requestId\` is correlation, not a Google idempotency
key. The service does not automatically retry mutations or durably deduplicate
submissions. Tasks, durable execution, and program replay are deferred.

The endpoint requires MCP revision \`2026-07-28\`. Each request is an independent
HTTP POST with a finite JSON response. Claude, ChatGPT, and OpenClaw host support
requires a compatible client or gateway; publishing this skill does not establish
that each host supports the revision or the Skills extension.

Invoke a bundled snippet from code with \`await snippets.run('gmailInbox', inputs)\`.
Read its descriptor with \`describe({path: 'snippets'})\`. Google scope declarations
are requirements, not grants; available scopes are unknown for an opaque token.

This slice supports JSON requests and responses, including Gmail base64url message
bodies and attachments returned in JSON. Media upload/download overrides are
rejected. Google acknowledgement of a send does not establish recipient delivery.

References:

- [Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest)
- [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Google Developer Knowledge MCP](https://developers.google.com/knowledge/mcp)

The separate Developer Knowledge MCP supplies official API guidance and can be
configured in the host. Execution does not depend on that documentation service.
`;

export interface ExecuteArguments {
  accessToken: string;
  code: string;
  inputs?: Record<string, unknown>;
  requestId?: string;
}

export type SnippetArguments = Omit<ExecuteArguments, 'code'>;

export interface ProtocolSnippet {
  name: string;
  description: string;
  inputSchema: JsonSchemaType;
  services: readonly string[];
  scopes: readonly string[];
  code: string;
  readOnly?: boolean;
  tool?: { name: string; description?: string };
}

export interface ProtocolApp {
  describe(args: { path?: string }): Promise<unknown>;
  execute(args: ExecuteArguments): Promise<unknown>;
  snippets: readonly ProtocolSnippet[];
  runSnippet(name: string, args: SnippetArguments): Promise<unknown>;
}

const executionProperties = {
  accessToken: {
    type: 'string',
    minLength: 1,
    description: 'Short-lived Google OAuth access token supplied by the trusted caller.',
  },
  inputs: { type: 'object', additionalProperties: true },
  requestId: {
    type: 'string',
    minLength: 1,
    description: 'Correlation only; not an idempotency key.',
  },
};

function toolResult(value: unknown): CallToolResult {
  const structuredContent =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value ?? null };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/** One request owns one server and handler; neither retains caller credentials. */
export async function handleMcp(request: Request, app: ProtocolApp): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } });
  }

  const validator = new CfWorkerJsonSchemaValidator();
  const skills = await SkillsExtension.load(
    memorySkillFiles({ 'google-workspace/SKILL.md': WORKSPACE_SKILL }),
    { prefix: 'google-codemode-mcp', strict: true },
  );
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: 'google-codemode-mcp', version: '0.1.0' },
        {
          supportedProtocolVersions: [MCP_VERSION],
          jsonSchemaValidator: validator,
          instructions:
            'Start with describe({}) to discover available services. Read the returned Workspace skill URI through MCP Resources. Follow returned paths and describe each method you need before calling it in execute; do not assume a familiar Google method is supported.',
        },
      );
      server.registerTool(
        'describe',
        {
          description:
            'Discover available Google APIs, methods, schemas, and deployment snippets. Start with describe({}), read the returned Workspace skill through MCP Resources, and follow returned paths to inspect each needed method before execute.',
          inputSchema: fromJsonSchema<{ path?: string }>(
            {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description:
                    'Omit to list services. Follow returned paths to inspect versions, resources, methods, or schemas. Version paths use service/version; resource and method paths use service/version/resource.method.',
                },
              },
              additionalProperties: false,
            },
            validator,
          ),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => toolResult(await app.describe(args)),
      );
      server.registerTool(
        'execute',
        {
          description:
            'Run JavaScript with Google APIs and deployment snippets after reading the Workspace skill and describing each Google method you will call. Use the discovered parameters and schemas. Inspect returned mutation outcomes before retrying writes.',
          inputSchema: fromJsonSchema<ExecuteArguments>(
            {
              type: 'object',
              properties: { ...executionProperties, code: { type: 'string', minLength: 1 } },
              required: ['accessToken', 'code'],
              additionalProperties: false,
            },
            validator,
          ),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async (args) => toolResult(await app.execute(args)),
      );
      for (const snippet of app.snippets) {
        if (!snippet.tool) continue;
        server.registerTool(
          snippet.tool.name,
          {
            description: snippet.tool.description ?? snippet.description,
            inputSchema: fromJsonSchema<SnippetArguments>(
              {
                type: 'object',
                properties: {
                  ...executionProperties,
                  inputs: structuredClone(snippet.inputSchema),
                },
                required: ['accessToken'],
                additionalProperties: false,
              },
              validator,
            ),
            annotations: {
              readOnlyHint: snippet.readOnly ?? false,
              destructiveHint: !snippet.readOnly,
              openWorldHint: true,
            },
            _meta: { services: [...snippet.services], scopes: [...snippet.scopes] },
          },
          async (args) => toolResult(await app.runSnippet(snippet.name, args)),
        );
      }
      skills.attach(server);
      return server;
    },
    {
      legacy: 'reject',
      responseMode: 'json',
      keepAliveMs: 0,
      // The SDK handles subscriptions separately from responseMode: 'json'.
      maxSubscriptions: 0,
      maxRequestBodySize: 1_048_576,
    },
  );
  try {
    const response = await handler.fetch(request);
    const body = response.body === null ? null : await response.text();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await handler.close();
  }
}
