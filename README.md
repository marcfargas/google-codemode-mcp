# google-codemode-mcp

Google Workspace APIs through native Google Discovery and server-side Code Mode.
The local product supports **Gmail v1 and Drive v3** on Cloudflare Workers.

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
OAuth credentials through the `accessToken` tool argument. The CFA gateway's
separate `google-codemode` adapter hides this input from agents and injects the
caller's Google grant for execution. Its source and synthetic integration tests
are implemented in `bgbl-mcp-gateway`; hosted binding and caller acceptance remain
unverified. The deployed MCP service does not acquire,
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

The equivalent command without `just` is `node deploy.mjs`, optionally
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
| Deploy command    | `node deploy.mjs`                                                                       |
| Preview builds    | Disable for this initial setup; preview deployment/protection is unqualified.           |

If an existing Workers Builds configuration uses `node .github/deploy.mjs`, update
its Deploy command to `node deploy.mjs` when adopting this layout.

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

Dry-runs validate bundling and option compatibility. A separate Access-protected
verification Worker passed hosted synthetic runtime checks on 2026-11-04,
including native CPU termination, asynchronous timeout, cancellation fences and
multiple bridge calls. Account/DNS configurations, Workers Builds, and deployment
of the live Google service remain separate from that bounded qualification.

The [hosted verification harness](tests/hosted/README.md) prepares a separate
private Worker with fixed synthetic probes, then checks its exact deployed
version through an existing protected ingress. Run `just hosted-prepare OUTPUT`
without credentials; after deployment, `just hosted-verify OUTPUT` uses the
documented `HOSTED_*` environment settings. It checks native CPU termination,
the 15-second asynchronous timeout, late-call fencing, multiple bridge calls and
healthy follow-ups. Local tests cover these paths except hosted CPU enforcement.
An external timeout or generic resource error cannot pass the CPU criterion.
The qualified run observed the native `Worker exceeded CPU time limit.` exception;
see the [hosted result and its limits](tests/hosted/README.md#qualified-hosted-run-2026-11-04).

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

Selected method `parameters`, generated declarations, and runtime validation share
one supported top-level parameter policy. Descriptions identify excluded native
parameters and their reasons; native request-body fields remain intact. A method
requiring an excluded parameter is marked unsupported and has no callable signature.

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
Executions report an array of all loaded service sources and revisions.

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
headers/URLs, callbacks, streams, and unsupported media overrides are rejected.
Sandbox networking is denied by workerd. JSON requests/responses include Gmail
base64url message/attachment fields. Drive media reads use the bounded channel
below. Media uploads and durable artifacts remain unavailable. Scope availability for opaque tokens is
`unknown`; Discovery scopes describe alternatives and do not grant access.

### Drive metadata and bounded files

Discover `drive/v3/files.list`, `drive/v3/files.get`, or `drive/v3/files.update`
before using `google.drive({version: 'v3'})`. Native JSON metadata and PATCH
request bodies are preserved. For example, `files.update({fileId: inputs.id,
requestBody: {name: inputs.name}})` renames an existing file.

Drive v3 `files.update` has no conditional-update parameter in Discovery revision
`20261102`. `File.version` is output-only and cannot act as a compare-and-swap
input. Conditional transport headers such as `If-Match` and second-argument SDK
options are refused before dispatch. Concurrent lost updates are not prevented.
An owned-fixture Google probe accepted a deliberately mismatched `If-Match` and
applied the rename; that observation covers the tested metadata update, not every
Drive endpoint or conditional mechanism.

For `files.list`, request `nextPageToken,incompleteSearch` in your field mask.
Pass each returned token unchanged as `pageToken` with the same query. Continue across empty pages
while a token exists. Preserve and inspect `incompleteSearch`: a value of `true`
means the traversal cannot establish a complete search. The Worker does not fetch
additional pages automatically. See the native [list reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list).

Methods declaring `runtime.mediaDownload` expose their media selection and byte
limit. `files.get({fileId: inputs.id, alt: 'media'})` returns `.data` as
`{encoding: 'base64', data, size, mimeType, sha256}`. `data` is standard base64;
`size` and SHA-256 describe the original bytes, including arbitrary binary files.
`files.export` uses this envelope directly, with a discovered export MIME type.
Downloads are limited to **131072 raw bytes** and the execution's overall output
limit still applies. Metadata reads retain Google's normal JSON `.data` shape.
The host decodes the bytes when saving a file; this Worker has no durable artifact
store. Gmail attachments continue to use Google's native base64url JSON fields.

`just oauth --drive` requests `gmail.modify` and `drive.file` for the dedicated
test user. The latter covers files created by this OAuth client; it does not grant
access to every file in the account. Enable Drive API in that client's GCP project.
`just live-drive` verifies the built Worker with owned file fixtures, exact byte
readback, a native rename, conditional-option refusal and bounded multi-page
traversal, followed by independent readback and cleanup. The manual agent suite is:

```sh
just eval-gmail http://127.0.0.1:8317 /absolute/new/gmail-evidence
just eval-drive http://127.0.0.1:8317 /absolute/new/drive-evidence
```

Gmail selects six independent cases and the required Sonnet/Sol pair (12 attempts,
maximum $12 in per-attempt estimates). Drive selects download, pagination, rename and
conditional-update limitation (eight attempts, maximum $8 in estimates). Each attempt retains the five-minute wall,
request/output and $1 estimate limits. Provider billing remains separate. These
commands are on demand; ordinary checks make no model or Google requests.

Grading version 3 retains the requirement for every ledger method, including snippet calls and
failed calls, to have a successful matching description completed before that
execution starts. Root discovery and the actual Workspace resource read must
complete before the first execution. Cases may also require discovery of methods
that must not be called; the conditional Drive case requires `files.update`.
Trusted relay ordinals establish ordering;
missing/truncated evidence stays unknown. Old trial results remain unchanged,
and offline regrades write separate evidence without new Google or model calls.

## Mutation outcomes

Each execution returns `requestId`, `status`, `result`, bounded `logs`, `outcomes`,
`outcomesComplete`, `hasUnknownOutcome`, and Discovery provenance. The trusted dispatcher records call
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

Drive `files.list` outcomes can include bounded native pagination evidence:
requested/next tokens, query, page size, field selection, ordering/search options,
returned file IDs and `incompleteSearch` when present. These annotations come from
validated calls and Google responses, independently of program output. An unsafe
or oversized value omits the whole annotation; missing evidence does not establish
that a page was terminal or a search complete.

The dynamic Worker requests a 1,000 ms CPU budget. **Local workerd did not enforce
that cap in a finite overbudget-loop probe**. The hosted synthetic verification
Worker subsequently observed the native CPU-limit exception under that configured
budget. Wall time does not measure exact CPU consumption. The asynchronous timer
does not interrupt synchronous JavaScript loops.

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
still need qualification. The gateway now implements namespaced Resources and
native Skills forwarding, with local SDK and workerd proof; activation in each
target host remains unverified.

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
GitHub, as recorded below. The six independent Gmail agent cases completed their
task outcomes with both required models; the initial stricter discovery gate failed
for Sonnet on attachment and pagination. A later focused hosted run passed both
cases with Sonnet and Sol, including strict discovery and skill retrieval. See the
[versioned results](tests/eval/README.md#independent-gmail-cases-with-grading-version-2-2026-11-04).
The separate hosted synthetic Worker passed CPU/timeout/cancellation and bridge
checks. The protected test Worker also ran the actual product against Gmail,
using test-account tokens directly. Gateway adaptation is deployed in its owning project, but the Code Mode
backend binding and provider-connected host journeys remain acceptance work. Drive's
authenticated download/rename checks passed. Both Sonnet and Sol now have passing
download and rename agent cases across retained runs. Sol's original runner
failure remains recorded; the fresh download validation passed after its repair.
Live multi-page traversal and conditional-option refusal are now qualified through
the built Worker. Conditional mutations remain unsupported; concurrent lost
updates are not prevented. See the
[Drive qualification and limits](tests/eval/README.md#drive-pagination-and-conditional-write-boundary-2026-11-05).
The fresh four-case Sonnet/Sol campaign passed download, pagination and rename;
both conditional-limit attempts failed only an unsettled fixture-version check.
A separately authorized version-2 conditional pair passed for Sol, while Sonnet
again failed only the version guard: two equal early observations did not predict
later continuity. The current conditional grader uses a trial-owned independent
outbound recorder plus the existing ledger and metadata/content checks; native
versions are diagnostic. Hosted conditional attempts stop before inference because
that recorder is local. Neither old conditional run has the new evidence.
Drive qualification remains open. See [per-attempt results and
token/cache/cost metrics](tests/eval/README.md#conditional-version-2-pair-2026-11-05).
Gmail/Drive media composition and advanced guidance follow Drive qualification.
Subsequent APIs are Sheets, Docs, and
Calendar, in that order. Tasks and replay are deferred.

[Project scope and remaining acceptance](https://github.com/marcfargas/google-codemode-mcp/issues/1).

### Project workflow skills

The developer skills below have one source in `.agents/skills/` for Codex and
relative aliases in `.claude/skills/` for Claude Code. They are separate from the
Workspace skill distributed by the MCP server. Reload the host's project skills
after pulling changes; a catalog entry confirms discovery, not execution.

| Skill                                                                      | Use                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [google-codemode-capture](.agents/skills/google-codemode-capture/SKILL.md) | Retain or retrieve requests, breakdowns, and deferred observations in GitHub                                              |
| [google-codemode-verify](.agents/skills/google-codemode-verify/SKILL.md)   | Choose and drive the maintained checks, synthetic preflight, or authorized live gate                                      |
| [google-codemode-docs](.agents/skills/google-codemode-docs/SKILL.md)       | Retrieve knowledge, prepare proposed usage before contract implementation, and reconcile affected docs after verification |

Invoke by name in Codex (`$google-codemode-capture`, for example) or Claude Code
(`/google-codemode-capture`). The procedures include concrete project operations
and fallbacks when shared mafe-si skills are unavailable.

## Workflow verification

Test suites and infrastructure live under `tests/`: `unit/` for isolated checks,
`integration/` for Worker, HTTP, CLI and runner checks, `live/` for credentialed
Google checks, and `fixtures/`, `support/`, `eval/` and `hosted/` for their helpers.
`.github/` contains GitHub workflows and repository-secret installation. Local
workflow launchers live in `tests/`; the deployment entrypoint is root `deploy.mjs`. Commands are
exposed through `justfile`; there is no project `scripts/` directory or npm task
layer. Requires Node 24, Docker, `act`, `just`, and `gh` for secret installation.
GitHub and local checks invoke `tests/run.mjs` directly.

Local workflow launchers can set `ACT_NODE_OPTIONS` to pass Node options verbatim
to the container. For a local network-family selection timeout, use
`ACT_NODE_OPTIONS=--no-network-family-autoselection just live-drive`. This changes
only Node in that invocation; it does not configure the Worker or GitHub runner.
Live runs retain the current source files, hashes and baseline/diff identity under
`dist/act-artifacts/candidate-*`, alongside the workflow's fixture receipt. The
receipt's `source` field alone identifies the baseline commit, not dirty bytes.

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

After evaluation, including failures, the workflow generates
`workflow-report/summary.md` and `summary.json` in the evidence directory, with
gates, unattempted cells, cleanup, and model-separated token/cache/cost metrics.
It also appends the report to the workflow step summary. Missing measurements
stay unknown and estimates remain separate from billing. Regenerate offline with
`just eval-report SAVED_EVIDENCE NEW_REPORT_DIRECTORY`; this makes no Google or
model calls and preserves original grades. See the
[report contract](tests/eval/README.md#generated-run-reports).

The Gmail case requires discovery, retrieval of the server's `skill://` resource,
reading and replying to an email, applying a label, and saving its attachment.
Independent Google readback and exact file bytes determine success. The actor
cannot access credentials, graders, or expected results. Each trial retains its
trace, model/cache usage, criteria, and fixture cleanup receipt outside the checkout.
Limits include five minutes, 18 model requests, 15,000 output tokens reserved
conservatively, and a $1 estimate per cell (native CLI for Claude, recorded published
token rates for GPT). Estimates are separate from actual proxy billing. There are no performer retries or automatic model fallbacks.

Gmail and Drive profiles are implemented. Sheets, Docs, and Calendar remain pending
coverage targets; selecting them fails before model spending. This is a synthetic
feasibility check, not acceptance of every host or service. See the
[gate documentation](tests/eval/README.md) for isolation, usage accounting,
offline regrading, and manual GitHub setup.

The first matrix completed all task outcomes with Sonnet, Terra, and Haiku, but
all three failed the full discovery/skill gate. Sonnet and Haiku skipped method
discovery; Terra skipped root discovery and the skill resource. Luna exhausted
18 turns without completing the task, stopping the campaign before Opus/Sol.
All attempted cells cleaned up successfully with no unknown mutations. The
[gate results](tests/eval/README.md#first-model-matrix-2026-11-04) retain these
failures, observed cache counters, estimates, and the unattempted cells.

Under the earlier grading version, each required model had one passing attempt: Sonnet after fixing
instruction handoff and clarifying product guidance; Sol after additionally fixing
conservative budget settlement. Both completed the Gmail task, discovery, skill
retrieval, and cleanup with zero unknown mutations. These are separate harness
candidates, not a fresh pair pass or a reliability claim. The earlier failed pair
remains retained. See the [qualified results](tests/eval/README.md#sol-validation-with-accounting-version-2-2026-11-04)
for cost/cache evidence and the earlier method criterion's coverage limits. The
current grader requires every used method to be described before execution; the
[independent case results](tests/eval/README.md#independent-gmail-cases-with-grading-version-2-2026-11-04)
retain the remaining Sonnet discovery failures and the corrected pagination grades.

### Initial test consent and CI secrets

The installed-app client lives at
`~/.config/google-codemode-mcp/test-oauth-client.json`, beside the retained refresh
grant. If this durable client is absent, the helper imports the original
`/tmp/google-codemode-mcp-oauth-client.json` once after validating the client and
any existing grant's account/client binding. A missing client file does not mean
that renewed consent is needed. The ignored `.test.env` provides
`GOOGLE_TEST_USER`, `GOOGLE_TEST_PASSWORD`, and `GOOGLE_TEST_TOPT_KEY` (that spelling
matches the supplied file). Password and authenticator seed remain local. The
CLI uses PKCE, a random OAuth state, and a temporary localhost callback.

```sh
just oauth                       # Refresh and verify the existing grant; consent if needed
just oauth --drive               # Also require the Drive file scope
just oauth --reauth              # Explicitly request fresh consent
just oauth --automate            # Use Playwright only when consent is needed
just github-secrets              # Install OAuth client, refresh grant, expected user
just live
```

`just oauth` first refreshes the saved grant and verifies the actual granted
scopes and expected Gmail account. A valid grant requires no browser and is not
rewritten. Consent starts only when no grant exists, Google explicitly reports
`invalid_grant`, a requested scope is missing, or `--reauth` is supplied. Network,
client authentication, malformed credential and account-verification failures
stop without starting consent or replacing the existing grant.
If the existing grant lacks the requested Gmail scope, account verification runs
on the newly consented grant before replacing the old one.

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

Consent requests `gmail.modify` (plus `drive.file` with `--drive`), verifies the
granted scopes and expected Gmail profile, then atomically saves the refresh
grant and binding metadata at `~/.config/google-codemode-mcp/test-oauth.json`.
The default credential directory is private (0700); installed client and grant
files are private (0600). Override inputs with `GOOGLE_OAUTH_CLIENT_FILE` and
`GOOGLE_TEST_TOKEN_FILE` when needed. Explicit overrides win; an invalid override
never falls back to another client or grant. No refresh
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

A successful live run qualifies the production bundle against live Gmail.
The separate hosted synthetic qualification proves runtime limits; hosted live
Google through the Code Mode gateway and provider-connected Claude/ChatGPT/OpenClaw
journeys remain separate acceptance work.

Live Gmail verification passed locally through `act` and on
[GitHub Actions](https://github.com/marcfargas/google-codemode-mcp/actions/runs/41755819750)
for commit `b0e5dba626e162a4af14e14f29f95538926601ca`. Both runs completed
fixture cleanup with no unknown mutation outcomes.
