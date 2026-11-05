# Hosted executor verification

This harness prepares a separate private Cloudflare Worker that imports the production executor, dispatcher and MCP handler. It runs fixed programs with a synthetic Discovery document and an in-memory GET transport. It never refreshes OAuth, contacts Google, sends mail, mutates user data, or adds a route to the production Worker.

The maintained runner requires an Access-protected HTTPS `/mcp` endpoint. The
safe default has `workers_dev: false`, `preview_urls: false`, and no routes. A
prepared bundle therefore has no public ingress. For the dedicated test Worker,
install the runner-only Worker-level Access application below before enabling
its `workers.dev` endpoint. An existing authorized private-binding ingress remains
usable; this procedure does not create an additional gateway.

## Deployment permissions and runner access

Use one selected Cloudflare account with the required Workers Paid plan. Provide
its account ID separately as `CLOUDFLARE_ACCOUNT_ID`; deploy authentication uses
`CLOUDFLARE_API_TOKEN`. These credentials are separate from the Access credential
used to invoke tests.

| Operation                                                               | Required authority                                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Deploy an existing test Worker                                          | Workers **Editor**, scoped to that individual Worker                                                                       |
| Initially create the Worker                                             | Workers **Admin** at Workers product scope, in the selected account; bootstrap authority only                              |
| Create the Access app and policy                                        | Account **Access: Apps and Policies Write** (also labelled Edit in some token interfaces)                                  |
| Create the runner service token                                         | Account **Access: Service Tokens Write** (also labelled Edit)                                                              |
| Add or change a custom route/domain, if selected instead of workers.dev | Worker authority plus **Workers Routes Write** on the selected zone; any required DNS changes use separate setup authority |

The steady deployment token needs no Access administration, Google, KV, R2 or D1
rights. Selecting `workers.dev` avoids zone/DNS provisioning permissions. Worker
creation and Access setup can be performed by a separate bootstrap custodian;
keep that broader token out of the invoking runner. Some token interfaces still
show the older account-wide `Workers Scripts Edit` permission: do not assume it
is scoped to one Worker. Read back the issued token's actual resource scope and
prove the first deployment before claiming least-privilege qualification.

[access-application.json](access-application.json) is the proposed Cloudflare
`POST /accounts/{account_id}/access/apps` body. Copy it outside the checkout and
replace the two IDs with the actual test Worker ID and dedicated Access service
token ID. They are resource IDs, not the token's Client ID or Client Secret. The
`worker` destination protects production and preview URLs of this one Worker;
`preview_worker` would leave its production endpoint unprotected. The only policy
is Service Auth (`non_identity`) including exactly that service token. Keep other
Allow, Bypass, Everyone, any-service-token and tag-based alternatives absent.
The template is not applied automatically. The dated hosted run below used its
resolved Worker and service-token IDs and independently checked live admission.

The runner sends the standard `CF-Access-Client-Id` and
`CF-Access-Client-Secret` pair through private `HOSTED_ACCESS_HEADERS_JSON`.
It receives no deployment or Access administration API token. Use a bounded
service-token expiry and deliver/store its secret only through the selected
private credential path. This restricts access to holders of the runner credential.
If requests must originate physically from marcdev, add and verify a supported
source-network/device constraint; the header pair alone cannot attest a machine.

Provision and verify in this order:

1. Create only the dedicated test Worker, retaining its default disabled public
   ingress. Record its native Worker ID; do not substitute its deployment version
   ID or an unrelated production Worker.
2. Create the dedicated service token and the Worker-level Access app from the
   template. Read back the destination and every attached policy. Inspect
   hostname/path applications and overrides too: a more-specific hostname/path
   Access rule takes precedence over Worker-level protection. Do not change the
   shared account's default Access policies or strict-mode settings for this test.
3. Only after protection is confirmed, copy the retained prepared deployment
   config to another retained file, enable `workers_dev`, and keep previews
   disabled and routes absent. Retain that exact config and its hash alongside
   the prepared manifest and deployment receipt; the source digest identifies
   source/bundle bytes, not Access policy or routing state. Deploy that config.
4. Before CPU/stress probes, verify missing headers, each header alone, an invalid
   pair, the correct Client ID with a wrong secret, and an unrelated valid service
   token cannot reach the verification Worker. Accept edge `401`/`403`, or a
   verified Access login redirect for older organizations, as denial evidence;
   a generic failure from the Worker is insufficient. Retain sanitized edge
   status/request IDs, without response cookies or credentials.
5. Verify the correct token reaches the expected candidate/version identity and
   audit alternate routes, domains and preview URLs for bypass. Retain sanitized
   Access/routing readback and deployment receipts before running the fixed
   probes below. Current `hosted-verify` grades runtime probes; it does not itself
   provision or qualify the Access policy or automate these denial checks.

Worker-level Access supports this finite POST protocol; it currently does not
support WebSocket upgrades. Cloudflare's documented raw API supports Worker
`destinations` without a hostname; some generated client schemas still require
`domain`. Use the documented API shape and inspect actual readback rather than
inventing a custom domain to satisfy a client schema.

See [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/),
[Worker-level Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
[API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/),
and [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Qualified hosted run (2026-11-04)

The retained source candidate from commit `75c8d6549b186f29833cd0831c3b21bf0b18a07e`
was prepared with source digest
`8bb8eb1316553097ce3cebc4e29092dc34449aa3bd526841a3c6759e0391fa45`
and deployed as platform version `0a0ec053-47a7-469a-bae7-1feef622a7d3`.
The prepared bundle, deployment config, native deployment readback, identity reply,
and every runtime receipt were checked together. All 11 planned runtime requests
passed, including healthy follow-ups.

The native dynamic Worker threw `Worker exceeded CPU time limit.` under its
configured 1,000 ms budget. This qualifies CPU enforcement without deriving exact
CPU usage from wall time. The 15-second asynchronous timeout and observation
window, delayed/unawaited dispatch fences, and five sequential synthetic bridge
reads also passed. No Google, OAuth or model requests occurred.

Live Access readback showed one Worker destination and one Service Auth policy
including exactly the runner credential, with no overlapping applications. Six
negative credential cases were denied with 401/403; the correct credential
returned the expected candidate/version. Two version-preview URLs returned 404,
previews were disabled, and no custom domains were attached. The unrelated
service token created for denial verification was deleted and its local secret
removed. The retained runner token expires on 2026-12-04; later rotation needs
Access administration through the selected owner path.

This proves the synthetic verification candidate and Access admission. It does
not deploy the live Google product or qualify its gateway binding, Google tasks,
or host Skills activation. Deployment with only Worker Editor was subsequently verified as described below.
Bootstrap Workers Admin and Access rights are no longer needed for the existing
resources or invoking these tests.

A subsequent redeployment succeeded with the owner's reported non-Admin,
Worker-scoped Editor configuration, which retained Access permission entries.
Version `b4013671-7b58-4dbc-97db-eb05d95afd2d` served the same retained bundle at
100%; identity matched, missing credentials returned 403 and a wrong secret
returned 401. Access application/policy reads returned 403 with that token.
Token-policy introspection was unavailable, so this proves the supplied reduced
configuration works, rather than a credential containing only Editor. The 11
runtime probes above retain their original version identity; stress was not
repeated for this deployment.

After the owner removed the remaining Access permission entries, another
redeployment succeeded with only the owner-confirmed Worker-scoped Editor grant.
Version `fb61d70b-1c5c-4e65-9116-c272aac199a8` served the same retained bundle at
100%; missing credentials returned 403, a wrong secret returned 401, and the
runner credential returned matching identity with 200. Previews remained disabled.
This verifies deployment with that supplied credential; token-policy introspection
remains unavailable. No additional runtime stress probes were needed.

## Prepare without deployment

Run from the checkout with installed pinned dependencies:

```sh
just hosted-prepare /absolute/new/prepared-evidence
```

Preparation runs Wrangler's dry run and writes the deployable `worker.js`, `wrangler.json`, `manifest.json`, and `prepare.log` into a new directory outside the checkout. The manifest includes the Git revision, hashes of the actual production and harness source files plus package lock, and the exact bundle hash. Dirty source bytes are therefore represented. The generated config deploys the retained bundle with `no_bundle: true`, binds its source digest, and preserves the default private routing configuration and platform version metadata binding. Use the separately retained config procedure above to enable only the protected test endpoint. Preparation does not authenticate or deploy.

After the owner has selected an account and authorized deployment, the prepared config is the deploy input:

```sh
node_modules/.bin/wrangler deploy --config /absolute/prepared-evidence/wrangler.json
```

Use the project's authorized Cloudflare credential delivery path. Record the resulting platform version ID and deployment output with the prepared manifest. Do not replace a production Worker or reuse another project's test credentials. Source edits require a new preparation directory and newly deployed candidate. The deployed digest is self-reported configuration, so retain the actual deployment receipt linking the prepared bundle to the platform version; a digest alone is not independent deployment provenance.

## Run once against the selected hosted version

Supply these through the private process environment, never a tool's arguments, chat text, committed files, or command-line authentication flags:

- `HOSTED_VERIFICATION_URL`: the authorized protected HTTPS `/mcp` endpoint, without query credentials.
- `HOSTED_ACCESS_HEADERS_JSON`: a nonempty JSON object containing the existing ingress's authentication headers.
- `HOSTED_EXPECTED_CANDIDATE_DIGEST`: the prepared manifest's `sourceDigest`.
- `HOSTED_EXPECTED_WORKER_VERSION`: the platform version ID from the deployment receipt.
- `HOSTED_PREPARED_DIR`: the absolute retained preparation directory.

```sh
just hosted-verify /absolute/new/hosted-evidence
```

The runner validates the retained source-manifest and bundle hashes, then sends finite MCP revision `2026-07-28` POSTs with a synthetic token. Only fixed probe names are accepted; arbitrary JavaScript and snippets are rejected. Authentication headers are not retained. Response text is redacted against supplied authentication values, and generic transport errors do not echo private headers or URLs. Each attempted request receives its own evidence file; failures remain in place. Output must be a new directory outside the checkout and prepared bundle. No automatic retry occurs.

Identity must match before any stress probe. The planned sequence is identity, then each of the following with a separate healthy request afterward:

1. A synchronous infinite loop, subject to the production dynamic Worker's 1,000 ms CPU limit.
2. A delayed call beyond the production 15-second asynchronous timeout, followed by a 1.5-second observation window.
3. A scheduled unawaited delayed call after normal program return.
4. An active unawaited read whose `finally` attempts a second call after cancellation.
5. Five sequential Google bridge reads in one program, investigating the production `subRequests: 1` setting.

Each request has a 30-second external deadline. A failed healthy follow-up stops further probes. Follow-ups are planned liveness observations, not replay of a failed probe. The counter is local to each request and remains alive through the explicit observation window; it does not rely on isolate reuse or an eventually consistent cross-request store. Only intercepted synthetic read dispatches are counted. This establishes that no Google dispatch happened after close within the tested window; it does not claim durable scheduling/replay support.

CPU passes only when the observed native executor throws a CPU-specific platform exception. The observer records that exception before the production runtime converts it to its safe error receipt. A generic resource-limit error, HTTP 1102, transport failure, or external HTTP timeout is **unknown**, never CPU proof. If the platform suppresses the specific exception, correlate independently retained platform diagnostics with the deployed version, timestamp and request ID before making any stronger claim. Do not reinterpret a generic error as CPU enforcement or blindly rerun the loop.

`report.json` marks hosted qualification only if the complete planned sequence passes. It records the selected digest/version, prepared-manifest hash, per-probe grades and request IDs. It qualifies the executor limits and finite protocol behavior of the retained harness candidate against synthetic reads, not live Google, gateway token projection, Skills activation, or Claude/ChatGPT/OpenClaw usability. Preserve deployment, ingress and platform receipts alongside it. After review, retire only the newly owned verification Worker/bridge through the owning project; the harness does not perform broad cleanup.

## Credential-free checks

```sh
node --experimental-strip-types --test tests/integration/hosted.test.ts
```

The ordinary test workflow includes these tests. They build the private candidate and exercise it in local Miniflare, including the actual 15-second async timeout, late-call fences, five reads, and healthy follow-ups. Outbound networking fails if attempted. CPU grading is tested with synthetic exception evidence; the infinite loop is deliberately never run in local workerd, whose CPU limit behavior does not establish hosted enforcement. A local pass is not a hosted pass.

## Direct hosted Gmail gate

Prepare the production-backed candidate with `just hosted-product-prepare OUTPUT`.
This mode imports the real product entrypoint and adds only test-deployment identity
headers. Deploy its retained bundle/config to the existing runner-protected test
Worker, preserving Access, disabled previews and disabled observability. The prior
synthetic bundle and its version-specific runtime receipts remain separate.

For a local `just eval-gmail` run, select `EVAL_BACKEND=hosted` and provide
`HOSTED_VERIFICATION_URL`, `HOSTED_EXPECTED_CANDIDATE_DIGEST`,
`HOSTED_EXPECTED_WORKER_VERSION`, and private `HOSTED_ACCESS_HEADERS_JSON` through
the runner environment. The launcher passes the Access pair privately to `act`.
Before fixture setup or inference, the hosted backend checks denied admission and
an authenticated root description; every response must match the chosen source
and deployed version. Redirects and persistent sessions are refused.

The trusted local relay supplies the short-lived test-account Google token directly
as the tool argument. This sends that token over HTTPS to the protected Cloudflare
product. The actor receives only its existing placeholder and loopback endpoint.
Fixture setup, independent Gmail readback and owned-fixture cleanup remain direct
Google calls. No gateway is required. Run only selected cases/models; retain
request-level usage/cache receipts and old failures rather than purchasing warmups.

On 2026-11-04 the production-backed bundle with source digest
`01dca552ad432caee0c3d08afe2049410ca5e667e0d6260d8478697f828b93e0`
was deployed as version `bd43ffaf-1343-44e8-b060-ad086f4e8186` with the existing
Worker Editor credential. Native platform readback and authenticated responses
matched that identity; missing Access credentials returned 403 and a wrong secret
returned 401. A no-model `users.getProfile` read matched the dedicated test account.

All four selected agent attempts passed: Sonnet and Sol on attachment and
pagination. Each passed the unchanged version-2 method-ordering and actual skill
retrieval criteria, exact file/answer checks, independent Google readback and
cleanup, with no unknown mutations. Tokens were injected directly by the trusted
relay. This qualifies these cases on this deployed product; the earlier synthetic
CPU/termination receipts retain their original version. Other Gmail cases,
services, target-host journeys and native Skills activation remain separate.

## Optional private artifact storage

For product-mode preparation, `ARTIFACTS_BUCKET=existing-private-bucket` adds the
optional ARTIFACTS R2 binding to the retained deployment config and includes that
selection in candidate identity. Probe mode refuses that setting. The product
adapter forwards request context for bounded best-effort completion cleanup.
Preparation creates no bucket and changes no billing, policy or lifecycle.
The ordinary deployment entrypoint accepts the same environment variable and
uses a disposable generated config while preserving the base configuration.

Local workerd/Miniflare R2 tests are separate from a hosted storage qualification.
The existing Workers Editor token has not been proven to provision R2 or change
lifecycle; bootstrap those through the bucket custodian with appropriate R2
administration rights if needed. Configure a private bucket and a physical
lifecycle backstop separately. The one-hour application expiry denies artifact
access, but does not physically delete bytes. Do not equate it with a one-hour
retention guarantee. Hosted artifact access, bucket lifecycle and native host
file presentation remain unqualified by the existing hosted media/Gmail records.
