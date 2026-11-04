# Agent feasibility gate

Run one selected profile:

```sh
just eval gmail claude-haiku-5-5 http://127.0.0.1:8317 /absolute/new/evidence-directory
```

Requires Docker, `act`, `just`, Node 24, the existing test OAuth grant, and a running
Anthropic-compatible CLIProxyAPI. The launcher reads `CPA_CLIENT_API_KEY` or
`~/.config/cpa-manager-plus/client-key`; Google credentials use the same local
configuration as `just live`. It mounts the new evidence directory into `act`
and uses host networking so the container can reach the local proxy. It installs
native Claude 2.1.318 rather than using a host routing wrapper. Before the live
trial, a synthetic loopback test checks that native file tools work and reject
writes outside the workspace; it makes no provider or Google requests.

The GitHub **Agent feasibility** workflow is also manual. It needs the three
Google test secrets documented in the root README plus `CPA_CLIENT_API_KEY` and
a proxy URL reachable from that runner. A localhost proxy on the developer
machine is not reachable from a hosted runner. No proxy is provisioned or exposed
by this workflow. GitHub evidence artifacts retain private test content for seven
days; local evidence remains in the selected external directory.

This is an on-demand native Claude task against the actual built MCP Worker and
the dedicated dummy Gmail account. It is separate from credential-free `check`
and scripted live API verification. The manual workflow never runs on push or PR.
Only one selected profile runs, with no performer retries, fallback, judge votes,
or automatic optimization. A second fresh trial is an explicit cache probe, not a
retry that erases an earlier failure.

The Gmail episode asks the agent to find a uniquely titled message, read a random
confirmation code, reply in its thread, apply a named label to the original
message, and save its tiny UTF-8 attachment with the original filename and bytes.
The agent receives no API recipe, message ID, answer key, preloaded local skill,
or expected file. It must use server discovery and the actual `skill://` resource.
Independent Gmail readback and file hashes grade the result. Task success and
discovery/skill evidence are separate criteria; both must pass the gate.

Drive (find/read a fixture file), Sheets (read/update a fixture cell), Docs
(read/append to a fixture document), and Calendar (find/update a fixture event)
are named coverage targets. They are unsupported by the current product and
must remain visible as pending. Selecting an unsupported profile or `all` fails
coverage before spending on a model. Gmail success does not qualify those APIs.

The trusted harness replaces a documented `accessToken` placeholder through a
loopback HTTP relay. It also supplies proxy authentication outside the acting
process. The actor uses a separate OS identity, an empty workspace, a minimal
environment, restricted file tools, and explicit MCP configuration. It cannot
read repository source, graders, OAuth material, or prior results. This is an
adapted trusted-caller integration, not proof of every target host's credential
injection or Skills UI. File success covers JSON attachment retrieval and native
host file writing; binary Worker artifact delivery remains unsupported.

Each attempt retains source/case/model/CLI identity, actual MCP requests and
responses with credentials removed, native stream JSON, files, independent state,
criteria, cleanup results, and usage even on failure. Reports distinguish fixture,
transport, model, task, mechanism, and cleanup failures. Unknown mutations fail
the attempt and stop later actor calls; no send is retried. Cleanup uses known
fixture IDs and preserves unreconciled markers.

Limits include a five-minute wall deadline, a fixed request/turn ceiling, and a
native CLI dollar estimate ceiling. The latter is not a proxy billing guarantee.
Requested and response-reported model identities, cache creation/read/ordinary
input/output tokens, and CLI-estimated cost remain separate. Missing counters or
provider billing remain unknown. Stable prompt/tool prefixes enable provider
caching; only observed cache reads establish that it occurred. There is no prompt
padding or automatic live-result cache. Offline regrading reuses saved evidence
without repeating Google or LLM calls; it cannot qualify a changed live system.

Run an offline regrade of one retained `trial-N` into a new external directory:

```sh
just eval-regrade /absolute/saved/evidence/trial-1 /absolute/new/regrade-directory
```

The command reads saved expectations, independent observations, captured files,
native evidence, MCP audit and model receipts. It preserves the original
`source.json` and `result.json`, including cleanup failures and execution errors,
and records the current grader identity separately. Missing evidence fails the
gate. It performs no new Google, model, fixture or cleanup operations. Local live
evaluations acquire one host lock across checkouts; a competing invocation stops
before credentials or the dummy account are used.

This is a small synthetic feasibility suite anchored in the owner's examples,
not a production benchmark or statistical improvement claim. Cases used to tune
the product are validation data. A later hillclimb needs broader frozen cases and
untouched evaluation data. The design follows the adopted mafe-si `build-eval`
guidance, informed by the [Anthropic article](https://claude.dev/blog/automating-eval-design-and-hillclimbing/).

## Observed pilot results

On 2026-11-04, Haiku 5.5 with native Claude 2.1.318 completed the revised Gmail
episode: correct reply and label, exact attachment bytes, successful root discovery
and skill retrieval, no unknown mutations, and successful cleanup. It used seven
model requests, 4,215 output tokens, 36,683 cache-read input tokens and 11,111
cache-creation input tokens. Its CLI cost estimate was $0.00469793; provider billing
was unavailable.

**The full gate failed:** the agent skipped method discovery, despite the skill's
instruction to discover methods first. A preceding failed baseline also lacked
the native Write tool because of the CLI's `--bare` behavior; that configuration
was corrected and now has a synthetic native regression. Both attempts remain
retained. The revised run demonstrates that an agent can perform this Gmail task,
but does not validate agent use of method discovery, the other services, every
target host, or hosted Cloudflare behavior. No extra trials were run to obtain a
green result.
