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

## Deploy to Cloudflare

Deployment requires Node 24 and a **Workers Paid plan** for the
[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/)
used by Code Mode. Executions incur Dynamic Worker creation, request, and CPU
usage. The checked-in configuration includes the `LOADER` binding; there are no
databases, persistent sessions, or Google OAuth secrets to provision on the Worker.

The deployment command below uses environment variables without editing
`wrangler.jsonc` or application source:

| Variable                | Purpose                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Target account; supply for unattended CLI/CI deployment.                                           |
| `CLOUDFLARE_API_TOKEN`  | Wrangler deployment credential; store as a CI secret. Local Wrangler login also works.             |
| `WORKER_NAME`           | Optional Worker name; defaults to `google-codemode-mcp`, or the Worker selected by Workers Builds. |
| `WORKER_DOMAIN`         | Optional custom hostname, e.g. `mcp.example.com`; no scheme or path.                               |
| `WORKER_ROUTE`          | Optional route pattern, e.g. `example.com/mcp*`; use instead of `WORKER_DOMAIN`.                   |

Use a token scoped to the target account with Workers Scripts edit permission
(the **Edit Cloudflare Workers** template). Custom domains/routes also need the
appropriate zone permissions, including Workers Routes edit and DNS access where
required. The hostname/zone must belong to the account.

```sh
npm ci --ignore-scripts
# Supply CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN through your environment.
export WORKER_NAME=my-google-mcp
export WORKER_DOMAIN=mcp.example.com  # optional
just deploy --dry-run                # Bundle and validate; no upload
just deploy                          # Publish and configure the domain/route
```

The equivalent command without `just` is `node .github/deploy.mjs`, optionally
with `--dry-run`. The helper maps settings to pinned Wrangler flags and keeps
Cloudflare credentials in the deployment process. These variables are not Worker
runtime bindings. Export them in the shell or configure them in CI build settings;
the helper does not load dotenv files.

With no domain or route, Wrangler enables
`https://<worker-name>.<account-subdomain>.workers.dev/mcp`. With either setting,
it disables the workers.dev endpoint and publishes the configured domain/route;
a custom-domain endpoint is `https://<domain>/mcp`. Keep the domain/route setting
on every deployment: configuring it only in the dashboard can let a later deploy
re-enable workers.dev. A route must cover `/mcp`; a custom domain serves the Worker
directly, while a route requires existing proxied DNS/origin configuration.

**Caller access protection is separate.** This Worker has no caller authentication
middleware. Anyone who can reach it can submit code and consume your Worker
resources; Google operations additionally require the supplied Google token.
Put the endpoint behind the authenticated gateway or Cloudflare Access, and
protect any workers.dev or preview URLs that you enable. Choosing a custom domain
does not itself add authentication. The Google token remains the `accessToken`
tool argument; an Authorization header does not populate that argument.

### Git-connected Workers Builds

Connect a repository you can access in the Cloudflare dashboard. The same
checkout can serve different accounts, names, and domains through
[Build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/):

| Setting           | Value                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| Root directory    | Repository root                                                                         |
| Production branch | `main`                                                                                  |
| Build variables   | `NODE_VERSION=24`, `SKIP_DEPENDENCY_INSTALL=1`, plus optional `WORKER_*` settings above |
| Build command     | `npm ci --ignore-scripts`                                                               |
| Deploy command    | `node .github/deploy.mjs`                                                               |
| Preview builds    | Disable for this initial setup; preview deployment/protection is unqualified.           |

Workers Builds supplies its account/deployment credential. Do not add the Gmail
test OAuth secrets to Builds or the deployed Worker. Build variables are available
only during the build/deploy process; putting `WORKER_DOMAIN` in runtime Variables
& Secrets will not configure deployment.

The helper follows the dashboard's selected Worker name. An explicit `WORKER_NAME`
must match it. Wrangler's injected account/Worker identity checks are preserved;
the helper passes the selected name so a name mismatch does not trigger Wrangler's
config-name correction warning. No generated Wrangler configuration is needed.

This supports deployment without source edits. Cloudflare's separate
[Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
requires a public source repository and copies it into the deployer's Git account;
that flow may rewrite names in the copy. It is a future release convenience, not
an unchanged-checkout guarantee. Its handling of the Worker Loader binding has
not been verified, so no active deployment button is advertised yet.

Dry-runs validate bundling and option compatibility. Account permissions, DNS,
Workers Builds execution, hosted Worker Loader behavior, and CPU-limit enforcement
still require hosted verification. No hosted deployment has been performed.

## HTTP connection contract

Send JSON-RPC to `POST /mcp`. Every request includes
`Content-Type: application/json`, `MCP-Protocol-Version: 2026-07-28`, and
`MCP-Method` matching the JSON-RPC method. For `tools/call`, also send `MCP-Name`
matching `params.name`. Repeat the protocol/client capability metadata in each
request; there is no initialize request or session identifier.

For example, list tools without a Google token:

```sh
curl --fail-with-body https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'MCP-Method: tools/list' \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

An `execute` call uses these additional headers/body. The token placeholder is
replaced by the trusted caller with a short-lived Google access token whose grant
covers the discovered method's scopes:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
MCP-Method: tools/call
MCP-Name: execute

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "execute",
    "arguments": {
      "accessToken": "<short-lived Google token>",
      "inputs": {},
      "code": "const gmail = google.gmail({version: 'v1'}); return (await gmail.users.getProfile({userId: 'me'})).data;"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Add whatever caller-authentication headers your gateway or Access policy requires
separately. Finite JSON responses contain the normal MCP tool result; execution
data, including mutation outcomes, is in `result.structuredContent`. The pinned
official MCP client handles these headers/metadata; other clients must support
this protocol revision or use an adapting gateway.

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

Live Gmail reads, labels, drafts, and controlled self-send passed locally and on
GitHub, as recorded below. No hosted deployment has been performed. Gateway
adaptation, hosted CPU enforcement, and all three host integrations remain
acceptance work. Subsequent APIs are Drive,
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

### Agent feasibility gate

The manual model matrix runs agents through the built MCP Worker and local
CLIProxyAPI, using the dummy account configured below. Ordinary checks never
invoke models.

```sh
just eval-matrix gmail http://127.0.0.1:8317 /absolute/new/evidence-directory
# Explicitly include probes and references:
just eval-matrix gmail http://127.0.0.1:8317 /absolute/new/full-matrix-directory all
```

Sonnet 5.5 and GPT 6.1 Sol are required. Haiku 5.5 and GPT 6 Luna are probes;
Opus 5.5 and GPT 6.1 Terra are references. Each selected cell runs once with fresh
fixtures. Optional score failures are informational; uncertainty, cleanup failures,
and infrastructure failures stop the campaign. Claude uses native CLI 2.1.318;
GPT uses an isolated Responses tool loop, which does not qualify the ChatGPT host.
Single-model runs remain available through `just eval`.

The Gmail case requires discovery, retrieval of the server's `skill://` resource,
reading and replying to an email, applying a label, and saving its attachment.
Independent Google readback and exact file bytes determine success. The actor
cannot access credentials, graders, or expected results. Each trial retains its
trace, model/cache usage, criteria, and fixture cleanup receipt outside the checkout.
Limits include five minutes, 18 model requests, 15,000 output tokens reserved
conservatively, and a $1 estimate per cell (native CLI for Claude, recorded published
token rates for GPT). Estimates are separate from actual proxy billing. There are no performer retries or automatic model fallbacks.

Only Gmail is implemented. Drive, Sheets, Docs, and Calendar remain pending
coverage targets; selecting them fails before model spending. This is a synthetic
feasibility check, not acceptance of every host or service. See the
[gate documentation](.github/eval/README.md) for isolation, usage accounting,
offline regrading, and manual GitHub setup.

The first matrix completed all task outcomes with Sonnet, Terra, and Haiku, but
all three failed the full discovery/skill gate. Sonnet and Haiku skipped method
discovery; Terra skipped root discovery and the skill resource. Luna exhausted
18 turns without completing the task, stopping the campaign before Opus/Sol.
All attempted cells cleaned up successfully with no unknown mutations. The
[gate results](.github/eval/README.md#first-model-matrix-2026-11-04) retain these
failures, observed cache counters, estimates, and the unattempted cells.

The current required models each have one passing attempt: Sonnet after fixing
instruction handoff and clarifying product guidance; Sol after additionally fixing
conservative budget settlement. Both completed the Gmail task, discovery, skill
retrieval, and cleanup with zero unknown mutations. These are separate harness
candidates, not a fresh pair pass or a reliability claim. The earlier failed pair
remains retained. See the [qualified results](.github/eval/README.md#sol-validation-with-accounting-version-2-2026-11-04)
for cost/cache evidence and the method criterion's coverage limits.

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

Live Gmail verification passed locally through `act` and on
[GitHub Actions](https://github.com/marcfargas/google-codemode-mcp/actions/runs/41755819750)
for commit `b0e5dba626e162a4af14e14f29f95538926601ca`. Both runs completed
fixture cleanup with no unknown mutation outcomes.
