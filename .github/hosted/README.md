# Hosted executor verification

This harness prepares a separate private Cloudflare Worker that imports the production executor, dispatcher and MCP handler. It runs fixed programs with a synthetic Discovery document and an in-memory GET transport. It never refreshes OAuth, contacts Google, sends mail, mutates user data, or adds a route to the production Worker.

The maintained runner requires an owner-provided protected HTTPS `/mcp` ingress to this verification Worker. The configuration deliberately sets `workers_dev: false` and `preview_urls: false`, with no routes. A private service binding is not directly reachable from the Node runner. An authorized gateway or existing protected ingress must forward to that binding before hosted verification can run. This directory does not implement a public authentication service or automatically create that bridge.

## Prepare without deployment

Run from the checkout with installed pinned dependencies:

```sh
just hosted-prepare /absolute/new/prepared-evidence
```

Preparation runs Wrangler's dry run and writes the deployable `worker.js`, `wrangler.json`, `manifest.json`, and `prepare.log` into a new directory outside the checkout. The manifest includes the Git revision, hashes of the actual production and harness source files plus package lock, and the exact bundle hash. Dirty source bytes are therefore represented. The generated config deploys the retained bundle with `no_bundle: true`, binds its source digest, and preserves the private routing configuration and platform version metadata binding. Preparation does not authenticate or deploy.

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
node --experimental-strip-types --test .github/tests/hosted.test.ts
```

The ordinary test workflow includes these tests. They build the private candidate and exercise it in local Miniflare, including the actual 15-second async timeout, late-call fences, five reads, and healthy follow-ups. Outbound networking fails if attempted. CPU grading is tested with synthetic exception evidence; the infinite loop is deliberately never run in local workerd, whose CPU limit behavior does not establish hosted enforcement. A local pass is not a hosted pass.
