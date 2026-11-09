# Deploy Google Workspace Code Mode

Run deployment commands from the repository root with Node 24. Cloudflare
**Workers Paid** is required for the Dynamic Worker Loader (`LOADER`). R2, Access,
DNS and KV provisioning are separate from publishing a Worker. A dry run validates
bundling and configuration; it does not prove live admission or host compatibility.

## Gateway and executor

`apps/gateway` owns MCP OAuth, encrypted Google grants in `OAUTH_KV`, the web-client
secret and R2 URL-signing credentials. It injects a short-lived Google access token
and verified owner context through the executor service binding. `apps/executor`
owns Discovery, Code Mode and direct Google↔temporary-storage transfers. It has
`LOADER` and the bucket, with no refresh-store or signing binding. Stored-reference
transfers keep file bytes outside MCP and the gateway/executor RPC.

The executor can access recent objects in its shared bucket and other in-flight
short-lived tokens. This is an accepted isolation limit. Refresh credentials and
signing keys remain isolated in the gateway.

The existing development endpoint is `https://google-workspace.lachispa.dev/mcp`.
For another deployment, choose its own canonical HTTPS origin. Create a Google
**web OAuth client**, enable Gmail and Drive APIs, and register
`<GATEWAY_ORIGIN>/callback`. The desktop client used by local test commands is
separate. The gateway requests `openid`, `email`, `gmail.modify` and `drive.file`.
Drive file scope covers files created by or explicitly shared/opened with that
OAuth application, not every file in the account.

Hosts authorize the resource `<GATEWAY_ORIGIN>/mcp` with scopes
`google-workspace offline_access`. They omit the `accessToken` tool argument; the
gateway injects it and rejects caller credential/owner overrides. Owner context
binds verified Access identity, Google account and environment across rotation.
Transport remains finite, sessionless MCP revision `2026-07-28`.

## Provision and configure

Use an account-scoped Workers Scripts edit credential (the Workers Editor
template) for ordinary deployments to existing resources. Provisioning Access,
KV, R2, DNS or routes requires the corresponding additional rights; do not retain
bootstrap permissions merely to redeploy. Custom domains/routes also need the
appropriate zone permissions. The gateway's bucket-limited S3 Object Read & Write
credential is separate from the deployment token.

| Setting                                                    | Purpose                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`            | Wrangler identity; account ID also selects the R2 endpoint                                      |
| `GATEWAY_WORKER_NAME`, `EXECUTOR_WORKER_NAME`              | Optional names; defaults `google-workspace-gateway`, `google-codemode-mcp`                      |
| `GATEWAY_ORIGIN`                                           | Canonical HTTPS OAuth origin; default `https://google-workspace.lachispa.dev`                   |
| `GATEWAY_DOMAIN`                                           | Optional gateway custom hostname                                                                |
| `OAUTH_KV_NAMESPACE_ID`                                    | Existing gateway-only KV namespace                                                              |
| `ARTIFACTS_BUCKET`                                         | Existing private temporary bucket bound to both apps                                            |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_EMAILS` | Access issuer, app audience and comma-separated admitted emails; executor uses its own audience |
| `EXECUTOR_CF_ACCESS_AUD`                                   | Executor Access audience; passed as `CF_ACCESS_AUD` to executor deployment                      |
| `GOOGLE_OAUTH_CLIENT_ID`                                   | Google web-client ID                                                                            |
| `ENVIRONMENT`                                              | Stable ownership namespace; default `development`                                               |
| `REQUIRE_ACCESS_ON_MCP`                                    | Default `true`; see native-host policy below                                                    |

Install `GOOGLE_OAUTH_CLIENT_SECRET`, `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` as gateway Worker secrets using Wrangler `secret put` or
`secret bulk` with the gateway configuration. Never bind these to the executor.
Deploy helpers use environment variables without loading dotenv files or editing
the checkout. They generate temporary binding configuration when needed.

```sh
npm ci --ignore-scripts
# Export the settings above; install gateway secrets before publishing.
WORKER_NAME="$EXECUTOR_WORKER_NAME" CF_ACCESS_AUD="$EXECUTOR_CF_ACCESS_AUD" just deploy --dry-run
just deploy-gateway --dry-run
# Inspect both generated configurations, then publish executor before gateway.
WORKER_NAME="$EXECUTOR_WORKER_NAME" CF_ACCESS_AUD="$EXECUTOR_CF_ACCESS_AUD" just deploy
just deploy-gateway
```

Both apps keep workers.dev and version previews enabled for development. Protect
every enabled custom, workers.dev and preview endpoint. Public executor HTTP
requires a human Access assertion and current allowlist membership; missing
configuration fails closed. Binding calls carry trusted owner context separately.
`just dev` disables this executor gate only for local Wrangler development.
Production endpoint restrictions are a separate deployment choice.

## Access policy for native hosts

The strict gateway default requires CFA admission plus MCP OAuth on machine calls.
Native remote hosts generally cannot send CFA browser cookies or service headers.
The deployed native-host policy gates `/authorize` and `/callback` with CFA, lets
OAuth metadata/registration/token and `/mcp*` reach the Worker, and sets
`REQUIRE_ACCESS_ON_MCP=false`. MCP OAuth plus the current email allowlist then
protect each machine call. Apply the selected policy in Cloudflare Access; a
source setting or dry run does not configure it. Authorization from aliases
redirects to the canonical origin before consent cookies are created.

## Temporary artifacts and direct transfers

Keep R2 private. Configure a one-day object-age lifecycle on **`artifacts/`**,
covering v1/v2 data, manifests and abandoned uploads, plus an abort rule for
incomplete multipart uploads (the test account uses seven days). Logical artifact
expiry is one hour and enforced on reads. It is distinct from eventual physical
cleanup. The corrected test-bucket rule and automatic disappearance of two owned
v1/v2 fixtures were verified on 2026-11-09; see
[#11](https://github.com/marcfargas/google-codemode-mcp/issues/11). That bounded
observation does not establish an exact deletion time or every object category.

Gateway download links are short-lived signed R2 URLs, issued only after owner
checks. They expire within ten minutes and no later than the artifact. CFA protects
issuance; transfer redemption uses the signed URL alone. Never forward MCP
authorization or CFA headers to R2. Keep URLs and full artifact handles private.
For browser uploads configure bucket CORS for the chosen origin, PUT and exact
signed headers.

Agents request grants and completion through the authenticated `artifact_upload`
tool. Other authenticated clients can POST JSON to these routes:

| Route                     | Body                           |
| ------------------------- | ------------------------------ |
| `/mcp/artifacts/download` | `{uri}`                        |
| `/mcp/artifacts/upload`   | `{size,sha256,mimeType,name?}` |
| `/mcp/artifacts/complete` | `{uri}`                        |

PUT bytes directly to `uploadUrl` with exactly the returned headers, length and
create-only condition. Upload grants last ten minutes. Completion verifies stored
length/hash before committing an owner-bound v2 manifest. A lost completion can be
reconciled with the same grant; Google writes are never automatically replayed.
The [artifact cookbook](apps/executor/skills/google-workspace/references/artifacts.md)
and [media recipes](apps/executor/skills/google-workspace/references/media-transfers.md)
are also served through MCP Resources for agents.

## Downstream token lifecycle

The gateway refreshes the encrypted Google grant when the MCP client refreshes
its token. Transient Google errors preserve the grant; terminal `invalid_grant`
tears it down. Public OAuth clients (`token_endpoint_auth_method=none`) revoke
a downstream grant by POSTing form fields `client_id`, `token` and
`token_type_hint=refresh_token` to `/oauth/token`, omitting `grant_type`.
Confidential clients also use their configured token-endpoint authentication.
`token_type_hint=access_token` revokes that access token while leaving others
intact. Downstream revocation does not revoke Google consent.

Actual-provider local controls cover rotation, resource/client binding, temporary
error recovery and revocation. KV propagation means these do not prove
instantaneous global revocation. Remaining hosted and native-host acceptance is
tracked in [#5](https://github.com/marcfargas/google-codemode-mcp/issues/5).

## Standalone executor

A trusted caller can deploy the executor alone and inject a short-lived Google
token through the `accessToken` tool argument. It does not acquire or refresh
durable Google credentials. Caller arguments are visible to the submitting host;
keep injection in trusted code and protect ingress. An Authorization header does
not populate that argument.

| Setting                    | Purpose                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `WORKER_NAME`              | Optional name; default `google-codemode-mcp`, or the selected Workers Builds name |
| `WORKER_DOMAIN`            | Optional custom hostname without scheme/path                                      |
| `WORKER_ROUTE`             | Optional route pattern; use instead of `WORKER_DOMAIN`                            |
| `ARTIFACTS_BUCKET`         | Optional existing private bucket                                                  |
| `ARTIFACT_DOWNLOAD_ORIGIN` | Optional HTTPS origin enabling bounded v1 whole-file links                        |

Supply deployment identity and CFA settings from the common table. A custom
domain serves the Worker directly; a route requires existing proxied DNS/origin
configuration and must cover `/mcp`.

```sh
export WORKER_NAME=my-google-mcp
export WORKER_DOMAIN=mcp.example.com
just deploy --dry-run
just deploy
```

`node apps/executor/deploy.mjs` is the equivalent entrypoint. With storage and
`ARTIFACT_DOWNLOAD_ORIGIN`, v1 manifests expose GET/HEAD links under
`/mcp/artifacts/v1/...`, verified by size/hash before return. Ingress admission
still applies. The configured origin must be HTTPS with no credentials, path,
query or fragment. Without it HTTP downloads are disabled. Range requests return
the whole file; this endpoint has no upload/delete/listing or resumable support.
V2 references use gateway-issued URLs and have no executor chunk/download route.
See [standalone hosted controls](apps/executor/tests/hosted/README.md#standalone-artifact-downloads-2026-11-05).

## Bundled snippets and Skills

Configure bundled snippets in [apps/executor/snippets.config.ts](apps/executor/snippets.config.ts).
Wrangler bundles imported modules; there is no runtime installation API. Each
`SnippetDefinition` supplies `name`, `description`, async function-body `code`,
JSON `inputSchema`, required `services`/`scopes`, and optional `readOnly` or
`tool:{name,description?}`. Trusted dispatch enforces service/read-only restrictions,
including nested snippets; scopes remain requirements, not grants.

Agents discover descriptors with `describe({path:'snippets'})`, then invoke
`snippets.run(name, inputs)` in Code Mode or the configured exposed tool.
The [Workspace skill directory](apps/executor/skills/google-workspace/SKILL.md)
is served through MCP Resources and the Skills extension. Publishing it does not
establish automatic Skills activation in a particular host.

## Workers Builds and deployment evidence

Workers Builds is a supported configuration path awaiting actual qualification
([#6](https://github.com/marcfargas/google-codemode-mcp/issues/6)). Connect the
repository in Cloudflare with repository-root working directory, branch `main`,
`NODE_VERSION=24`, `SKIP_DEPENDENCY_INSTALL=1`, build command
`npm ci --ignore-scripts`, and deploy command `node apps/executor/deploy.mjs`.
Gateway deployments use `node apps/gateway/deploy.mjs` with their own bindings.
Builds supplies its deployment identity. An explicit Worker name must match the
dashboard-selected one. Never add local Gmail test credentials to Builds.
Enable previews only with verified admission; the development configuration keeps
them enabled. Deploy helpers neither provision Access nor change billing.

The [hosted verification record](apps/executor/tests/hosted/README.md) retains
exact candidates, deployment versions, ingress, synthetic runtime and real Google
controls. An ordinary environment-driven deployment and paired gateway/executor
ingress passed; this does not qualify every domain/route or build variant. The
deploy button and stdio wrapper remain future features (#20/#21).

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
