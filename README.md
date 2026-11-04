# google-codemode-mcp

Google Workspace APIs through native Google Discovery and server-side Code Mode.
The first usable local slice supports **Gmail v1** on Cloudflare Workers.

The MCP endpoint is `/mcp`, targeting revision **2026-07-28** directly. Each message
is an independent HTTP POST with a finite JSON response. There are no protocol
sessions, initialization handshake, subscriptions, GET streams, or persistent
connections.

## Run locally

Requires Node 24.

```sh
npm ci
just dev
```

Connect a compatible MCP client to `http://localhost:8787/mcp`, pinned to
`2026-07-28`. `just check` runs the GitHub Check workflow locally with `act`: typechecking,
building, real Worker tests, and formatting. `just verify` executes those same
workflow checks directly on the host. `just build` prepares a Wrangler deployment without
publishing it.

The service expects the authenticated gateway/caller to supply short-lived Google
OAuth credentials through the `accessToken` tool argument. The existing CFA
gateway currently projects Google credentials into an Authorization header; it
needs an adapter to populate this argument. The deployed MCP service does not acquire,
refresh, or retain credentials. Request arguments are visible to the submitting
host; keep credential injection in the trusted caller.

## Discover, then execute

The two core tools are `describe` and `execute`. Deployment snippets can add tools.
Start with `describe({})`, then progressively select a service, resource, or method:

```js
describe({ path: 'gmail/v1' });
describe({ path: 'gmail/v1/users.messages' });
describe({ path: 'gmail/v1/users.messages.list' });
```

Method descriptions include native parameters, generated TypeScript declarations,
selected request/response schemas and their reachable references, Google scope
alternatives, source/revision, transport support, and documentation links. Methods
come from Google's Discovery document; there is no handwritten method catalog.
Successful documents are cached for the Worker isolate's lifetime. Failed loads
can be retried. The first slice accepts no revision pin or refresh command.
Executions that use Discovery report the loaded source and revision.

Submit an async JavaScript function body:

```js
execute({
  accessToken: '<injected by the trusted caller>',
  inputs: { query: 'is:unread' },
  code: `
    const gmail = google.gmail({ version: 'v1' });
    const { data } = await gmail.users.messages.list({
      userId: 'me', maxResults: 10, q: inputs.query,
    });
    return data;
  `,
});
```

The program receives `google`, immutable `inputs`, and `snippets`. The token stays
in the trusted dispatcher. Google resource trees, method names, `requestBody`,
`.data`, and explicit pagination remain familiar. A page can contain no items and
still have `nextPageToken`; programs decide whether to fetch another page.

The dispatcher reuses Google's dynamic Node Discovery client and validates native
parameters at its boundary. Credential arguments, SDK transport options, arbitrary
headers/URLs, callbacks, streams, and media overrides are rejected. Sandbox
networking is denied by workerd. JSON requests/responses are supported, including
Gmail base64url message/attachment fields. Media uploads/downloads and artifacts
are not implemented in this slice. Scope availability for opaque tokens is
`unknown`; Discovery scopes describe alternatives and do not grant access.

## Mutation outcomes

Each execution returns `requestId`, `status`, `result`, bounded `logs`, `outcomes`,
`hasUnknownOutcome`, and Discovery provenance. The trusted dispatcher records call
outcomes even when the program catches an exception:

| Outcome          | Meaning                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `not_dispatched` | Validation, policy, or the dispatch gate prevented the call.                                                 |
| `rejected`       | Google returned an authoritative 4xx rejection, excluding 408.                                               |
| `acknowledged`   | Google returned a successful HTTP status. A later body/output limit can still make the call return an error. |
| `unknown`        | A dispatched call lacks an authoritative outcome, such as a connection loss, timeout, or server failure.     |

Gmail acknowledgement does **not** establish recipient delivery. Mutations are
serialized. An unknown mutation blocks later mutations in the same execution;
reads remain available for reconciliation. Automatic retries are disabled. Inspect
the ledger before repeating a write, including when execution status is
`completed` because the program caught the error.

When execution ends, the dispatcher closes and aborts active work. A mutation
already in flight remains unknown unless a successful status was observed.
Queued calls cannot start afterward. The execution's asynchronous timer is 15s;
Google calls also have a 15s deadline. Defaults allow 100 Google call attempts,
1 MB per Google response (bounded during reading), 64,000 characters each for code
and inputs, 256,000 characters for the output, and 16 nested snippet invocations
with depth at most four. Oversized/non-JSON program results return an error while
preserving recorded outcomes. Logs are capped to 100 entries of 4,096 characters.

The dynamic Worker requests a 1,000 ms CPU budget. **Local workerd did not enforce
that cap in a finite overbudget-loop probe**; hosted enforcement remains unverified.
The asynchronous timer does not interrupt synchronous JavaScript loops.

`requestId` is correlation only. There is no durable submission deduplication,
receipt lookup, retry recovery, or replay. Losing the outer response or the Worker
process can lose its in-memory ledger. Repeating a submission can repeat effects.

## Deployment snippets and Skills

Edit [snippets.config.ts](snippets.config.ts) to import bundled or project-owned
snippet modules, including modules at a chosen deployment path. Wrangler bundles
the registry. Each `SnippetDefinition` declares:

- `name`, `description`, async function-body `code`, and JSON `inputSchema`;
- required `services` and `scopes`;
- optional `readOnly` restriction and `tool: { name, description? }` exposure.

Definitions are validated and frozen. Service/read-only restrictions apply at
trusted dispatch, including nested snippets. Scope declarations remain metadata.
Both invocation paths share the same execution boundary and outcome ledger:

```js
// Inside execute:
return await snippets.run('gmailInbox', { maxResults: 10 });

// Exposed MCP tool:
gmail_inbox({ accessToken: '<injected>', inputs: { maxResults: 10 } });
```

`describe({path: 'snippets'})` returns the configured descriptors. There is no
runtime snippet installation API. Version snippets through their deployment.

The official MCP Skills extension and Resources expose
[skills/google-workspace/SKILL.md](skills/google-workspace/SKILL.md). It is also a
standard skill directory suitable for host packaging. Claude, ChatGPT, and
OpenClaw remain the host targets; their concrete tool, Code Mode, and Skills paths
still need qualification. The existing gateway's Skills forwarding is also
unverified.

The separate [Google Developer Knowledge MCP](https://developers.google.com/knowledge/mcp)
is configured for this project's Codex environment in `.codex/config.toml`. Its
API key is read from a private user-owned file outside the repository. It supplies
official documentation independently of this execution service.

## Delivery status

Local tests cover real workerd isolation/RPC, the official pinned MCP client,
Skills integrity, dynamic Discovery, native request encoding, credential/transport
isolation, failure outcomes, timeout/unawaited-call fencing, snippets, and the
actual Wrangler build. Workspace responses are synthetic in these checks.

No hosted deployment or authenticated Gmail business operation has been performed.
Live Gmail reads/drafts/controlled send, gateway adaptation, hosted CPU enforcement,
and all three host integrations remain acceptance work. Subsequent APIs are Drive,
Sheets, Docs, and Calendar, in that order. Tasks and replay are deferred.

[Project scope and remaining acceptance](https://github.com/marcfargas/google-codemode-mcp/issues/1).

## Workflow verification

All test sources, fixtures, OAuth helpers, and workflow code live under `.github/`.
Commands are exposed through `justfile`; there is no project `scripts/` directory
or npm task layer. Requires Node 24, Docker, `act`, `just`, and `gh` for secret
installation. GitHub uses the same `.github/run.mjs` entrypoint as local checks.

```sh
npm ci --ignore-scripts
just check       # Run the credential-free Check workflow in act
just verify      # Run its steps directly for fast feedback
just live        # Run the explicit Live Gmail workflow in act
```

Check runs on pushes and pull requests with no OAuth credentials. Live Gmail is
manual-only on `main`, serialized in GitHub, and receives only its three required
repository secrets. Local `act` copies the working tree respecting `.gitignore`,
uses explicit env/secret files, and does not bind-mount the repository or expose
its account-password file to the container. It tests current working-tree bytes;
a remote run tests its checked-out commit.

### Initial test consent and CI secrets

The supplied installed-app client defaults to
`/tmp/google-codemode-mcp-oauth-client.json`. The ignored `.test.env` provides
`GOOGLE_TEST_USER`, `GOOGLE_TEST_PASSWORD`, and `GOOGLE_TEST_TOPT_KEY` (that spelling
matches the supplied file). Password and authenticator seed remain local. The
CLI uses PKCE, a random OAuth state, and a temporary localhost callback.

```sh
just oauth                       # Complete interactive browser consent once
just oauth --automate            # Optional local browser sign-in attempt
just github-secrets              # Install OAuth client, refresh grant, expected user
just live
```

Automated consent uses Playwright; install its Chromium with
`node_modules/.bin/playwright install chromium` or set `GOOGLE_CHROME_PATH` to an
existing compatible executable. Google can reject automated sign-in. In that case
use interactive `just oauth`. Open its authorization URL in your own
browser, complete consent, then paste the full localhost redirect URL into the
waiting CLI. A failed localhost page is expected when the browser runs on another
machine; no port forwarding is required. Paste input is hidden and is also accepted
through stdin for private file delivery. Use the URL from the same still-running
consent attempt. Browser-copied addresses that omit the `http://` prefix are also
accepted. Automatic localhost callbacks still work.

Consent requests `gmail.modify`, verifies the expected Gmail profile, then saves
only the refresh grant and binding metadata at
`~/.config/google-codemode-mcp/test-oauth.json` with mode 0600. Override inputs with
`GOOGLE_OAUTH_CLIENT_FILE` and `GOOGLE_TEST_TOKEN_FILE` when needed. No refresh
credential is stored in the repository. In Google's External/Testing mode, Gmail
refresh grants expire after seven days; renew consent and reinstall the secret.

GitHub secrets are `GOOGLE_OAUTH_CLIENT_JSON`, `GOOGLE_TEST_REFRESH_TOKEN`, and
`GOOGLE_TEST_USER`. `just github-secrets` passes values over stdin, never argv.
The helper's `--client-only` option installs the client and expected user before a
grant exists. Missing or invalid live credentials fail the job; they do not skip
it. Password/TOTP are not required by CI.

### What the live workflow proves

The live suite runs the actual Wrangler output in local workerd with a pinned MCP
client, real Google Discovery, and real Gmail requests. It verifies the mailbox
identity before writes, native reads and snippet parity, temporary label and draft
CRUD, raw base64url bodies, controlled pagination, one self-send, separate bounded
recipient-inbox observation, and invalid-token rejection. Writes are never retried.
Cleanup acts only on IDs recorded by the run and uses trash for sent messages.

A sanitized `dist/live-gmail-receipt.json` records run markers, fixture IDs,
unknown mutations, and cleanup failures. GitHub retains it for seven days; act
retains downloaded artifacts under `dist/act-artifacts/`. An unknown write may
leave a fixture without a returned ID. Its run markers support later
reconciliation; a missing search result is not proof that no write happened.

A successful live run qualifies the production bundle against live Gmail. Hosted Cloudflare
CPU enforcement, CFA gateway adaptation, and Claude/ChatGPT/OpenClaw integration
remain separate acceptance work.

Live Gmail verification is currently pending initial interactive consent.
