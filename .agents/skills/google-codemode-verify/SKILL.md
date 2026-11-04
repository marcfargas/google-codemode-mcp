---
name: google-codemode-verify
description: Verify a Google Code Mode change with the maintained just and GitHub workflows; distinguish credential-free checks, synthetic runner proof, live Gmail, paid agent gates, and unverified hosts or Cloudflare deployment.
---

# Verify a candidate

Read [README workflow verification](../../../README.md#workflow-verification)
and [agent gate documentation](../../../.github/eval/README.md) for the selected
path. Product/fixture changes use the delivery procedure when available; this skill
owns proof, not unrelated repairs or deployment authority.

## Prepare and identify

Record `git rev-parse HEAD`, `git status --short`, and the relevant diff/untracked
source bytes with results. Local `act` tests working-tree bytes; remote GitHub tests
its checked-out SHA. A prior pass does not qualify a new candidate. Use new absolute
evidence directories outside the checkout, retain command/exit/output and receipts,
and preserve failed attempts. Inspect `justfile`, `.github/run.mjs`, relevant
workflow and launcher when prerequisites or behavior changed.

Check Node 24, `just`, dependencies (`npm ci --ignore-scripts` when preparation is
authorized), and Docker/`act` readiness for local workflows. Do not read secret
values into logs. For plain checks, credentials and a proxy are unnecessary. A
healthy process is insufficient after a surprising interaction failure: inspect
readiness at the failed boundary and restart only trial-owned state when warranted.

## Select the smallest useful proof

| Goal                                                      | Maintained command                                                | What it establishes                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Ordinary change check                                     | `just check`                                                      | Check workflow in `act`: typecheck, Wrangler dry-run, credential-free tests, formatting |
| Fast host feedback / unavailable compatible Docker runner | `just verify`                                                     | Same `.github/run.mjs check` steps on this host; no claim of `act` compatibility        |
| Runner/MCP/file plumbing                                  | `just eval-preflight /absolute/new/evidence`                      | Both isolated runners with synthetic responses; no model, OAuth, or Google calls        |
| Saved trial grading                                       | `just eval-regrade /absolute/saved/trial-1 /absolute/new/regrade` | Offline current grader against retained evidence, preserving original results           |
| Real Gmail behavior                                       | `just live`                                                       | Manual credentialed Gmail workflow through locally built Worker                         |
| Agent feasibility                                         | `just eval-matrix gmail PROXY_URL /absolute/new/evidence`         | Manual paid Sonnet/Sol required pair, one fresh attempt each                            |

All maintained helpers/tests live under `.github/`, commands in `justfile`; there is
no root `scripts/`, root `tests/`, or npm task layer. Keep new verification support
there if within the requested change. `just build` and `just deploy --dry-run`
only bundle/validate; `just deploy` publishes and needs deployment scope.

`just live` mutates the dedicated test account: labels/drafts and controlled
self-send. Prerequisites are the matching installed-app client, test user, and
refresh grant. Resolve through `.github/secrets.mjs` and README's local setup;
`.test.env` is ignored and client/token overrides are `GOOGLE_OAUTH_CLIENT_FILE`
and `GOOGLE_TEST_TOKEN_FILE`. Inspect existence/readability without printing contents.
Missing consent is a prerequisite gap; don't automatically run OAuth, enable APIs,
install GitHub secrets, or change scopes. Serialize use of the shared account;
GitHub workflows share a concurrency group but `just live` has no local account
lock. Check for other local/remote holders before credentialed trials.

Agent trials additionally need the authorized proxy/model selection and credentials
described in the gate docs. Its local launcher locks across checkouts. Follow its
five-minute/$1-estimate/request/token caps and fail-stop behavior; no performer
retries or fallback. Optional probe/reference scores never substitute for required
cells. Record requested/served model, runner, case/source hashes, all usage/cache
receipts, and cleanup; missing billing/cache counters stay unknown. A repeat for
cache observation requires explicit scope. Prefer offline regrading for a grading
question; never mutate saved evidence. Use `mafe-si:build-eval` when substantially
changing cases/grading, rather than weakening expectations to turn a run green.

## Observe, retain, and clean up

Inspect the exit status **and** meaningful results: test failures/skips, runner
isolation refusals and exact file bytes, task versus discovery/skill criteria,
model identity, mutation outcomes, and cleanup. A retrieved `skill://` resource is
not proof of host activation. Current discovery grading checks a method retrieval,
not every used method or ordering. Gmail feasibility does not qualify Drive,
Sheets, Docs, Calendar, target hosts, binary artifacts, or hosted Cloudflare CPU
enforcement. Pending profiles fail before spending; don't silently substitute Gmail.

Live receipts are written as `dist/live-gmail-receipt.json` inside the workflow;
local `act` retrieves artifacts under `dist/act-artifacts`, remote uploads last
seven days. Copy needed receipts to retained evidence before another build/run.
Record actual SHA/diff separately; don't infer identity from a requested SHA field.
Agent directories retain candidate-source manifests, per-trial audit/model/files/
readback/results, campaign reports, and cleanup. Preserve them after teardown.

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
Updating this verifier follows changed-interface evidence; no full audit or live
trial follows merely from authoring it.
