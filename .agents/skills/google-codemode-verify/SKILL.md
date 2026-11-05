---
name: google-codemode-verify
description: Verify a Google Code Mode change with the maintained just and GitHub workflows; distinguish credential-free checks, synthetic runner proof, live Gmail/Drive/media, paid agent gates with token/cache/cost reporting, and unverified hosts or Cloudflare deployment.
---

# Verify a candidate

Read [README workflow verification](../../../README.md#workflow-verification)
and [agent gate documentation](../../../tests/eval/README.md) for the selected
path. Product/fixture changes use the delivery procedure when available; this skill
owns proof, not unrelated repairs or deployment authority.

## Prepare and identify

Record `git rev-parse HEAD`, `git status --short`, and the relevant diff/untracked
source bytes with results. Local `act` tests working-tree bytes; remote GitHub tests
its checked-out SHA. A prior pass does not qualify a new candidate. Use new absolute
evidence directories outside the checkout, retain command/exit/output and receipts,
and preserve failed attempts. Inspect `justfile`, `tests/run.mjs`, relevant
workflow and launcher when prerequisites or behavior changed.

Check Node 24, `just`, dependencies (`npm ci --ignore-scripts` when preparation is
authorized), and Docker/`act` readiness for local workflows. Do not read secret
values into logs. For plain checks, credentials and a proxy are unnecessary. A
healthy process is insufficient after a surprising interaction failure: inspect
readiness at the failed boundary and restart only trial-owned state when warranted.

## Select the smallest useful proof

| Goal                                                      | Maintained command                                                | What it establishes                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Ordinary change check                                     | `just check`                                                      | Check workflow in `act`: typecheck, Wrangler dry-run, credential-free tests, formatting                                  |
| Fast host feedback / unavailable compatible Docker runner | `just verify`                                                     | Same `tests/run.mjs check` steps on this host; no claim of `act` compatibility                                           |
| Runner/MCP/file plumbing                                  | `just eval-preflight /absolute/new/evidence`                      | Both isolated runners with synthetic responses; no model, OAuth, or Google calls                                         |
| Saved trial grading                                       | `just eval-regrade /absolute/saved/trial-1 /absolute/new/regrade` | Offline current grader against retained evidence, preserving original results                                            |
| Saved run reporting                                       | `just eval-report /absolute/saved/evidence /absolute/new/report`  | Offline recorded gates and token/cache/cost summary; no inference, OAuth, cleanup or regrading                           |
| Real Gmail behavior                                       | `just live`                                                       | Manual credentialed Gmail workflow through locally built Worker                                                          |
| Real Drive behavior                                       | `just live-drive`                                                 | Manual credentialed Drive download/rename, conditional-option refusal and pagination through locally built Worker        |
| Real attachment composition                               | `just live-media`                                                 | Three built-Worker controls: Gmail to Drive, Drive blob/native export to Gmail draft, exact bytes/MIME and owned cleanup |
| Agent media feasibility                                   | `just eval-media PROXY_URL /absolute/new/evidence all required`   | Two cases × Sonnet/Sol, ordered advanced-resource retrieval, independent readback and four $1 estimates                  |
| Agent feasibility                                         | `just eval-matrix gmail PROXY_URL /absolute/new/evidence`         | Manual paid Sonnet/Sol required pair, one fresh attempt each                                                             |
| Independent Gmail cases                                   | `just eval-gmail PROXY_URL /absolute/new/evidence`                | Six cases, one fresh attempt per model/case, up to twelve $1 estimates                                                   |
| Independent Drive cases                                   | `just eval-drive PROXY_URL /absolute/new/evidence`                | Four cases after Drive consent, one fresh attempt per model/case, up to eight $1 estimates                               |
| Prepare private hosted probes                             | `just hosted-prepare /absolute/new/prepared`                      | Exact source/bundle identity and private dry-run; no deployment                                                          |
| Hosted runtime limits                                     | `just hosted-verify /absolute/new/evidence`                       | Selected deployed version via protected ingress; requires documented `HOSTED_*` inputs                                   |

Maintained suites, helpers and local workflow launchers live under `tests/`;
`.github/` contains GitHub workflows and repository-secret installation, with
commands in `justfile` and the deployment entrypoint at root `deploy.mjs`. Credential-free
checks select `tests/unit/` and `tests/integration/`; credentialed suites in
`tests/live/` run only through the explicit live targets. `just build` and `just deploy --dry-run`
only bundle/validate; `just deploy` publishes and needs deployment scope.

`just live` mutates the dedicated test account: labels/drafts and controlled
self-send. Prerequisites are the matching installed-app client, test user, and
refresh grant. Resolve through `tests/support/credentials.mjs` and README's local setup;
`.test.env` is ignored and client/token overrides are `GOOGLE_OAUTH_CLIENT_FILE`
and `GOOGLE_TEST_TOKEN_FILE`. Inspect existence/readability without printing contents.
The default client and grant live together in the private
`~/.config/google-codemode-mcp/` directory. `just oauth --drive` refreshes and verifies
the saved grant first; a valid account/scope grant needs no browser or replacement.
A missing client file is not proof that the saved grant expired; inspect the
configured credential locations and matching account/client before requesting
consent again. Missing or revoked consent is a prerequisite gap. OAuth, API enablement, GitHub secret
installation and scope changes need their task's existing authority. Drive needs
the additional `drive.file` grant obtained through `just oauth --drive`; the live
fixture creates/deletes only owned files. Serialize the shared account: all live
GitHub workflows use one concurrency group and local live/eval launchers share a
cross-checkout lock. Check remote holders before local credentialed trials.

Before executing or reporting paid agent trials, read the
[paid-run procedure](references/paid-runs.md). It covers the actual local `act` +
CLIProxyAPI entrypoints, campaign selection and caps, candidate-bound acceptance,
and the required per-attempt and campaign token/cache/cost report. Use existing
receipts or offline regrading for reporting/grading questions; a new model call
is not needed to recover recorded metrics. Authoring this skill does not authorize
an additional paid attempt. Use `mafe-si:build-eval` when substantially changing
cases/grading, rather than weakening expectations to turn a run green.

## Observe, retain, and clean up

Inspect the exit status **and** meaningful results: test failures/skips, runner
isolation refusals and exact file bytes, task versus discovery/skill criteria,
model identity, mutation outcomes, and cleanup. A retrieved `skill://` resource is
not proof of host activation. Grading version 4 retains the requirement for every trusted ledger
method to have a matching description completed before execution starts, including
failed and snippet calls. Root discovery and actual skill retrieval must precede
the first execution. Case-required unused-method descriptions must also precede
the first execution when configured. Missing ordinals or incomplete ledgers stay unknown; offline
regrades preserve original results. Conditional Drive case 3 additionally requires
complete trial-owned `product-outbound.json` with Worker disposal and only recognized
normal Drive/Discovery GETs, including the owned file read. The maintained live
Drive workflow calibrates this with read-only and rename/revert controls; versions
and timestamps remain diagnostics. Hosted conditional evaluation refuses before
inference without a recorder. Old conditional traces lack this evidence and cannot
pass the new criterion through regrading. Gmail feasibility does not qualify Drive,
Sheets, Docs, Calendar, target hosts, binary artifacts, or hosted Cloudflare CPU
enforcement. Pending profiles fail before spending; don't silently substitute Gmail.

Live receipts are written as `dist/live-gmail-receipt.json` or
`dist/live-drive-receipt.json` or `dist/live-media-receipt.json` inside the selected workflow;
local `act` retrieves artifacts under `dist/act-artifacts`, remote uploads last
seven days. Copy needed receipts to retained evidence before another build/run.
Record actual SHA/diff separately; don't infer identity from a requested SHA field.
Agent directories retain candidate-source manifests, per-trial audit/model/files/
readback/results, campaign reports, and cleanup. Preserve them after teardown.
Use the workflow's `workflow-report/summary.md` and `summary.json` for the paid-run
handback, checking their recorded gates against authoritative results. For older
or interrupted evidence, generate a separate report with `just eval-report`.
Reporting and offline regrading are distinct operations; neither makes a fresh
actor attempt. A failed report step is a reporting gap, never a passing gate.

An acknowledged write remains acknowledged if a later assertion/evidence write
fails; a missing/unknown outer response can conceal effects. Inspect the ledger,
known fixture IDs and markers before any reconciliation. Never blindly replay a
send or uncertain mutation. Missing cleanup proof is a failed/unknown result,
not permission for mailbox-wide cleanup. Harnesses clean only known owned fixtures;
stop only owned processes, preserve unreconciled markers, and report residuals.

Classify failures: stale instructions, harness gap, product regression, unavailable
prerequisite, or unverified boundary. Fix instructions/harness only within scope,
re-exercise affected behavior, and retain original failures. Preserve expected
product behavior and capture distinct regressions through
[google-codemode-capture](../google-codemode-capture/SKILL.md). Return observed
candidate, commands/results, retained evidence, cleanup, and remaining acceptance.
Updating this verifier follows changed-interface evidence. Recheck affected
commands, receipt fields, budgets, models and links against source; preserve
unrelated qualification limits. No full audit or paid/live trial follows merely
from authoring it.

For media changes, run the maintained workerd integration before live controls:
Node stream behavior alone misses SDK multipart footer differences. In live and
paid receipts verify exact bytes/hash, MIME, transformed name, source preservation,
complete native ledgers and created IDs. The advanced media resource must precede
execution in paid cases. No send is necessary. Cleanup ownership comes only from
fixture-created and trusted acknowledged create IDs. Markers, folder membership
and answer.json IDs never authorize deletion. Inspect folder-child inventory and
unreconciled writes before folder deletion; retained folders or unknown effects
fail cleanup. Live controls cover native export; the paid reverse case uses a blob.
Neither establishes durable artifacts or hosted media qualification.

Optional artifact storage uses `ARTIFACTS_BUCKET` only during deploy/preparation;
absence leaves storage disabled. `just check` includes actual workerd + private
Miniflare R2 proof under `tests/integration/artifacts.test.ts`, with cross-request
and new-Worker reads, large native JSON and cap refusal, binary/chunks/hash, strict JSON, scoped snippet
refusal and preserved native write receipts. Core tests exercise expiry, quotas,
wrong capabilities, deletion and late-put cleanup. For deployment changes also
exercise `ARTIFACTS_BUCKET=synthetic-private-artifacts just deploy --dry-run`;
this validates binding configuration without provisioning or publishing.

A stored artifact URI is a bearer capability, not stable user identity. Inspect
separate trusted artifact outcomes/references after program/output errors. A
pending write retains an unknown outcome and tentative URI; completion-aware
cleanup is best effort. Request-context cleanup and access expiry do not establish
physical R2 retention. Bucket lifecycle, hosted storage, real-agent artifact use
and native host downloadable-file presentation stay unqualified until separately
exercised. The four passing media cells qualify cf98b51; they do not silently
qualify later artifact code or an R2-enabled hosted deployment. Avoid new paid
runs merely to report these existing metrics.
