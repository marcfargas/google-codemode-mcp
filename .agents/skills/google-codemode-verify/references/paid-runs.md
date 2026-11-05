# Run and report paid agent verification

Use this when a change needs fresh agent feasibility evidence or when reporting
an existing run. The gate uses the actual MCP backend, isolated actor, discovery,
Workspace resource read, file capture and independent Google readback. Passing a
model task alone does not pass the mechanism or cleanup criteria.

## Select, prepare and run

1. Recover the authorized service/cases, backend, models, attempt count and spend
   ceiling. Read [the maintained gate guide](../../../../tests/eval/README.md),
   [case/model selection](../../../../tests/eval/campaign.ts), and
   [the launcher](../../../../tests/eval/act.mjs) when those inputs changed.
   Defaults are Sonnet 5.5 (`sonnet`) and GPT 6.1 Sol (`sol`), one fresh attempt
   per case/model. Gmail has six cases, at most twelve $1 estimates; Drive has
   four cases, at most eight $1 estimates. Media has two cases, at most four $1 estimates, and requires ordered advanced-media resource retrieval. Use explicit case/model selections
   for a bounded subset. A subset does not qualify missing required cells.
2. Identify the candidate: actual Git revision, dirty/untracked source,
   `candidate-source.json` and retained source bytes; then each cell's
   `source.json` backend, case/version, runner/version, grading/accounting
   versions and source hashes. A requested SHA or a prior pass is insufficient.
   The report's `sourceReceiptSha256` identifies the exact source receipt;
   compare its retained file hashes to resolve dirty harness identity.
   Hosted acceptance also needs the actual protected deployment/version identity.
3. Run affected deterministic checks and `just eval-preflight NEW_ABSOLUTE_OUTPUT`
   before spending when runner/MCP/file behavior changed. This preflight exercises
   both isolated runners with synthetic responses and needs no OAuth, Google or
   model calls. Confirm the matching test-account grant/scopes and client through
   the maintained credential resolver without printing them. Check remote live
   holders; the launcher uses the same cross-checkout account lock as live tests.
4. Use the local marcdev CLIProxyAPI with its advertised exact model IDs and
   existing key delivery. The workflow refuses GitHub-hosted inference before
   fixtures or models. Model catalog verification is metadata-only; do not send
   warm-up inference or add padding. Stable instructions/tools permit provider
   caching, but only returned counters establish a hit. On surprising misses or
   input growth, inspect request bytes and retained `systemHash`/`toolsHash` values and request payloads before spending
   on a larger campaign. The local, explicit `ACT_NODE_OPTIONS` option is retained
   in `container-profile.json`; it is not a product network setting.
5. Run the selected maintained command into a new absolute directory outside the
   checkout. For example:

   ```sh
   just eval-media PROXY_URL NEW_OUTPUT all required
   just eval-drive PROXY_URL NEW_OUTPUT all required
   just eval-gmail PROXY_URL NEW_OUTPUT attachment,pagination required
   ```

   Replace both placeholders. `PROXY_URL` is the existing local proxy base URL;
   `NEW_OUTPUT` must not already exist. Optional trailing selections are defined
   by the just recipes and current registry; do not invent model aliases.

The per-attempt limits are 300 seconds wall time, 18 model requests, 2,048 output
tokens per request and a 15,000 total output allowance. Claude has a $1 native CLI
estimate ceiling; GPT has a $1 published-rate reservation ceiling. These are
estimates, not a campaign-wide $1 limit or a proxy billing guarantee. Do not raise
caps, retry, fall back, or add a cache-observation repetition without scope for
that additional attempt. The existing campaign stops after infrastructure,
unknown-effect or cleanup failures and retains later cells as unattempted.

## Inspect acceptance and retained evidence

Start with the workflow-generated `workflow-report/summary.md` and `summary.json`.
The workflow runs the deterministic report step even after an evaluation failure
and appends its Markdown to `GITHUB_STEP_SUMMARY` when available. It reads saved
evidence only. For an older run or interrupted report step, run:

```sh
just eval-report /absolute/saved/evidence /absolute/new/report-directory
```

The new directory must not exist; never overwrite existing evidence or reports.
This command does not call Google or models, perform cleanup, or regrade anything.
The JSON report retains metric coverage and unknown counts; the Markdown is the
normal human handback. Neither report replaces authoritative gate results.
Inspect any missing/malformed evidence and reporting failures explicitly rather
than buying another attempt to recover metrics. Keep raw evidence private; the
summary allowlists fields and omits account/file identifiers, prompts, raw
payloads, private paths and freeform error/evidence text.

Read `suite-results.json` and each case's `matrix-results.json`, not only the
Markdown headline. Count case/model pairs: the suite's `unattempted` list names
cases, while matrices also retain unattempted cells within an attempted case.
Report selected, attempted, pass, score-fail, error and unattempted counts; retain
attempts that failed or spent tokens before a task completed.

For every attempted pair, inspect `trial-N/result.json`, `actor-result.json`,
`model-receipts.jsonl`, `mcp-attempts.jsonl`, `mcp.jsonl`, captured files,
independent `observation.json` and fixture/cleanup evidence. Verify task criteria,
causal root/method discovery, actual skill retrieval, requested/served model,
successful terminal execution, known mutation outcomes and complete owned-fixture
cleanup. Grading version 4 may require an unused method description before the
first execution. Missing evidence remains unknown; narrative success cannot fill
it. Conditional Drive case 3 needs the trial's complete `product-outbound.json`,
including `workerDisposed: true`, recognized read routes and an acknowledged owned
read. A fresh Worker owns each trial; fixture setup/readback/cleanup bypass this
recorder. Incomplete coverage or uncertain writes stops later actors. Version and
timestamps are diagnostic. Historical conditional evidence has no recorder and
remains unknown under this criterion; original grades stay intact. Hosted
conditional runs currently stop before inference. Resource retrieval does not establish Claude, ChatGPT or OpenClaw activation.

Use `just eval-regrade SAVED_TRIAL NEW_OUTPUT` for a grading question. It makes no
Google/model/cleanup calls, preserves original errors and grades, and records the
current grader separately. A regrade is not fresh execution of a changed product.
Never overwrite the source evidence or replace a failed trial with a later pass.

## Report tokens, cache and cost

Every paid-run handback includes metrics beside the gate result, both per
case/model attempt and aggregated for the selected campaign. Use the generated
report rather than manually reconstructing totals. Check its coverage before
quoting a complete total, and retain report-generation failures alongside the
original gate. `just eval-preflight` exercises the workflow's report step with an
explicitly synthetic failed/passing campaign; it is no evidence of paid model or
Google acceptance. Read the maintained
[actor summaries](../../../../tests/eval/actor.ts),
[Responses summaries](../../../../tests/eval/responses.ts) and
[Responses accounting](../../../../tests/eval/responses-relay.ts) if telemetry
changes. Raw nested attribution and stream counters are not additional usage.

| Measurement           | Retained source and interpretation                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests and identity | Unique relay `request` records in `model-receipts.jsonl`, matched to retained model requests and response identities. Count complete/incomplete requests and separately note known local rejections before inference. Missing logs make coverage unknown. Include requested/served model and runner/version.                                                                                                                          |
| Input/output          | `actor-result.json` → `usage.totals` with `totalsSource`. Claude uses the one terminal native result; its assistant observations are partial. Responses sums terminal response usage. Never add these totals to their per-turn or raw receipt representations.                                                                                                                                                                        |
| Cache reads/creation  | `usage.totals.cacheReadInputTokens` and `cacheCreationInputTokens`. Keep reads and writes separate. For GPT, cached reads are included in `inputTokens`; derive uncached input as input minus reads only when both are known and valid. Claude native input, cache-read and cache-creation counters are separate; preserve that basis. Missing GPT cache creation stays unknown, even if an upstream extension reports another field. |
| Reasoning             | Responses `usage.totals.reasoningOutputTokens` when present. It is part of output, not additional output. Other runners may not report it.                                                                                                                                                                                                                                                                                            |
| Claude estimate       | `usage.nativeResults[].cliEstimatedCostUsd`, retaining the native CLI estimate label. Do not substitute a token-derived estimate or add duplicate terminal results.                                                                                                                                                                                                                                                                   |
| GPT usage estimate    | Per-request `usagePublishedRateEstimateUsd`, or the final complete `cumulativeUsagePublishedRateEstimateUsd`, using the receipt's recorded pricing/date. They are alternative representations, not amounts to add together. Cache discounts apply only to observed valid cached tokens.                                                                                                                                               |
| GPT budget accounting | The final `totalCommittedEstimateUsd` / `estimatedUsdUpperBound`, and per-request `reservationUsd`, `settledUsd`, `heldUsd`, `settlementReason`. This conservative budget accounting settles verified input at uncached rates; it differs from cache-aware usage cost. Never sum cumulative values across requests.                                                                                                                   |
| Billing               | Actual provider/proxy billing only when separately available. `providerBilledCostUsd: null` means unknown. Neither CLI nor published-rate estimates establish billing.                                                                                                                                                                                                                                                                |

Keep models/runners separate before showing campaign totals. Sum only disjoint
attempts with the same counter meaning; do not present a mixed-model `inputTokens`
sum as a comparable uncached-input total. If a metric is missing for any included
attempt, report the known subtotal plus its measured denominator and unknown
count, rather than a falsely complete total. An unattempted cell has no measured
usage; do not silently equate missing usage with zero cost. Failed or incomplete
requests retain observed usage and held reservations.

A compact handback can use one row per case/model with full gate, request count,
input, output, cache reads/creation, reasoning where known and labeled cost
estimates. Follow it with campaign counts, model-separated totals, cache coverage,
cleanup/unknown outcomes and billing availability. Label a cache ratio with its
actual denominator; do not compare savings across different candidates or runners
without matched evidence. A single passing attempt establishes feasibility for
that case and candidate, not reliability or a broader benchmark.
