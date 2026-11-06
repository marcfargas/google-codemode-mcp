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

Connect directly with a compatible MCP client. The trusted caller supplies a
short-lived Google OAuth token through the `accessToken` tool argument. The server
owns Google execution, private artifact storage, artifact reads and byte movement
between Google services. The gateway supplies caller authentication and injects
the token for hosts that connect through it.

The executor does not acquire, refresh or retain durable Google credentials.
Request arguments are visible to the submitting host; keep credential injection
in the trusted caller. Deployment ingress controls who can reach the Worker.

## Gateway deployment

The monorepo separates `apps/executor` (Discovery, Code Mode and Google↔storage
transfers) from `apps/gateway` (MCP OAuth, Google grant custody and client URLs).
Each app owns its tests; root integration tests exercise their boundary. Run
`just` commands from the repository root. Existing local tests reuse their saved
desktop OAuth grant and root `.test.env`.

The intended gateway endpoint is `https://google-workspace.lachispa.dev/mcp`.
The browser flow verifies Cloudflare Access admission, asks for consent for the
particular MCP client, and links a Google account. It requires a **web OAuth
client** with callback `https://google-workspace.lachispa.dev/callback` in the
project's dedicated Google test project. The desktop client for `just oauth` is
separate. Google scopes are `openid`, `email`, `gmail.modify` and `drive.file`.

Hosts use MCP OAuth with resource `<GATEWAY_ORIGIN>/mcp` and scopes
`google-workspace offline_access`; they omit `accessToken`. The gateway rejects
credential overrides, refreshes the encrypted Google grant when the MCP token is
refreshed, and injects a short-lived Google token through the named `Executor`
service binding. The executor receives a stable verified caller/account owner
separately from tool arguments. Transport remains finite, sessionless revision
`2026-07-28`; other host revisions are not adapted.

The gateway owns `OAUTH_KV`, the web-client secret and R2 signing credentials.
The provider encrypts credential props and hashes host tokens/codes in KV. The
executor has `LOADER` and the temporary bucket, with no grant-store or signing
binding. Google media bodies stream directly between Google and R2 in the
executor. MCP and service calls carry references and metadata. Shared executor
access to recent artifacts and other in-flight access tokens remains an accepted
limitation; this is not full tenant isolation.

Provision existing resources before publishing, then configure deployment through
environment variables without changing the checkout:

| Variable                                                   | Purpose                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`            | Wrangler deployment identity; account ID also selects the R2 signing endpoint.                                                           |
| `GATEWAY_WORKER_NAME`, `EXECUTOR_WORKER_NAME`              | Optional names; default `google-workspace-gateway` and `google-codemode-mcp`.                                                            |
| `GATEWAY_ORIGIN`                                           | Canonical HTTPS OAuth origin; defaults to `https://google-workspace.lachispa.dev`.                                                       |
| `GATEWAY_DOMAIN`                                           | Optional custom hostname routed to the gateway.                                                                                          |
| `OAUTH_KV_NAMESPACE_ID`                                    | Existing gateway-only KV namespace.                                                                                                      |
| `ARTIFACTS_BUCKET`                                         | Existing private bucket bound to both apps.                                                                                              |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS` | Verified CFA issuer/audience and comma-separated admitted email addresses. Use the executor's own Access audience when deploying it.     |
| `GOOGLE_OAUTH_CLIENT_ID`                                   | Google **web** client ID.                                                                                                                |
| `ENVIRONMENT`                                              | Stable owner namespace; defaults to `development`.                                                                                       |
| `REQUIRE_ACCESS_ON_MCP`                                    | Defaults to `true`: CFA assertion plus MCP OAuth on machine calls. Set `false` only with the authorization-route policy described below. |

Install `GOOGLE_OAUTH_CLIENT_SECRET`, `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` as **gateway Worker secrets**, using Wrangler's native
`secret put`/`secret bulk` commands and the gateway configuration. The R2 S3
credential needs Object Read & Write limited to the temporary bucket. It is
separate from the Workers deployment token and never bound to the executor.
Namespace, bucket, lifecycle, DNS and Access provisioning are separate operations;
these deployment helpers do not grant administrative permissions or change billing.

```sh
# Export the settings above and install the gateway's Worker secrets first.
WORKER_NAME="$EXECUTOR_WORKER_NAME" CF_ACCESS_AUD="$EXECUTOR_CF_ACCESS_AUD" just deploy --dry-run
just deploy-gateway --dry-run
# After checking the generated bindings, publish the same configuration:
WORKER_NAME="$EXECUTOR_WORKER_NAME" CF_ACCESS_AUD="$EXECUTOR_CF_ACCESS_AUD" just deploy
just deploy-gateway
```

Both apps keep `workers.dev` and previews enabled. Configure Access for those
endpoints as well as the custom hostname. Browser authorization from an alias
redirects to the canonical origin before creating consent cookies. The checked-in
executor requires CFA admission on public HTTP and fails closed without its
issuer/audience/allowlist. Binding calls use trusted owner context independently.

**CFA route choice affects host compatibility.** The strict default also requires
an Access assertion on authenticated gateway calls. Native remote hosts generally
cannot send CFA browser cookies or custom service headers. For those hosts,
configure CFA on `/authorize` and `/callback`, let OAuth metadata, registration,
token and `/mcp*` requests reach the Worker, and set `REQUIRE_ACCESS_ON_MCP=false`.
CFA then gates grant issuance; MCP OAuth and the current email allowlist guard
every protected call. This alternative requires an explicitly selected Access
route policy. Neither source configuration nor a dry-run applies that policy.

### Client file transfers

Artifact reads in gateway mode require both the full reference and its verified
owner. Returned artifact resource links gain direct signed R2 download links;
manifest resources include `downloadUrl` and `downloadExpiresAt`. URLs expire
within ten minutes and no later than the artifact's expiry. CFA protects issuance;
redemption uses the URL alone. Keep these bearer URLs private.

An authenticated client can also POST to `/mcp/artifacts/download` with `{uri}`.
For uploads, POST `/mcp/artifacts/upload` with `{size,sha256,mimeType,name?}`. PUT
the file directly to the returned `uploadUrl` with the returned headers, including
its exact length and create-only condition. Then POST `{uri}` to
`/mcp/artifacts/complete`. The executor checks the stored length and hashes the
stream before committing an owner-bound v2 manifest. Only then can Code Mode use
`media.body:{artifact:uri}`. No file body travels through MCP or service RPC.
An interrupted completion can be reconciled with the same grant; Google writes
are never automatically replayed.

Upload grants last ten minutes; complete artifacts last one hour. Configure a
one-day lifecycle for `artifacts/` and abort abandoned multipart uploads as a
physical cleanup backstop. Expiry is enforced on reads; abandoned staging data
waits for lifecycle cleanup. Browser clients need bucket CORS permitting their
origin, PUT and the signed request headers. Host file presentation depends on
the particular client.

Local workerd tests exercise the actual OAuth provider's browser/PKCE/nonce and
refresh flow, two-worker ownership and credential isolation, file staging,
manifest validation and lost-response behavior. They do not establish real R2
signature redemption, deployed CFA policy, hosted Google consent or Claude,
ChatGPT/OpenClaw acceptance. Historical paid and hosted evidence below remains
qualified by its original source identity.

## Deploy the standalone executor to Cloudflare

Deployment requires Node 24 and a **Workers Paid plan** for the
[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/)
used by Code Mode. Executions incur Dynamic Worker creation, request, and CPU
usage. The checked-in configuration includes the `LOADER` binding; there are no
persistent sessions or Google OAuth secrets to provision on the Worker. Optional
artifact storage adds a private R2 bucket.

The deployment command below uses environment variables without editing
`apps/executor/wrangler.jsonc` or application source:

| Variable                   | Purpose                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`    | Target account; supply for unattended CLI/CI deployment.                                              |
| `CLOUDFLARE_API_TOKEN`     | Wrangler deployment credential; store as a CI secret. Local Wrangler login also works.                |
| `WORKER_NAME`              | Optional Worker name; defaults to `google-codemode-mcp`, or the Worker selected by Workers Builds.    |
| `WORKER_DOMAIN`            | Optional custom hostname, e.g. `mcp.example.com`; no scheme or path.                                  |
| `ARTIFACTS_BUCKET`         | Optional existing private R2 bucket; enables bounded artifact storage.                                |
| `ARTIFACT_DOWNLOAD_ORIGIN` | Optional HTTPS origin; enables read-only whole-file URLs from this Worker. Requires artifact storage. |
| `WORKER_ROUTE`             | Optional route pattern, e.g. `example.com/mcp*`; use instead of `WORKER_DOMAIN`.                      |

Use a token scoped to the target account with Workers Scripts edit permission
(the **Edit Cloudflare Workers** template). Custom domains/routes also need the
appropriate zone permissions, including Workers Routes edit and DNS access where
required. The hostname/zone must belong to the account.

```sh
npm ci --ignore-scripts
# Supply CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN through your environment.
export WORKER_NAME=my-google-mcp
export WORKER_DOMAIN=mcp.example.com  # optional
just deploy --dry-run                # Bundle to dist/ and validate; no upload
just deploy                          # Publish and configure the domain/route
```

The equivalent command without `just` is `node apps/executor/deploy.mjs`, optionally
with `--dry-run`. The helper maps settings to pinned Wrangler flags and keeps
Cloudflare credentials in the deployment process. `ARTIFACTS_BUCKET` generates a temporary Wrangler configuration with the R2 binding;
`ARTIFACT_DOWNLOAD_ORIGIN` and the CFA admission settings become Worker runtime variables. The remaining variables are deployment settings. Export them in the shell or configure them in CI build settings;
the helper does not load dotenv files.

The [ordinary hosted deployment check](apps/executor/tests/hosted/README.md#ordinary-environment-deployment-2026-11-06)
verified this path with an existing private R2 bucket, protected workers.dev
ingress and a reversible real Drive rename. Workers Builds and domain/route
variants retain separate qualification.

The development configuration keeps `workers.dev` and version previews enabled
alongside custom domains/routes. A custom-domain endpoint is `https://<domain>/mcp`.
A route must cover `/mcp`; a custom domain serves the Worker directly, while a
route requires existing proxied DNS/origin configuration. Protect every enabled
endpoint with Access. Production endpoint restrictions are a separate deployment choice.

The checked-in executor requires a valid human Cloudflare Access assertion and
current `ALLOWED_EMAILS` membership before serving public HTTP. Supply
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `ALLOWED_EMAILS` during deployment;
missing configuration denies access. `just dev` disables this gate only for local
Wrangler development. Gateway service-binding calls do not use public HTTP and
receive their owner context separately. A Google token is still an `accessToken`
tool argument on the standalone interface; an Authorization header does not fill it.

### Optional artifact storage

Set `ARTIFACTS_BUCKET` to an existing **private** R2 bucket to enable explicit
storage. The deploy helper preserves the checked-in configuration, adds the binding
in a temporary config, and removes that config afterward. No source edit, public
bucket, Google secret or persistent MCP session is needed. This does not create a
bucket or configure billing/lifecycle; provision those separately. Keep authenticated
ingress in place: a valid Google call before storage is an admission check, not a
per-person quota or caller identity.

Enable standalone whole-file downloads:

```sh
export ARTIFACTS_BUCKET=my-private-artifacts
export ARTIFACT_DOWNLOAD_ORIGIN=https://mcp.example.com
just deploy
```

Bounded v1 references and manifests then include a `downloadUrl` served by this Worker at
`/mcp/artifacts/v1/...`. GET or HEAD returns the complete file after size and SHA-256
verification. The URL grants read-only access until the artifact expires or is
deleted; it cannot authorize MCP reads or deletion. Keep URLs private. Leaving the
origin unset disables HTTP downloads while preserving MCP storage and reads.
The origin must be HTTPS with no credentials, path, query or fragment. It comes
from configuration, never the request Host header. The existing `/mcp*` route
covers downloads; route the configured origin to this Worker.

Cloudflare Access and other ingress policies still apply before the Worker. A
protected deployment requires its normal ingress credentials for downloads.
Operators choose ingress policy; this option does not create a public bypass.
The endpoint supplies a whole file independently of any gateway; native file
presentation in Claude, ChatGPT or OpenClaw remains host-specific and unqualified.
Range requests return the whole file; HTTP upload, delete, listing and resumable
transport are unavailable. Two direct hosted controls verified exact JSON/binary
downloads, HEAD, protected ingress, capability rejection and deletion. See the
[standalone download evidence](apps/executor/tests/hosted/README.md#standalone-artifact-downloads-2026-11-05)
for the tested candidate and limits.

Use `describe({path:'pagination'})` and its
[reference](apps/executor/skills/google-workspace/references/pagination.md) to collect bounded
Gmail or Drive list pages:

```js
const drive = google.drive({ version: 'v3' });
const result = await pagination.collect(
  drive.files.list,
  {
    pageSize: 100,
    fields: 'nextPageToken,incompleteSearch,files(id,name)',
  },
  { maxPages: 5, maxBytes: 200000 },
);
return { ...result, pages: result.pages.map((page) => ({ files: page.files })) };
```

Inspect `exhausted`, `stoppedBy`, `resumePageToken` and `incompleteSearch` before
claiming completeness. A cap preserves a whole-page continuation; native errors
retain `.partial` without retry. For large results, store the bounded result with
`artifacts.putJson` when enabled. Existing native single-page calls are unchanged.

Use `describe({path:'artifacts'})` and read
`skill://google-codemode-mcp/google-workspace/references/artifacts.md`. After an
acknowledged native Google call, top-level code can explicitly store JSON or a byte
envelope with `artifacts.putJson(value,{name})` or
`artifacts.putBytes(envelope,{name})` and return its small reference. Later code can
read or delete using the complete URI. Snippets cannot access storage helpers.
Native JSON/inline response limits remain hard. With R2 enabled, native Drive media
downloads use the separate [streamed reference path](#compose-gmail-and-drive-attachments).
V2 streamed references expose metadata resources but no executor-generated
`downloadUrl`; gateway-issued direct client URLs remain future integration.

Artifact URIs are random bearer capabilities: possession grants access and sharing
delegates it. They are not bound to a stable user or Google token. Base URIs read as
small manifests, with bounded byte-chunk resource URIs for exact reassembly/hash
verification. Trusted stored references appear as MCP resource links. Keep full
URIs private; host retrieval does not prove a downloadable host file. Claude Code
2.1.318 saved two binary resource chunks whose combined bytes/hash matched a
98,304-byte artifact in a deterministic local probe. It omitted chunk metadata;
use the manifest and byte offsets as described in the artifact guide. This proves
native fragment persistence, with no model or real Google calls, rather than
whole-file assembly or downloadable-file presentation.

Access expires after one hour; physical R2 deletion requires a separately configured
bucket lifecycle. Explicit delete, logical expiry and eventual physical cleanup are
different operations. Separate storage receipts retain partial/unknown effects
without changing acknowledged Google outcomes. Actual workerd/Miniflare R2 proof covers large native JSON beyond the inline output
limit, cross-request/new-Worker reads, all byte values at the 128 KiB bound, exact
chunk reassembly/hash, deletion, strict JSON and retained Google acknowledgements
after storage failure. Core fault controls cover quotas, expiry, wrong capabilities
and late writes. Four local Sonnet/Sol artifact attempts passed on their retained
candidate. Two later no-model hosted controls verified full JSON/binary content,
resource reads and deletion; JSON also survived redeployment. See the
[hosted storage evidence](apps/executor/tests/hosted/README.md#hosted-artifact-storage-2026-11-05)
for candidate identities and limits. Physical lifecycle execution and host
downloadable-file presentation remain unqualified.

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
| Deploy command    | `node apps/executor/deploy.mjs`                                                         |
| Preview builds    | Disable for this initial setup; preview deployment/protection is unqualified.           |

If an existing Workers Builds configuration uses `node .github/deploy.mjs`, update
its Deploy command to `node apps/executor/deploy.mjs` when adopting this layout.

Workers Builds supplies its account/deployment credential. Do not add the Gmail
test OAuth secrets to Builds or the deployed Worker. Build variables are available
only during the build/deploy process; putting `WORKER_DOMAIN` in runtime Variables
& Secrets will not configure deployment.

The helper follows the dashboard's selected Worker name. An explicit `WORKER_NAME`
must match it. Wrangler's injected account/Worker identity checks are preserved;
the helper passes the selected name so a name mismatch does not trigger Wrangler's
config-name correction warning. A generated configuration is used only when
ARTIFACTS_BUCKET selects optional storage, then removed after deployment.

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

The [hosted verification harness](apps/executor/tests/hosted/README.md) prepares a separate
private Worker with fixed synthetic probes, then checks its exact deployed
version through an existing protected ingress. Run `just hosted-prepare OUTPUT`
without credentials; after deployment, `just hosted-verify OUTPUT` uses the
documented `HOSTED_*` environment settings. It checks native CPU termination,
the 15-second asynchronous timeout, late-call fencing, multiple bridge calls and
healthy follow-ups. Local tests cover these paths except hosted CPU enforcement.
Harness version 2 also verifies synthetic lost-response writes and subsequent
write fencing, acknowledged effects retained after program failure, and hosted
network/credential isolation. Its [17-request hosted qualification](apps/executor/tests/hosted/README.md#hosted-mutation-and-isolation-2026-11-06)
uses no real Google writes or inference; live Google failure semantics remain separate.
An external timeout or generic resource error cannot pass the CPU criterion.
The qualified run observed the native `Worker exceeded CPU time limit.` exception;
see the [hosted result and its limits](apps/executor/tests/hosted/README.md#qualified-hosted-run-2026-11-04).

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
alternatives, source/revision, transport support, and documentation links. Results
start with the callable signature, execution limits, and discovery guidance so
these remain visible when a host previews only the start of a large response.
The complete native metadata, schemas, and declarations follow in the same result.
Methods come from Google's Discovery document; there is no handwritten method catalog.
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
below. Bounded Drive create uploads and optional artifact storage are described below. Scope availability for opaque tokens is
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
limit. Without R2, `files.get({fileId: inputs.id, alt: 'media'})` returns `.data` as
`{encoding: 'base64', data, size, mimeType, sha256}`. `data` is standard base64;
`size` and SHA-256 describe the original bytes, including arbitrary binary files.
`files.export` uses this envelope directly, with a discovered export MIME type.
Downloads are limited to **131072 raw bytes** and the execution's overall output
limit still applies. Metadata reads retain Google's normal JSON `.data` shape.
The host decodes the bytes when saving a file; optional R2 artifacts provide a
streamed reference path when enabled. Gmail attachments continue to use Google's native base64url JSON fields.

### Compose Gmail and Drive attachments

With private artifact storage enabled, native Drive media downloads return an opaque artifact reference
instead of inline bytes. Upload the stored content directly, keeping filenames
and destination metadata in JavaScript:

```js
const drive = google.drive({ version: 'v3' });
const { data: file } = await drive.files.get({ fileId: inputs.id, alt: 'media' });
const { data: copy } = await drive.files.create({
  requestBody: { name: inputs.name, parents: [inputs.folderId] },
  media: { mimeType: file.mimeType, body: { artifact: file.uri } },
});
await artifacts.delete(file.uri);
return copy;
```

The storage path allows up to 64 MiB per file and 128 MiB of transferred bytes
per execution (a download followed by upload counts twice), one transfer at a time.
R2 writers buffer at most one 5 MiB part and admit two writers per isolate.
Artifacts expire after one hour; manifests become readable only after data commits.
Only references cross the sandbox/MCP boundary, with separate storage outcomes.
`artifacts.readBytes(uri)` deliberately limits inspection to 128 KiB.
The existing 15-second call/execution deadlines include storage and can limit
practical file size below the byte cap. Synthetic Miniflare controls cover a
33 MiB round trip for known/unknown lengths, source interruption, cancellation,
cleanup and lost-response mutation fencing; live/hosted large-file support and
new paid-agent feasibility remain unqualified.
It does not introduce gateway authentication, client URL signing or large Gmail
MIME composition. The existing inline byte path remains available without R2.

Read `skill://google-codemode-mcp/google-workspace/references/media-transfers.md`
for executable transfers and discover the native methods before execution.
`drive.files.create` accepts native `requestBody` metadata plus
`media: {mimeType, body: {encoding, data, size?, sha256?, mimeType?}}`.
The body accepts canonical base64 or base64url and checks optional integrity
assertions. Pass Gmail attachment bodies directly, transform names in JavaScript,
and set native `parents` to choose a Drive folder. Downloads can be forwarded in
the same way without a host-side intermediate file.

Inline uploads allow 131072 decoded bytes per file, 1048576 per execution, 65536 bytes
of metadata and 262144 multipart wire bytes. Every native call has a 2097152-byte
serialized parameter limit. Existing call, output, time and download caps apply.
Media-only, update-media, conversion and resumable uploads remain unsupported.
The trusted host verifies the SDK multipart body and restores a missing closing
boundary caused by workerd's stream polyfill; other wire differences are refused.

For the reverse direction, describe the pure `composeMime` snippet and pass Drive
byte envelopes as attachments. It returns Gmail base64url `raw` for a native
`users.drafts.create` call. It handles nested MIME encoding and Unicode filenames;
it makes no Google calls and is not exposed as another tool. See the advanced
reference for its input limits. Draft verification does not require sending mail.

`just live-media` runs three deterministic real-account controls: Gmail to Drive,
Drive blob to Gmail draft and native-document export to Gmail draft. The manual
paid gate is `just eval-media PROXY_URL NEW_ABSOLUTE_OUTPUT all required`: two
cases × Sonnet/Sol, one attempt each, at most four $1 estimates. Both use the
existing Gmail/Drive grant. Cleanup deletes only fixture-created and trusted
acknowledged create IDs, preserves uncertain folders and reports associated
unowned objects instead of deleting them. Neither command qualifies durable
artifacts, hosted media or host activation.

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
1 MB per native JSON response (bounded during reading), 64,000 characters each for code
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

Edit [apps/executor/snippets.config.ts](apps/executor/snippets.config.ts) to import bundled or project-owned
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
[apps/executor/skills/google-workspace/SKILL.md](apps/executor/skills/google-workspace/SKILL.md). It is also a
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
[versioned results](apps/executor/tests/eval/README.md#independent-gmail-cases-with-grading-version-2-2026-11-04).
The first prospectively frozen unused-case assessment also passed all four
Sonnet/Sol cells: content-selected Gmail labelling and Drive renaming, with strict
discovery, actual skill retrieval and clean independent readback/cleanup. See
[assessment and usage metrics](apps/executor/tests/eval/README.md#first-frozen-unused-case-assessment-2026-11-06).
This is same-author feasibility evidence; it does not establish blindness or
reliability, and later tuning requires another unused evaluation partition.
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
[Drive qualification and limits](apps/executor/tests/eval/README.md#drive-pagination-and-conditional-write-boundary-2026-11-05).
The current local Drive matrix passes all eight required cells: four cases each
for Sonnet and Sol, on one product bundle. Method descriptions now put execution
guidance before large native metadata so Claude's truncated preview retains it.
The grader remains unchanged. Conditional case 3 uses independent outbound
recording plus the complete ledger and metadata/content checks; native versions
are diagnostic. All fixtures were cleaned, with no unknown effects.
Earlier version-guard and discovery failures remain retained. Hosted conditional
attempts stop before inference because independent recording is local. This is
one-attempt-per-cell feasibility, with hosted Drive and target-host activation
still unqualified. See [results and token/cache/cost metrics](apps/executor/tests/eval/README.md#current-candidate-drive-completion-2026-11-05).
Gmail/Drive media composition now passes all four local Sonnet/Sol cells, with
68/68 criteria and complete fixture cleanup. Three independent live controls
also pass, including native-document export. Agents retrieved the advanced skill
resource and discovered every used method before execution. See the
[media results and token/cache/cost metrics](apps/executor/tests/eval/README.md#media-composition-results-2026-11-05).
Optional artifact storage has local R2/workerd proof, four passing local
Sonnet/Sol attempts, and two passing no-model hosted storage controls. Each result
qualifies its retained candidate; see the [artifact agent results](apps/executor/tests/eval/README.md#artifact-agent-acceptance-2026-11-05)
and [hosted storage evidence](apps/executor/tests/hosted/README.md#hosted-artifact-storage-2026-11-05).
Hosted media composition, physical lifecycle execution and target-host activation
remain unqualified.
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

For change delivery, use the [project verifier](.agents/skills/google-codemode-verify/SKILL.md)
and its [case/evidence selection procedure](.agents/skills/google-codemode-verify/references/change-verification.md).
Select existing checks by affected behavior, reuse applicable retained evidence,
and run fresh paid cells only for unresolved agent behavior. `just check` qualifies
its deterministic checks; agent and hosted acceptance remain separate.

Test suites and infrastructure live under `apps/executor/tests/`: `unit/` for isolated checks,
`integration/` for Worker, HTTP, CLI and runner checks, `live/` for credentialed
Google checks, and `fixtures/`, `support/`, `eval/` and `hosted/` for their helpers.
`.github/` contains GitHub workflows and repository-secret installation. Local
workflow launchers live in `apps/executor/tests/`; the deployment entrypoint is `apps/executor/deploy.mjs`. Commands are
exposed through `justfile`; there is no project `scripts/` directory or npm task
layer. Requires Node 24, Docker, `act`, `just`, and `gh` for secret installation.
GitHub and local checks invoke `apps/executor/tests/run.mjs` directly.

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
[report contract](apps/executor/tests/eval/README.md#generated-run-reports).

To consume selected saved agent acceptance, use
`just eval-verify SAVED_EVIDENCE NEW_REPORT_DIRECTORY`. It writes the same report
and exits nonzero for failed, incomplete or synthetic evidence. It does not
establish equivalence to the current checkout; inspect relevant source receipts
and environment before reusing a result. Probe/reference score failures retain
their informational role; missing billing/cache telemetry stays unknown.

The Gmail case requires discovery, retrieval of the server's `skill://` resource,
reading and replying to an email, applying a label, and saving its attachment.
Independent Google readback and exact file bytes determine success. The actor
cannot access credentials, graders, or expected results. Each trial retains its
trace, model/cache usage, criteria, and fixture cleanup receipt outside the checkout.
Limits include five minutes, 18 model requests, 15,000 output tokens reserved
conservatively, and a $1 estimate per cell (native CLI for Claude, recorded published
token rates for GPT). Estimates are separate from actual proxy billing. There are no performer retries or automatic model fallbacks.

Gmail, Drive and their two-case media-composition profile are implemented.
`just eval-artifacts PROXY_URL NEW_OUTPUT all required` exercises large native JSON
and binary attachment storage through local Miniflare R2: two cases × Sonnet/Sol,
up to four $1 estimates. It checks full content before actor deletion, later reads,
unchanged sources and cleanup; hosted retention and native host file delivery
remain separate qualifications.
Sheets, Docs, and Calendar remain pending
coverage targets; selecting them fails before model spending. This is a synthetic
feasibility check, not acceptance of every host or service. See the
[gate documentation](apps/executor/tests/eval/README.md) for isolation, usage accounting,
offline regrading, and manual GitHub setup.

The first matrix completed all task outcomes with Sonnet, Terra, and Haiku, but
all three failed the full discovery/skill gate. Sonnet and Haiku skipped method
discovery; Terra skipped root discovery and the skill resource. Luna exhausted
18 turns without completing the task, stopping the campaign before Opus/Sol.
All attempted cells cleaned up successfully with no unknown mutations. The
[gate results](apps/executor/tests/eval/README.md#first-model-matrix-2026-11-04) retain these
failures, observed cache counters, estimates, and the unattempted cells.

Under the earlier grading version, each required model had one passing attempt: Sonnet after fixing
instruction handoff and clarifying product guidance; Sol after additionally fixing
conservative budget settlement. Both completed the Gmail task, discovery, skill
retrieval, and cleanup with zero unknown mutations. These are separate harness
candidates, not a fresh pair pass or a reliability claim. The earlier failed pair
remains retained. See the [qualified results](apps/executor/tests/eval/README.md#sol-validation-with-accounting-version-2-2026-11-04)
for cost/cache evidence and the earlier method criterion's coverage limits. The
current grader requires every used method to be described before execution; the
[independent case results](apps/executor/tests/eval/README.md#independent-gmail-cases-with-grading-version-2-2026-11-04)
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
