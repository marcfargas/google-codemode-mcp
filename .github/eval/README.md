# Agent feasibility gate

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
and inspecting methods before executing. Grading and budgets remain unchanged.

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
directory into `act` and uses host networking to reach the local proxy. Exact
advertised model IDs are checked before OAuth or fixtures; metadata availability
does not establish successful inference.

Claude runs through the pinned native CLI. GPT runs through a small isolated
Responses loop (`responses-loop-2`), with tools copied from the actual MCP server,
resource-list/read tools, and bounded UTF-8 workspace Read/Write tools. It sends
self-contained history with storage disabled and preserves returned reasoning
items and function outputs. It has no shell or built-in remote tools. This is a
model feasibility comparison across two runners, not native Codex, ChatGPT, or
OpenClaw host qualification. Native Codex reached the MCP revision in a probe,
but its available configuration did not establish the narrow tool surface used
by this evaluation.

Before live trials, synthetic loopback checks exercise both runners, including
actual bundled GPT process isolation and file access refusals. Run these alone
without credentials, inference, or Google requests:

```sh
just eval-preflight /absolute/new/preflight-directory
```

The GitHub **Agent feasibility** workflow is also manual. Select a single `model`
or a matrix `selection`. It needs the three Google test secrets documented in the
root README plus `CPA_CLIENT_API_KEY` and a proxy URL reachable from that runner.
A localhost proxy on the developer machine is not reachable from a hosted runner.
No proxy is provisioned or exposed by this workflow. GitHub evidence artifacts
retain private test content for seven days; local evidence remains in the selected
external directory. Ordinary push and PR checks never invoke models.

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

Drive (find/read a fixture file), Sheets (read/update a fixture cell), Docs
(read/append to a fixture document), and Calendar (find/update a fixture event)
are named coverage targets. They are unsupported by the current product and
must remain visible as pending. Selecting an unsupported service profile (including profile `all`) fails
coverage before spending on a model. Gmail success does not qualify those APIs.

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

Each cell has a five-minute wall deadline, at most 18 model requests, at most
2,048 output tokens per request, and a conservative 15,000 total output allowance.
Claude additionally has a $1 native CLI estimate ceiling. GPT reserves input bytes
plus framing and output allowance against a $1 published-rate estimate ceiling;
accounting version 2 settles both input and output reservations only after a
unique completed response passes model identity and usage validation. Budget
settlement uses the uncached input rate, even when cache reads are reported.
Missing or uncertain usage retains both reservations. Six cells therefore allow up to six $1 estimates,
not a $1 campaign budget. These limits are not proxy billing guarantees.

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

The current method criterion verifies that a method description was retrieved;
it does not verify every called method or enforce ordering. Sonnet first used
memorized list/get calls, then described the send, modify, and attachment methods
before its second execution. Its existing-gate pass therefore does not prove full
adherence to the instruction to describe every method before use. A stricter
criterion needs its own declared version and retained baseline, rather than
retroactively changing these results.

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
