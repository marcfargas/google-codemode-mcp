---
name: google-codemode-verify
description: Decide which slow verification tier a Google Code Mode change needs (live Google account, paid agent evaluation, hosted controls) and run it without colliding on the shared test account. The justfile and the test guides hold the commands.
---

# Verify a change

`just --list` shows the commands.
[Development and verification](../../../apps/executor/tests/README.md), the
[agent gate guide](../../../apps/executor/tests/eval/README.md) and the
[hosted controls](../../../apps/executor/tests/hosted/README.md) explain them.
This skill adds the decisions they leave open.

## Which tier a change needs

The credential-free check runs on every PR. It builds both Workers and runs
every unit, integration and preflight test, including stored artifacts on
workerd with Miniflare R2, the gateway's OAuth provider and the two-Worker
gateway/executor seam. The tiers below are slow, mutate a real account or cost
money. Run one when the owner asks, or when the change alters what it
exercises:

| Tier                                           | Exercises                                                                         | A change that triggers it                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live (`live`, `live-drive`, `live-media`)      | The built executor Worker against the real Google test account                    | Executor code between `execute` and Google: dispatch, runtime, media and stored-artifact transfers, the pagination helper, or the live fixtures       |
| Paid agent evaluation (the `eval-*` campaigns) | A model that reads the served skill and `describe` output and then uses the tools | What an agent reads (served skill text, `describe` output, tool descriptions) or the gate itself (runners, cases, graders under `tests/eval/`)        |
| Hosted (`hosted-*`)                            | A deployed, Access-protected Worker                                               | None by itself: it needs a deployment and `HOSTED_*` settings that only the owner supplies. Report that hosted behavior is unverified for the change. |

- Take the live recipe for the service the change touches; a transfer or media
  change takes `live-media`.
- Paid evaluation spends the owner's money: each case and model cell is capped
  at a $1 estimate, and a default suite is up to twelve cells. Select only the
  cases the change affects, with the required model pair, through the recipe's
  trailing arguments. Do not repeat a cell to get a pass or add a second trial.
  One attempt per cell is the gate's design, and a failed cell is a result to
  report.
- When only runner, MCP or file plumbing changed, `eval-preflight` exercises it
  with synthetic responses and no spend.
- No live tier reaches `apps/gateway`. The credential-free check covers gateway
  changes; its hosted OAuth behavior is open acceptance in
  [#5](https://github.com/marcfargas/google-codemode-mcp/issues/5), not
  something to probe during a change.
- Documentation and developer-skill changes need no slow tier. The served
  Workspace skill is not documentation in this sense; see
  [google-codemode-docs](../google-codemode-docs/SKILL.md).
- For a change limited to Wrangler or deploy settings, run the deploy recipe
  with `--dry-run` and read the bindings and variables Wrangler prints for the
  effective values. It shows configuration, not admission: Access policy is
  applied in Cloudflare, not by the deploy.
- When cases or grading change substantially, use `mafe-si:build-eval` instead
  of loosening an expectation until a run passes.

## The shared test account

Every live and paid run, from any checkout or worktree and from GitHub, uses
the one dedicated Google test account. Local credentials resolve from
`~/.config/google-codemode-mcp/`, not from the checkout, so a worktree isolates
nothing.

- **Two locks that do not see each other.** Local launchers take one host lock
  shared across checkouts. The GitHub workflows share one concurrency group. A
  local run and a GitHub run can still overlap, and each then sees the other's
  fixtures and cleanup, which produces failures that look like regressions.
  Before a local credentialed run, confirm no Live or Agent feasibility
  workflow run is in progress (`gh run list --status in_progress`).
- **The `main` guard does not apply locally.** The workflows run only on
  `main`, but the local launchers supply a main-branch event, so the live and
  paid recipes mutate the real account from any branch; `live` also sends one
  message to the account itself. Run them deliberately, not as a routine step
  before a PR.
- **Read the receipt before running again.** A live run leaves its fixture
  receipt under `dist/act-artifacts/1/`, and the next local run replaces it.
  After a failed or unknown cleanup, that receipt is the only record of the run
  marker and fixture IDs to reconcile. The harness removes only fixture IDs it
  recorded; report what it could not reconcile and do not clean the mailbox or
  Drive more broadly.
