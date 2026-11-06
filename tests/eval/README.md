# Agent feasibility gate

## Independent cases and grading version 4

Conditional case 3 retains the refusal task, complete native ledger and independent
metadata/content checks. A separate trial-owned recorder requires only recognized
Drive/Discovery GET requests, including the owned file read, through the actual
local Worker. It closes admission, drains requests, retains `product-outbound.json`
and disposes that Worker before declaring coverage complete. Query values,
credentials and bodies are excluded. Redirects are not followed by the host
forwarder; unexpected routes, overrides or unobserved results cannot qualify.
Native version and timestamp changes are diagnostic rather than a no-write test;
a valid intact baseline is sampled once without a stability wait.

Missing or incomplete recordings remain unknown. Historical conditional traces
cannot acquire this evidence by regrading: their original results stay unchanged,
and both old conditional models lack the independent record required by grading 4.
Hosted conditional evaluation stops before inference while that backend lacks
independent recording. Other Gmail/Drive criteria are unchanged.

The maintained live Drive workflow calibrates a read-only session and a
rename/revert that restores its timestamp, without models. These controls qualify
the measurement. The later [current-candidate matrix](#current-candidate-drive-completion-2026-11-05)
also passed all eight required agent cells, including both conditional attempts.

The no-model live calibration passed on 2026-11-05: the read-only session recorded
two GETs despite native version `1`→`2`; the rename/revert restored name,
`modifiedTime` and bytes while recording two acknowledged PATCH requests, which
the outbound oracle rejected as read-only. Download, rename, refusal and pagination
checks also passed, with all seven owned fixtures cleaned and no unknown mutations.
This validates the revised recorder, not a fresh agent result.

Grading version 3 retains the requirement for each native method in the trusted execution
ledger to have a matching successful description completed before execution
starts. Root discovery and the actual Workspace resource read must also finish
before the first execution. This includes Google calls inside snippets. Older
traces without causal ordering remain unqualified under the new criterion; their
original grades stay unchanged. Version 3 also supports explicit case-required
method descriptions before the first execution, including methods that must not
be called. Existing cases retain their version-2 criteria when this policy is absent.

Independent cases cover read/search, reply, attachment, labels, pagination,
and safe failure handling. Each has fresh fixtures and an actor workspace, exact
answer/file or independent Google state checks, case-specific mutation limits,
and cleanup. One required Sonnet/Sol attempt per case permits twelve attempts,
each retaining the existing five-minute and $1 estimate caps: at most $12 in
estimates, separate from proxy billing. Ordinary checks remain inference-free.

Run the six-case required-pair suite with `just eval-gmail PROXY_URL NEW_OUTPUT`.
Optional trailing arguments select comma-separated cases and model cells; the
$12 maximum above describes the default required-pair campaign, not arbitrary
larger selections. `just eval-matrix gmail ...` retains the legacy combined case.
Hosted Cloudflare and actual host/gateway acceptance remain separate from local
runner results.

Drive defines four cases: `read-file`, `list-pages`, `rename-file`, and
`conditional-update-unsupported`. Run
`just eval-drive PROXY_URL NEW_OUTPUT` after `just oauth --drive` and enabling
Drive API. The default required pair permits eight fresh attempts, each under its
existing $1 estimate/five-minute caps, at most $8 in estimates. No automatic retries.
Fixtures are app-created files under `drive.file`, with independent metadata,
content and parents checks and known-ID cleanup.

### Unused evaluation compositions

Two explicit evaluation cases extend the validation corpus: Gmail
`selective-labels` chooses messages from their current body facts before applying
an existing label; Drive `select-rename` chooses a file from its contents and
derives the new name from those contents. Distractors contain previous facts that
must not determine the action. Exact answers, complete native outcomes and
independent state checks distinguish correct selection from changing every object
or doing nothing. Both cases preserve unrelated state and use known-ID cleanup.
They are excluded from the default `all` suites.

Run these only as an explicitly selected assessment:

```sh
just eval-gmail PROXY_URL NEW_GMAIL_OUTPUT selective-labels required
just eval-drive PROXY_URL NEW_DRIVE_OUTPUT select-rename required
```

One attempt per required model and case means four attempts, at most $4 in the
existing estimates, with unchanged five-minute limits and no automatic retries.
Before inference, retain a partition/protocol receipt with the case versions,
candidate and grader hashes, selected models, caps and stop conditions. Calibrate
the fixture/oracle paths without models first. Keep the stable shared prompt and
tools; cache hits come from observed provider counters, without warmups or padding.
Use each workflow-generated report for full gates and token/cache/cost metrics.

These compositions were authored with implementation knowledge. Their first
prospectively frozen assessment can establish unused-case feasibility, not strict
blindness or reliability. Once results inform a change, the cases become
validation for that tuning; repeating them cannot restore untouched status.
Existing Gmail/Drive/media/artifact cases already used in development retain
their historical validation results and failures. No assessment result is claimed
until its selected attempts and independent cleanup are inspected.

The pagination task asks for one result per page and an exact `answer.json`
inventory. Trusted native call annotations must establish a complete token chain,
including projected continuation/completeness fields and exact returned IDs;
agent-created page logs do not establish native pagination. The conditional task
asks for an atomic conditional rename when supported, otherwise an unchanged file
and `status.json`. It requires update-method discovery before execution and an
owned-file read. This measures discovery and adherence to the documented limit,
not independent API reasoning or successful conditional writes. Zero recorded
mutation outcomes cannot prove no expression was rejected before the bridge.

Historical conditional case version 2 used successive equal native versions after
at least five seconds, bounded to 12 observations/30 seconds. A live check passed
with versions `1`, `3`, `3`, but the subsequent agent pair produced one pass and
one version-only failure. That counterexample invalidated the readiness
assumption. Case 3 replaces version equality with independent egress evidence;
it does not relabel those retained trials.

The file case uses UTF-8 content because runner Write tools accept text; synthetic
native-SDK tests separately verify arbitrary binary and JSON-MIME downloads.
The media envelope remains bounded to 131072 raw bytes. A separate media profile
now covers bounded create uploads; durable artifact storage remains deferred. A historical four-case campaign produced six passes and two failures;
the later conditional-v2 pair produced one pass and one failure. Those failed
campaigns remain retained. A later current-candidate matrix passed all eight
required cells. Hosted Drive and actual target-host acceptance remain separate.

Run the required pair, or explicitly select all six cells:

```sh
just eval-matrix gmail http://127.0.0.1:8317 /absolute/new/evidence-directory
just eval-matrix gmail http://127.0.0.1:8317 /absolute/new/full-matrix-directory all
```

| Role      | Claude (native CLI 2.1.318)    | GPT (Responses runner)    |
| --------- | ------------------------------ | ------------------------- |
| Required  | `claude-sonnet-5-5` (`sonnet`) | `gpt-6.1-sol` (`sol`)     |
| Probe     | `claude-haiku-5-5` (`haiku`)   | `gpt-6-luna` (`luna`)     |
| Reference | `claude-opus-5-5` (`opus`)     | `gpt-6.1-terra` (`terra`) |

Matrix version 2 selects Sonnet and Sol as the required pair. Version 1 results
retain their original Sonnet/Terra roles and are not reclassified.

The Responses runner supplies the server's actual instructions and resource metadata to the model. Skill contents still
require a model-requested resource read. Shared tool descriptions and root
navigation explain starting at the service catalog, reading the Workspace skill,
and inspecting methods before executing. Budgets remain unchanged; grading
version 2 adds complete method coverage and causal ordering.

The optional last argument selects `required` (default), `all`, or comma-separated
cell IDs. Cells run sequentially in manifest order, once each, with fresh fixtures
and actor workspaces. Required cells must each pass the full gate. Probe and
reference score failures are informational; unknown mutations, missing cleanup
proof, and infrastructure failures fail the run and stop later cells. Reports
retain unattempted cells. A subset cannot qualify the absent required pair.

For a single model, use its exact manifest ID:

```sh
just eval gmail gpt-6.1-sol http://127.0.0.1:8317 /absolute/new/single-model-directory
```

Requires Docker, `act`, `just`, Node 24, the existing test OAuth grant, and a running
CLIProxyAPI supporting Anthropic Messages and OpenAI Responses. The launcher reads
`CPA_CLIENT_API_KEY` or `~/.config/cpa-manager-plus/client-key`; Google credentials
use the same local configuration as `just live`. It mounts the new evidence
directory into `act` and uses host networking to reach the local proxy. An explicit local `ACT_NODE_OPTIONS` is forwarded as container `NODE_OPTIONS` and
retained in the container profile; host `NODE_OPTIONS` is not forwarded implicitly.
For the observed marcdev token-endpoint timeout, use
`ACT_NODE_OPTIONS=--no-network-family-autoselection just eval-drive ...`. Exact
advertised model IDs are checked before OAuth or fixtures; metadata availability
does not establish successful inference.

Claude runs through the pinned native CLI. GPT runs through a small isolated
Responses loop (`responses-loop-3`), with tools copied from the actual MCP server,
resource-list/read tools, and bounded UTF-8 workspace Read/Write tools. It sends
self-contained history with storage disabled and preserves returned reasoning
items and tool-result data. It has no shell or built-in remote tools. This is a
model feasibility comparison across two runners, not native Codex, ChatGPT, or
OpenClaw host qualification. Native Codex reached the MCP revision in a probe,
but its available configuration did not establish the narrow tool surface used
by this evaluation.

In `responses-loop-3`, when an MCP tool result's sole plain
text block exactly duplicates its structured JSON, send the structured copy and
all other envelope fields to the model. Retain the complete raw result in audit
events. Other content, host tools, discovery schemas and all gate limits remain
unchanged. This removes redundant history; it does not guarantee that a longer
discovery trajectory fits the request cap.

Before live trials, synthetic loopback checks exercise both runners, including
actual bundled GPT process isolation and file access refusals. Run these alone
without credentials, inference, or Google requests:

```sh
just eval-preflight /absolute/new/preflight-directory
```

Synthetic runner checks live in `tests/preflight/`. The workflow runs each file
explicitly, so renaming a test cannot silently omit a required preflight.
Ordinary `just check` also discovers these files; native CLI checks run only when
their executable paths are explicitly supplied.

The **Agent feasibility** workflow runs only through local `act` on marcdev.
Its first step refuses GitHub-hosted execution before installing tools, refreshing
OAuth grants, creating fixtures, or calling models. Use the `just eval*`
commands above with the local CLIProxyAPI; no proxy or model credentials need
publishing to GitHub. Local evidence stays in the selected external directory.
Ordinary push and PR checks never invoke models.

### Generated run reports

The workflow always runs an offline summarizer after evaluation, including score
and infrastructure failures. It writes `workflow-report/summary.json` and
`workflow-report/summary.md` beneath the evidence directory and appends the
Markdown to the GitHub step summary when available. The report contains recorded
gates, failed criterion IDs, declared and unattempted cells, source/backend
identities, cleanup and mutation certainty, and per-attempt/model token, cache,
request and separately labeled cost metrics. Missing telemetry stays unknown;
partial totals show their measured coverage. Estimates are not provider billing.
`sourceReceiptSha256` fingerprints the exact per-cell `source.json` receipt,
including its harness file hashes; it is not a code-only bundle digest.

Regenerate a report from retained evidence without OAuth, inference or regrading:

```sh
just eval-report /absolute/saved/evidence /absolute/new/report-directory
```

The output directory must be new. Source evidence and original grades are
preserved. The report uses allowlisted fields and excludes prompts, account/file
identifiers, raw requests and private error text; raw evidence remains private.
Reporting success never changes the evaluation gate. A report-generation error
fails its own workflow step and leaves the original failure in place.

For change verification, first select affected cases and establish whether saved
evidence applies using the [verification procedure](../../.agents/skills/google-codemode-verify/references/change-verification.md).
Use the offline acceptance command:

```sh
just eval-verify /absolute/saved/evidence /absolute/new/verification-report
```

This writes the same report and exits nonzero unless the selected retained gate
passes with complete result, identity, cleanup and mutation evidence. Synthetic,
missing and contradictory evidence cannot qualify. Probe/reference score failures
remain informational under the existing matrix policy; their infrastructure or
safety failures block acceptance. Missing usage or billing stays unknown.
This consumes recorded grades, without regrading or checking equivalence to the
current checkout/deployment. A subset pass does not qualify omitted cases or the
full required pair. Ordinary `eval-report` remains a report-only command.

`just eval-preflight NEW_OUTPUT` exercises this same reporting step using an
explicitly synthetic campaign with one failed and one passing cell. Its report
does not describe real model attempts or Google activity.

There are no performer retries, fallbacks, judge votes, or automatic optimization.
A single-model invocation may request a second fresh trial as an explicit cache
probe; matrices use one attempt per cell. Neither is statistical reliability proof.

The Gmail episode asks the agent to find a uniquely titled message, read a random
confirmation code, reply in its thread, apply a named label to the original
message, and save its tiny UTF-8 attachment with the original filename and bytes.
The agent receives no API recipe, message ID, answer key, preloaded local skill,
or expected file. It must use server discovery and the actual `skill://` resource.
Independent Gmail readback and file hashes grade the result. Task success and
discovery/skill evidence are separate criteria; both must pass the gate.

Sheets (read/update a fixture cell), Docs (read/append to a fixture document),
and Calendar (find/update a fixture event) are named coverage targets. They are
unsupported by the current product and
must remain visible as pending. Selecting an unsupported service profile (including profile `all`) fails
coverage before spending on a model. Gmail or Drive success does not qualify those APIs.

The trusted harness replaces a documented `accessToken` placeholder through a
loopback HTTP relay. It also supplies proxy authentication outside the acting
process. The actor uses a separate OS identity, an empty workspace, a minimal
environment, restricted file tools, and explicit MCP configuration. It cannot
read repository source, graders, OAuth material, or prior results. This is an
adapted trusted-caller integration, not proof of every target host's credential
injection or Skills UI. File success covers JSON attachment retrieval and runner
workspace file writing; binary Worker artifact delivery remains unsupported.

Each attempt retains source/case/model/CLI identity, actual MCP requests and
responses with credentials removed, runner transcript, files, independent state,
criteria, cleanup results, and usage even on failure. Reports distinguish fixture,
transport, model, task, mechanism, and cleanup failures. Unknown mutations fail
the attempt and stop later actor calls; no send is retried. Cleanup uses known
fixture IDs and preserves unreconciled markers.

Each case/model attempt has a five-minute wall deadline, at most 18 model requests, at most
2,048 output tokens per request, and a conservative 15,000 total output allowance.
Claude additionally has a $1 native CLI estimate ceiling. GPT reserves input bytes
plus framing and output allowance against a $1 published-rate estimate ceiling;
accounting version 2 settles both input and output reservations only after a
unique completed response passes model identity and usage validation. Budget
settlement uses the uncached input rate, even when cache reads are reported.
Missing or uncertain usage retains both reservations. The default Gmail suite allows twelve $1 estimates and Drive eight; a legacy
six-model single-case matrix allows six. None has a $1 campaign-wide budget. These limits are not proxy billing guarantees.

Requested and response-reported identities, input/output/cache tokens, estimates,
and provider billing remain separate. GPT estimates use recorded Standard token
rates from the OpenAI pricing page; cached-input pricing applies only to observed
cached tokens. GPT cache creation is unknown. Missing counters or provider billing
remain unknown. Stable prompt/tool prefixes enable provider caching; only observed
cache reads establish it occurred. There is no prompt padding or automatic live
result cache. Offline regrading reuses saved evidence without repeating Google or
LLM calls; it cannot qualify a changed live system.

The matrix directory retains `matrix-source.json`, `matrix-results.json`, and
`report.md`, with each cell's complete evidence in its named subdirectory. Each
cell records runner version, source hashes, model receipts, task versus mechanism
criteria, usage, and cleanup. A model's result also depends on its runner and the
proxy; this small matrix cannot isolate model-only effects.

Run an offline regrade of one retained `trial-N` into a new external directory:

```sh
just eval-regrade /absolute/saved/evidence/trial-1 /absolute/new/regrade-directory
```

The command reads saved expectations, independent observations, captured files,
runner evidence, MCP audit and model receipts. It preserves the original
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

## First model matrix (2026-11-04)

One attempt was selected for each of the six cells. The campaign stopped after
Luna exhausted the fixed 18-turn limit; Opus and Sol were not attempted. All four
attempted cells had matching response-reported model IDs, zero unknown mutations,
and successful fixture cleanup. The required-pair gate **failed**.

| Cell   | Task outcomes | Full gate         | Observed gap                                                 |
| ------ | ------------- | ----------------- | ------------------------------------------------------------ |
| Sonnet | Pass          | Fail              | Skipped method discovery                                     |
| Terra  | Pass          | Fail              | Skipped root discovery and skill resource                    |
| Haiku  | Pass          | Fail              | Skipped method discovery                                     |
| Luna   | Fail          | Error: turn limit | Reply and exact attachment incomplete; root discovery absent |
| Opus   | Unattempted   | Unattempted       | Campaign stopped                                             |
| Sol    | Unattempted   | Unattempted       | Campaign stopped                                             |

Observed cache-read input tokens were 26,664 (Sonnet), 87,808 (Terra), 67,403
(Haiku), and 105,472 (Luna). Claude CLI estimates were $0.0533924 and $0.00527623;
GPT published-rate usage estimates were $0.0446694 and $0.00985752, respectively.
Provider billing remained unknown. These are different estimate sources across
two runners and one synthetic task, not a model cost or quality ranking.

Terra's saved evidence was also regraded offline: task pass and the same two
mechanism failures, without additional Google or model requests. No retry or
fallback was run. Task feasibility is demonstrated for three tested performers;
complete discovery/skill compliance and target host qualification remain open.

## Sonnet/Sol pair after instruction repair (2026-11-04)

Matrix version 2 ran one fresh attempt per required cell with unchanged grading,
limits, and fixtures. Sonnet passed all 17 existing criteria, including the Gmail
task, root discovery, method discovery and actual skill retrieval. Sol passed
root/method discovery and skill retrieval, but did not complete the task: the
relay rejected request 12 before dispatch because its conservative published-rate
reservation would exceed $1. The required-pair gate remains **failed**.

Sol had 11 completed model requests. Its observed-usage estimate was $0.0821732;
the relay had retained $0.91368 in conservative reservations before rejecting the
next request. Input bytes plus framing deliberately overestimate token counts and
are charged without cache discounts or input refunds. This result identifies a
harness budget limitation, not inability of the model to perform the task. Neither
the ceiling nor accounting was changed to obtain a passing run. No retry occurred.
Sonnet's native CLI estimate was $0.121344. Observed cache-read tokens were 64,400
for Sonnet and 59,392 for Sol; provider billing remains unknown. Both cells had
matching model identities, successful cleanup, and zero unknown mutations.

The instruction handoff defect was on the project side: the former GPT runner
never supplied the server instructions or resource metadata to the model. The
corrected runner exposes these without reading the skill on the model's behalf.
Shared product guidance was clarified in the same candidate. This combined change
and a different GPT model do not isolate a single cause of changed behavior.

That run's version 1 method criterion verifies that a method description was retrieved;
it does not verify every called method or enforce ordering. Sonnet first used
memorized list/get calls, then described the send, modify, and attachment methods
before its second execution. Its existing-gate pass therefore does not prove full
adherence to the instruction to describe every method before use. A stricter
criterion now has its own declared version 2 and retained baseline; these
historical results remain unchanged.

Accounting version 2 keeps the same $1 ceiling and pre-request byte/output
reservations. For a unique, fully validated completed response from the selected
model, settle both input and output reservations from reported token counts,
using the uncached input rate for the budget. Missing counts or uncertain,
incomplete, failed, mismatched, or conflicting responses retain both reservations.
The cache-discounted usage estimate and unknown provider billing remain separate.
Receipts record reservation, settlement eligibility/reason, refund, and cumulative
committed estimate. A subsequent Sol validation uses a separate candidate and
retains the preceding pair as failed.

## Sol validation with accounting version 2 (2026-11-04)

One fresh Sol attempt passed all 17 existing gate criteria after the reviewed
budget repair: Gmail task, exact UTF-8 file, root and method discovery, actual
skill read, model identity, and mutation certainty. Sixteen model requests
completed. The committed estimate at uncached input rates was $0.671908; the
observed cache-discounted usage estimate was $0.1354088, with 330,224 input tokens,
282,368 cached input tokens, and 1,146 output tokens. Actual proxy billing remains
unknown. All receipts settled from verified completed responses under the same
$1 ceiling. Cleanup succeeded, with zero unknown mutations. Offline regrading
reproduced the pass without further Google or model operations.

Sonnet's preceding pass and this Sol pass use identical product, skill, fixtures,
and grading, but different GPT accounting candidates. They demonstrate one
successful attempt for each required model, not a fresh same-candidate pair pass
or reliability. The earlier pair remains failed in its original evidence. The
instruction handoff and budget reservation defects were harness defects; shared
product guidance also changed before the first pair. The method criterion's
coverage limit described above still applies.

## Independent Gmail cases with grading version 2 (2026-11-04)

Both required models completed all six task outcomes. The full discovery gate
remains **failed**: Sonnet used `gmail/v1/users.messages.get` before describing it
in the attachment and pagination cases. Sol passed all six current case grades.

| Case          | Sonnet task             | Sonnet full gate       | Sol task                    | Sol full gate               |
| ------------- | ----------------------- | ---------------------- | --------------------------- | --------------------------- |
| Read/search   | Pass                    | Pass                   | Pass                        | Pass                        |
| Reply         | Pass                    | Pass                   | Pass                        | Pass                        |
| Attachment    | Pass                    | Fail: method discovery | Pass                        | Pass                        |
| Labels        | Pass                    | Pass                   | Pass                        | Pass                        |
| Pagination    | Pass, offline corrected | Fail: method discovery | Pass, offline corrected     | Pass, offline corrected     |
| Missing email | Pass                    | Pass                   | Pass, separate continuation | Pass, separate continuation |

The original twelve-cell campaign remains failed in its retained evidence. Its
pagination oracle incorrectly expected exactly three pages for three messages;
Google returned an empty fourth final page. Case version 2 accepts a complete
native continuation chain including empty pages, while still requiring one result
per requested page, every fixture ID/code exactly once, and unchanged mailbox
state. Offline regrading of both saved traces corrected task success and Sol's
full grade without new model or Google calls. Sonnet's method failure survived.

The original Sol missing-email fixture received HTTP 400 for a random ID and
aborted before launching the actor. Its repaired version 2 uses a representable
16-digit ID and still requires a preflight HTTP 404; unexpected responses stop
before inference. One continuation failed during synthetic runner preflight on
a temporary source syntax error. After correction, exactly one Sol actor attempt
ran for the remaining case and passed. No completed actor trial was repeated.
All twelve executed actors had matching model identities, successful cleanup
and zero unknown mutations. This is qualified evidence across retained trials,
offline regrades and a continuation, not a fresh same-candidate suite pass.

Across those six attempts per model, Sonnet reported 291,089 cache-read input
tokens and 85,845 cache-creation input tokens, with a native CLI estimate of
$0.4453949. Sol reported 514,669 input tokens including 347,136 cached tokens,
and 2,804 output tokens; its observed published-rate estimate was $0.3978196.
GPT cache creation and actual provider billing remain unknown. Estimates use
different sources and do not establish relative model cost. The existing per-cell
caps were unchanged, and no inference ran to regrade saved results.

Earlier Haiku configuration/discovery failures, the first matrix failures and
unattempted cells, the original Sonnet/Sol budget failure, and the subsequent
qualified accounting repair remain retained in the historical sections above.
Actual target hosts, gateway deployment, hosted Cloudflare limits and Drive live
behavior are separate acceptance boundaries.

## Drive live qualification (2026-11-04)

With the additional `drive.file` grant, `just live-drive` passed authenticated
download and rename checks through the locally built Worker: exact file bytes,
metadata preservation, native mutation identity/fields and independent readback.
Both fixture cleanups passed, with zero unknown mutations.

The original four planned actor attempts ran once per required model/case:

| Case     | Sonnet 5.5           | Sol 6.1                                      |
| -------- | -------------------- | -------------------------------------------- |
| Download | All 13 criteria pass | Task, discovery and skill pass; runner error |
| Rename   | All 13 criteria pass | All 13 criteria pass                         |

The initial campaign stopped after Sol's download task completed: its terminal
request was 262,621 bytes, exceeding the 262,144-byte relay cap. `responses-loop-2`
serialized each MCP description's structured data and identical text fallback.
The reviewed `responses-loop-3` repair removes only that exact duplicate from
model-facing history, preserving the full raw audit and every other envelope
field. Offline reconstruction matched all nine accepted request hashes and reduced
the rejected next request to 130,255 bytes. Limits, discovery schemas and grading
version 2 did not change. A longer trajectory can still reach the cap.

The two unused rename attempts then passed on the repaired candidate. Sol used
`responses-loop-3`; Sonnet used the unchanged native Claude runner. Sol's largest
rename request was 178,035 bytes. Its nine responses reported 118,158 input tokens,
including 76,672 cached tokens, and 572 output tokens; the observed published-rate
estimate was $0.0963592. Sonnet reported 25,525 cache-read and 6,478 cache-creation
tokens, with a native CLI estimate of $0.0390245. Actual proxy billing is unknown;
these estimates use different sources and do not establish relative model cost.

All four attempts had successful fixture cleanup and zero unknown mutations.
The original Sol download **ERROR** and failed campaign remain unchanged.

After explicit authorization, one additional Sol download attempt ran on clean
`84ef1bb` with `responses-loop-3`, the same five-minute/$1-estimate caps and no
automatic retries. It passed all 13 criteria, including exact downloaded bytes,
ordered discovery, actual skill retrieval, model identity and successful terminal
completion. Offline regrading reproduced the pass without inference. Its 11
responses reported 184,075 input tokens, including 155,392 cached tokens, and 705
output tokens. The largest request was 133,336 bytes. The observed published-rate
estimate was $0.0799552; actual proxy billing remains unknown. Cleanup passed,
with zero unknown mutations.

Both required models now have passing download and rename cases across retained
runs. This is qualified case coverage across runner candidates, not a fresh
complete-suite pass or reliability evidence. All five executed actors had
successful cleanup and zero unknown mutations. At that checkpoint, conditional
Drive behavior and live multi-page traversal still needed qualification; the
bounded fixtures did not prove those broader acceptance items.

## Drive pagination and conditional-write boundary (2026-11-05)

The expanded `just live-drive` passed all four deterministic cases through the
current local Worker: download, rename, conditional-option refusal and explicit
multi-page traversal. Three owned files were returned exactly once across three
pages with `pageSize: 1`, unchanged continuation tokens, stable name ordering and
a terminal page. Fixture search readiness completed before the product traversal.
Independent metadata/content readbacks and all six fixture cleanups passed, with
zero unknown mutations. Synthetic tests separately cover empty intermediate pages,
opaque token encoding and preservation of `incompleteSearch: true`.

Drive v3 Discovery revision `20261102` exposes no conditional-update parameter on
`files.update`; `File.version` is output-only. A separate owned-fixture Google
probe accepted a deliberately mismatched `If-Match` header and applied the rename.
That bounded observation does not characterize every Drive endpoint. The product
refuses second-argument transport options before the bridge, with zero outcomes,
and refuses invented/header parameters with `not_dispatched` outcomes. Independent
readback confirmed no change after these refusals. **Conditional mutation/CAS is
unsupported and not qualified**; refusal passes do not establish concurrency
protection.

The local live launcher now preserves working-tree bytes instead of fetching the
baseline commit, and retains source files/hashes beside its fixture receipt.
The first pre-fixture attempt on the old source remains failed. The successful
run used the explicit local `ACT_NODE_OPTIONS=--no-network-family-autoselection`
setting for a Node token-endpoint connection timeout; no OAuth re-consent or
product network setting was needed.

No additional agent trials ran for this qualification. Earlier Sonnet/Sol case
passes and the original Sol runner failure retain their source/runner identities.
Shared drives, a real `incompleteSearch: true` response, successful conditional
writes, hosted Drive and actual target-host activation remain unqualified.

## Fresh four-case Drive campaign (2026-11-05)

Eight fresh attempts ran once on `44c8c369d282c2be2463f4ae2c807afd7c05caca`,
using one local Worker bundle and the required Sonnet/Sol pair. All cases were
version 1 under grading version 3. Download, pagination and rename passed for
both models. Both conditional-limit cases failed only `drive_version_preserved`:
the immediate fixture baseline was `1`, while each actor's first metadata read
and independent final observation returned `3`. All other criteria passed,
including update-method discovery before execution, owned-file reads, exact
status artifacts, unchanged metadata/content and zero recorded mutations.
All eight attempts had complete model identity evidence, successful cleanup and
zero unknown mutations. Original result: **six pass, two fail, zero errors,
zero unattempted**. No retries or cap increases ran.

A subsequent fixture-only calibration created three owned files without models.
Their versions advanced from `1` to `3` before the first media download, then
remained `3` at later reads. A deliberate rename/revert control advanced the
version to `4` and `5`; all three files were cleaned up. Google's
[File reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
states that version includes every server change, including invisible changes.
The specific internal cause remains unknown. Conditional case version 2 adds
readiness before capturing its baseline; it retains the independent version
check. This fixture repair cannot be applied to the old baseline or turn the
original failures into passes. The separately authorized version-2 conditional pair
below also remains failed; the early-readiness condition did not establish future
version continuity.

Per-attempt counters below include the failed cases. Claude input excludes its
separate cache-read and cache-creation counters; GPT input includes cached reads.
GPT cache creation is unknown. Sonnet estimates come from the native CLI; Sol
estimates use observed published rates. Committed GPT estimates use conservative
uncached-rate accounting and are not additional charges. Actual billing is unknown.

| Case                           | Model  | Gate | Requests |   Input | Output | Cache read | Cache creation | Estimate USD | GPT committed USD |
| ------------------------------ | ------ | ---- | -------: | ------: | -----: | ---------: | -------------: | -----------: | ----------------: |
| read-file                      | Sonnet | pass |        6 |      12 |  1,816 |     31,696 |         10,005 |    0.0613736 |           unknown |
| read-file                      | Sol    | pass |        9 | 142,674 |    494 |    113,408 |        unknown |    0.0748128 |          0.290288 |
| list-pages                     | Sonnet | pass |        5 |      10 |  1,442 |     27,052 |          8,151 |    0.0497492 |           unknown |
| list-pages                     | Sol    | pass |        8 |  78,268 |    647 |     56,320 |        unknown |     0.055998 |          0.163006 |
| rename-file                    | Sonnet | pass |        5 |      10 |  1,017 |     26,220 |          6,853 |     0.040224 |           unknown |
| rename-file                    | Sol    | pass |        9 | 119,648 |    550 |     77,824 |        unknown |    0.0969304 |          0.244796 |
| conditional-update-unsupported | Sonnet | fail |        5 |      10 |  1,260 |     28,977 |          7,657 |    0.0461457 |           unknown |
| conditional-update-unsupported | Sol    | fail |       10 | 251,055 |    570 |    200,448 |        unknown |    0.1269588 |           0.50781 |

Across four attempts, Sonnet reported 21 complete requests, 42 ordinary input,
113,945 cache-read input, 32,666 cache-creation input and 5,535 output tokens;
the native CLI estimate totals **$0.1974925**. Sol reported 36 complete requests,
591,645 input including 448,000 cached input, and 2,261 output tokens including
zero reported reasoning tokens; its observed usage estimate totals **$0.3547**,
with **$1.2059** committed across four separate per-attempt budgets. These are
different counter/cost bases, not a model-cost ranking. No model requests were
made to recover or report metrics. The source, raw results, original failures
and all earlier campaign failures remain retained. This is feasibility evidence,
not reliability, a complete passing four-case suite, or host/hosted qualification.

## Conditional version-2 pair (2026-11-05)

Two separately authorized fresh attempts ran once on
`8f9da43fd19d3104caa0dcd6d88366398d34de65`, with the same local product bundle as
the eight-attempt campaign above. Case version 2 and grading version 3 retained
the mandatory version guard. Sol passed all 17 criteria. Sonnet passed 16 of 17,
failing only `drive_version_preserved`: readiness observed `1`, `2`, `2` and
captured `2` at 6.968 seconds, while the actor-returned individual metadata and
independent final readback reported `3`. Sol's baseline and final version were
both `3`. The cause of the version change remains unknown. This is a
counterexample to the readiness assumption, not evidence that a longer fixed
wait or requiring version `3` would be reliable.

Both actors discovered the required methods before execution, retrieved the
Workspace skill, returned the exact status artifact and preserved file metadata
and bytes. Complete trusted ledgers contain only acknowledged reads, with zero
recorded mutation outcomes; both actors completed successfully with matching
served identities and successful cleanup. Overall: **one pass, one fail, zero
errors, zero unattempted**. No retries, fallback or cap increases ran. Original
results from both campaigns remain unchanged; Drive qualification remains open.

Each row below is one attempt and that model's complete total for this pair.
All 17 model requests have complete identity receipts. Per-attempt system and
tool hashes remained stable. Metrics extraction made no additional inference.

| Model  | Gate | Requests |   Input | Output | Cache read | Cache creation | Estimate USD | GPT committed USD |
| ------ | ---- | -------: | ------: | -----: | ---------: | -------------: | -----------: | ----------------: |
| Sonnet | fail |        6 |      12 |  1,321 |     34,690 |         10,336 |     0.058047 |           unknown |
| Sol    | pass |       11 | 298,126 |    618 |    246,144 |        unknown |    0.1347584 |          0.602432 |

Sonnet's ordinary input excludes its separate cache-read and creation counters;
its cost is a native CLI estimate. Sol input includes cached reads, with 51,982
uncached input tokens; output includes zero reported reasoning tokens. GPT cache
creation and normalized Claude reasoning are unknown. Sol's cost is an observed
published-rate estimate, while its committed amount is conservative budget
accounting, not an additional charge. Actual billing is unknown for both models.
These are feasibility observations with different native counter bases, not a
matched cost or cache-savings benchmark. No further paid attempts are authorized.

## Current-candidate Drive completion (2026-11-05)

The first conditional-case-3 pair on clean a0b5a46 passed for Sol (17/17),
but Sonnet failed only method discovery (16/17): it used files.list without
describing it first. Both completed the task, preserved the file and had complete
GET-only independent outbound evidence, clean cleanup and no unknown effects.
That failed pair remains retained:

| Case                           | Model  | Gate | Requests |  Input | Output | Cache read | Cache creation | Native USD | Published-rate USD |  GPT committed USD |
| ------------------------------ | ------ | ---- | -------: | -----: | -----: | ---------: | -------------: | ---------: | -----------------: | -----------------: |
| conditional-update-unsupported | sonnet | fail |        5 |     10 |   1212 |      24859 |           9421 |  0.0523099 |            unknown |            unknown |
| conditional-update-unsupported | sol    | pass |       10 | 250979 |    581 |     202112 |        unknown |    unknown |          0.1237552 | 0.5077679999999999 |

The actual Claude model input showed that large method descriptions were replaced
with persisted-output wrappers and a 2 KB preview. Signature, runtime and existing
discovery guidance were beyond that preview. The full skill was visible, so this
is an established visibility defect rather than proof of the omission's sole cause.
The correction promotes existing compact fields before native metadata, preserving
all values, schemas, declarations, runtime behavior and grading. Real Drive
get/update/list and Gmail send descriptors retain the complete compact guidance
within 1,800 UTF-8 bytes in compact and pretty JSON; the fresh Claude model-visible
previews also contain it. Named-schema deferral remains separate work.

On the repaired candidate, all eight unique required cells passed: one fresh
Sonnet conditional attempt, its three remaining cases, then Sol's four cases.
The three maintained invocation reports retain their selected-only PENDING labels;
combined evidence establishes four cases times both models, with no repeated cell.
All 90 retained candidate-source file hashes matched across invocations and the
checkout before results documentation changed. The product bundle digest is
`67ffb5fed9e63399e9f010851afdeaa4f8aafb3a2fec3ff48ead4aa99590ad59`.

| Case                           | Model  | Gate | Requests |  Input | Output | Cache read | Cache creation | Native USD | Published-rate USD |   GPT committed USD |
| ------------------------------ | ------ | ---- | -------: | -----: | -----: | ---------: | -------------: | ---------: | -----------------: | ------------------: |
| conditional-update-unsupported | sol    | pass |       11 | 297932 |    625 |     248448 |        unknown |    unknown |          0.1300628 |  0.6021140000000001 |
| conditional-update-unsupported | sonnet | pass |        6 |     12 |   1272 |      37317 |           7854 |  0.0478917 |            unknown |             unknown |
| list-pages                     | sol    | pass |        8 |  78259 |    643 |      56704 |        unknown |    unknown |          0.0552104 |            0.162948 |
| list-pages                     | sonnet | pass |        5 |     10 |   1455 |      27103 |           8162 |  0.0499283 |            unknown |             unknown |
| read-file                      | sol    | pass |        9 | 142642 |    495 |     113408 |        unknown |    unknown |          0.0747588 | 0.29023399999999994 |
| read-file                      | sonnet | pass |        7 |     14 |   1702 |      42394 |           7544 |  0.0514634 |            unknown |             unknown |
| rename-file                    | sol    | pass |        7 | 104993 |    488 |      68224 |        unknown |    unknown |          0.0852404 |            0.214866 |
| rename-file                    | sonnet | pass |        5 |     10 |   1060 |      26295 |           6936 |  0.0409935 |            unknown |             unknown |

Every criterion passed: download and rename 13/13, pagination and conditional
17/17. All fixtures were cleaned; no unknown effects, errors or unattempted cells.
Both conditional records are complete, disposed and contain only acknowledged
GET requests. All 58 model requests have complete matching identity receipts,
with stable system/tool hashes per attempt. The unchanged per-attempt limits were
300 seconds, 18 requests and a $1 estimate; no retries, fallback or cap increases.
Credential-free local act checks passed 254 tests (251 pass, three expected skips).
The existing no-model live Drive calibration also passed; no repeat was needed
for this presentation-only change.

Sonnet's four attempts total 23 requests, 46 ordinary input tokens, 5,489 output,
133,109 cache-read and 30,496 cache-creation tokens, with a $0.1902769 native CLI
estimate. Sol totals 35 requests, 623,826 input (including 486,784 cached;
137,042 uncached), 2,251 output including zero reported reasoning, a $0.3452724
observed published-rate estimate and $1.270162 conservative committed accounting.
GPT cache creation and normalized Claude reasoning are unknown. Billing is unknown;
committed accounting is not an additional charge. Across the initial pair and
repaired candidate, Sonnet used 28 requests and $0.2425868 native estimates; Sol
used 45 requests and $0.4690276 usage estimates ($1.777930 committed).
Token bases differ by runner and these are not matched cost-savings measurements.

This completes the bounded local Drive matrix as one-attempt-per-cell feasibility,
not reliability or a single combined invocation. Earlier version-guard, runner and
discovery failures remain unchanged. Hosted Drive, real target-host activation,
shared-drive behavior, a real incompleteSearch response, conditional writes/CAS
and Gmail/Drive composition are not established by this Drive result. The later
[media campaign](#media-composition-results-2026-11-05) qualifies local composition separately.

## Native Codex capability probe

`just eval-native-gmail PROXY_URL NEW_OUTPUT` runs one fresh `read-search` case
with native Codex 0.166.0 and `gpt-6.1-sol`. It is an optional host capability
probe, separate from the required Sonnet/Sol matrix; it does not replace the Sol
Responses performer. It can use the same explicit hosted backend settings.

The native profile has a broader advertised tool surface. It uses an isolated
actor identity/home, workspace sandbox, shell tools disabled, and the trusted
relay's existing request/output/time/cost caps. The relay buffers provider output
and refuses collaboration or unknown executable calls before any reaches the
native process. It retains actual native instructions/tool schemas, usage and
cache keys without warmups or automatic retries. Credential-free integration
checks must exercise native resource/file access, protected-file refusals, and
provider errors before the paid attempt. Native CLI success does not qualify
ChatGPT UI connections or equal performer conditions.

Only this optional profile starts its `act` container with Docker
`seccomp=unconfined`, which permits the user namespaces required by Codex's
bubblewrap sandbox. It adds no capabilities or privileged mode and does not
mount the Docker socket. The native process retains `workspace-write`, excludes
blanket `/tmp` and `TMPDIR` writes, and explicitly approves only the connected
server's `execute` tool. The other performer containers keep Docker's default
seccomp profile. The launcher records these settings in `container-profile.json`.
The synthetic gate verifies an exact owned-file write, protected-file read
refusal, refusal to write an otherwise actor-writable outside directory,
mixed forbidden output, and a one-request upstream 503 without retries. The
outside-write refusal is observed at Codex's project policy; it is not evidence
of a particular kernel denial. See the official
[MCP tool approval setting](https://learn.chatgpt.com/docs/config-file/config-reference).

## Focused direct hosted Gmail results (2026-11-04)

One fresh attachment and pagination attempt per required model passed against the
same protected, production-backed Cloudflare deployment. All four attempts passed
the unchanged version-2 task, method-ordering, actual skill retrieval, identity,
certainty and cleanup criteria. The trusted relay supplied the existing test
account's token directly; no gateway was involved. The resource and method
descriptions now remind the agent to describe each distinct method, including
calls inside helpers, loops and branches. This run combines that hint, hosted
transport and the revised Claude launch controls; it does not isolate their effects.

Sonnet used 13 model requests across its two attempts, reporting 120,764 cache-read
and 32,775 cache-creation input tokens, with a $0.1822384 native CLI estimate.
Sol used 18 requests across its two attempts, reporting 191,452 input tokens
including 141,696 cached tokens, and 1,042 output tokens; its observed
published-rate estimate was $0.1241016. These are separate estimate sources;
provider billing remains unknown. System/tool hashes stayed constant within each
attempt. Cache misses remain visible in individual receipts; no warmups, automatic
retries, repeated completed trials or extra cache probes were purchased.

All four attempts had successful cleanup and no unknown mutations. Their
per-cell source records retain the hosted digest/version and complete source
snapshot. The first saved suite report had an obsolete static sentence denying
hosted qualification; its underlying cell identities and receipts establish the
actual backend. That historical report is preserved, and future reports refer to
the recorded backend explicitly. Earlier failed Sonnet trials and offline
regrades remain failed evidence. This focused four-cell pass does not qualify a
fresh six-case suite, other services, ChatGPT UI, OpenClaw, or native host Skills
activation. See the [deployment identity and limits](../hosted/README.md#direct-hosted-gmail-gate).

The single native Codex/Sol `read-search` pilot failed before any actor Google
call: its first completed provider response omitted the namespace on a valid
`exec` call, which the original relay rejected. The response reported 10,151 input
tokens, zero cache reads and 74 output tokens, a $0.021042 observed published-rate
estimate; its $0.122178 reservation stayed held because the response was refused.
Cleanup succeeded. The guard now accepts that captured producer shape while
still rejecting unknown names, explicit other namespaces and collaboration calls.
The credential-free integration replays the captured opening before its synthetic
MCP/file/refusal checks. The original live pilot remains failed; no paid retry
was made, and native live task completion remains unqualified.

### Gmail/Drive media composition gate

`just eval-media PROXY_URL NEW_ABSOLUTE_OUTPUT all required` runs two independent
cases, `gmail-to-drive` and `drive-to-gmail`, with Sonnet and Sol. The four cells
each retain the existing 300-second, 18-request and $1 estimate caps, with no
retry or fallback. Use `just live-media` first for deterministic forward, reverse
blob and reverse Google-native export controls. Existing grants suffice.

The actor must read the served advanced media-transfer resource before execution,
discover every used native method before that execution, transform the attachment
name, and write only answer.json. Random binary fixture bytes must match independent
Google readback exactly. The reverse case creates a draft, never sends it. Native
create IDs must be recorded in complete trusted ledgers; program output cannot
authorize cleanup. Source content and metadata must remain unchanged. Unnamed MIME
attachments count, so extra attachments fail. Association through a marker or
folder is evidence, never ownership. Cleanup deletes only recorded owned IDs,
checks every known folder for children before deletion, and retains unknown effects
or incomplete inventories as failures. An acknowledged unexpected non-create
mutation remains unreconciled and stops the campaign. Workflow reports provide
per-attempt token, cache and cost metrics. The local results below qualify this bounded media slice; existing Drive
results alone do not qualify media composition.

### Media composition results (2026-11-05)

One fresh required campaign passed all four cells on product bundle
`79857ce86b7dd3e2098e09c0f37f50625a29663b7f15dfa148795c2c27db8915`:
**68/68 criteria**, **34/34 complete model-identity receipts**, zero unknown
effects and complete owned cleanup. Both models retrieved the root Workspace
skill and advanced media-transfer resource before execution and described each
used Google method before its execution. Gmail-to-Drive transformed the filename
in JavaScript and uploaded the exact bytes to the chosen folder. Drive-to-Gmail
used the deployment's pure composeMime snippet and created an unsent draft with
one exact attachment. Independent Google readback checked bytes, SHA-256, MIME,
name, destination and unchanged sources. Each cell was attempted once, with the
existing 300-second/$1 estimate limits and no retry or fallback.

| Case           | Required model / runner        | Criteria | Requests |  Input | Output | Cache read | Cache creation | Estimate USD                        |
| -------------- | ------------------------------ | -------- | -------: | -----: | -----: | ---------: | -------------: | ----------------------------------- |
| gmail-to-drive | Sonnet 5.5 / Claude 2.1.318    | 17/17    |        8 |     16 |   1765 |      79563 |          16071 | 0.0899223 native CLI                |
| gmail-to-drive | GPT 6.1 Sol / responses-loop-3 | 17/17    |        9 | 110262 |    601 |      79616 |        unknown | 0.0752636 usage; 0.226534 committed |
| drive-to-gmail | Sonnet 5.5 / Claude 2.1.318    | 17/17    |        7 |     14 |   1395 |      63831 |          17453 | 0.0901731 native CLI                |
| drive-to-gmail | GPT 6.1 Sol / responses-loop-3 | 17/17    |       10 | 130553 |    520 |     102016 |        unknown | 0.0724756 usage; 0.266306 committed |

Sonnet totals: 15 requests, 30 ordinary input, 3160 output, 143394 cache-read
and 33524 cache-creation tokens; $0.1800954 native CLI estimate. Sol totals:
19 requests, 240815 input **including** 181632 cached tokens, 1121 output
(including zero reported reasoning), $0.1477392 cache-aware published-rate usage
estimate and $0.49284 conservative commitment. GPT cache creation and actual
provider/proxy billing remain unknown. The two input bases are different;
these are observed cache counters, not a controlled cache-savings comparison.
System/tools prefix hashes were stable for all four attempts. The maintained
workflow generated the report directly from retained evidence.

Before inference, the maintained synthetic runner preflight passed without
Google/model calls. The three built-Worker live controls passed 24/24 criteria:
Gmail attachment to Drive, Drive blob to Gmail draft, and native-document export
to Gmail draft. Their cleanup completed without unknown mutations. The corrected
candidate's local act Check passed 279 tests with 3 skips, plus typecheck, bundle
and formatting. Actual workerd tests cover all byte values, the 128 KiB bound,
zero-byte uploads and MIME composition; Node-only tests would have missed the
SDK's absent multipart footer under workerd's stream polyfill.

Raw evidence remains private in the retained media-composition campaign, including
candidate source manifests, live receipts, audit/model/readback/cleanup records and
workflow-generated report. Results documentation was appended after the frozen
source trial. Earlier Drive failures remain unchanged. This is bounded local
one-attempt feasibility; durable artifacts, hosted media and Claude/ChatGPT/OpenClaw
host activation are still unqualified. Issue #11 remains open for its artifact
lifecycle and host-facing delivery work.

### Artifact acceptance cases

The local artifact gate reuses the isolated Sonnet/Sol runners, a dedicated
Gmail fixture and Miniflare's private R2 emulation. Two independent tasks cover a
large native JSON result and a binary Gmail attachment. Each actor must discover
the artifact contract, read its served reference, store the complete native
content, inspect it in a later execution and through MCP Resources, then delete
it. Google source state must remain unchanged.

The trusted verifier checks full stored content before deletion and confirms
unavailability afterward. Actors inspect small resource chunks and return compact
answers; bulk bytes stay out of model history. Storage uncertainty and missing
proof fail the gate. Existing native byte, inline-output, time and spend limits
remain in force. Run `just eval-artifacts PROXY_URL NEW_OUTPUT all required` for four fresh attempts, each under the existing $1 estimate/300-second caps. This gate does not qualify hosted R2,
physical retention or a downloadable file in a target host.

### Artifact agent acceptance (2026-11-05)

All four fresh local cells passed: `large-json` and `binary-attachment` with
Sonnet 5.5 and GPT 6.1 Sol. Each passed all 17 criteria, including ordered
discovery/reference retrieval, later helper and 64-byte resource reads, exact
full R2 content, explicit deletion, empty final bucket, unchanged Google source
and known-fixture cleanup. No retries or unknown effects. The captured candidate
was based on `235a8e8` with the retained artifact-harness diff; production bundle
SHA-256 was `6da4a51959bef5ab8339cafea5b8dab57c266d42dc815f4ea67a75adcb10b77b`.
The pre-trial act check passed 307 tests (304 passed, 3 expected skips), and both
isolated runner preflights passed. Two no-model real Gmail controls passed first.

| Case              | Model  | Requests |  Input | Output | Cache read | Cache creation |            Estimate USD |
| ----------------- | ------ | -------: | -----: | -----: | ---------: | -------------: | ----------------------: |
| large-json        | Sonnet |        8 |     16 |   2454 |     100123 |          22956 |    0.1264083 native CLI |
| large-json        | Sol    |       14 | 121971 |    923 |      77440 |        unknown | 0.106036 published-rate |
| binary-attachment | Sonnet |        8 |     16 |   2745 |     108673 |          23194 |    0.1311253 native CLI |
| binary-attachment | Sol    |       14 | 126829 |    989 |      95360 |        unknown | 0.082364 published-rate |

Sonnet ordinary input/cache counters are separate; Sol input includes cache reads.
Instruction/tool prefixes were stable in all cells. Sol conservative commitments
totaled $0.51672, distinct from its $0.1884 cache-aware usage estimate. Sonnet's
native estimates totaled $0.2575336. Actual billing is unknown. Private retained
evidence includes candidate-source manifests, full audit/readback/storage and
cleanup records and the workflow-generated report. The report-only `readback`
allowlist omission was corrected afterward and a separate offline report retained;
original results and original workflow report remain intact. These one-attempt
results qualify this local artifact candidate, not hosted retention, target-host
download UI, or later runtime changes.

### Pagination helper feasibility (2026-11-05)

Drive `list-pages` version 2 requests `pagination.collect`; its native task grader
is unchanged. One fresh Sonnet and one fresh Sol attempt passed all 17 criteria,
with three acknowledged native pages per helper execution, exact file inventory,
unchanged fixtures and complete owned cleanup. Both read `pagination.md` before
execution and their retained executed programs directly called the collector.
Sol also described `pagination`; Sonnet relied on root/skill discovery and the
reference without calling that helper descriptor. The existing grader proves
native behavior; these helper-use details come from separate trace inspection.
No retries, unknown effects or unattempted cells.

The captured source was based on `b2a8cf3` plus the retained pagination diff;
the exact production bundle SHA-256 was
`fc13b0487cda73733d4792ecb28a1ceb37cfb0f870adb6e707ab73fba007fc11`.
The act check passed 312 tests (309 passes, 3 expected skips), both maintained
Gmail/Drive live workflows passed with helper traversal, and independent runtime,
protocol and preparation checks passed. The earlier artifact agent campaign keeps
its separate source identity; it was not rerun or silently qualified for this
runtime change.

| Model       | Requests | Input | Output | Cache read | Cache creation |             Estimate USD |
| ----------- | -------: | ----: | -----: | ---------: | -------------: | -----------------------: |
| Sonnet 5.5  |        5 |    10 |   1516 |      29189 |          12985 |     0.0700389 native CLI |
| GPT 6.1 Sol |        9 | 86617 |    575 |      49024 |        unknown | 0.0858384 published-rate |

Sol input includes cached tokens; Sonnet's three input counters are separate.
Both retained stable system/tool prefixes and complete model identity receipts.
Sol's conservative commitment was $0.178984, distinct from its usage estimate.
Actual billing is unknown. Full per-attempt metrics and private source/audit/
readback/cleanup evidence remain in the workflow-generated report and retained
campaign. This is bounded local feasibility, not reliability or hosted acceptance.
