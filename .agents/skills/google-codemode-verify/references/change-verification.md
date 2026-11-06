# Select evidence for a change

Use this during delivery's verification phase, before choosing live or paid runs.
The existing gate guide and case registries own prompts, grading and coverage;
this procedure selects their evidence. Keep the decision and raw evidence in the
task worklog, with only the useful result in the delivery report.

1. Identify the affected behavior and callers from the diff, including shared
   runtime, served instructions, fixtures and runner changes. Inventory the
   relevant deterministic checks and existing agent cases before adding any.
2. Select the smallest checks that can resolve the acceptance question. Record
   selected versus available cases/models and what remains outside the selection.
   The table below gives starting points, not automatic paid-run requirements.
3. Inspect retained evidence first. For reuse, compare relevant source bytes/hashes
   in `candidate-source.json` and each `source.json`, transitive inputs, case,
   grader, runner, model/settings and backend/environment. Record what is unchanged
   and why it supports the claim. A different commit can preserve relevant inputs;
   an identical source hash cannot establish an unchanged live environment.
4. For reporting questions use `just eval-report SAVED NEW_REPORT`; for rubric-only
   changes use `just eval-regrade SAVED_TRIAL NEW_REGRADE` and retain both grades.
   Regrading cannot qualify changed product behavior. Fresh execution is needed
   only where changed inputs or missing evidence leave relevant behavior unresolved.
5. Run affected deterministic checks first. If fresh inference is needed, use the
   [paid-run procedure](paid-runs.md): explicit cases/models/attempts/backend and
   spend bounds, synthetic preflight when plumbing changed, no retry or warm-up.
   Inspect actual cache counters and prefix stability before expanding a run;
   missing counters are unknown, zero reads a miss. Reuse avoids inference entirely.
6. Consume selected retained acceptance with `just eval-verify SAVED NEW_REPORT`.
   It writes the existing usage/gate report even when it refuses incomplete,
   synthetic or failed evidence. For separate invocations, check each retained
   selection; do not combine source directories or overwrite earlier failures.
   Current-source relevance remains the comparison in step 3, not a CLI guarantee.

| Affected contract                                         | Existing proof to select                                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery, method execution guidance, `skill://` ordering | Dispatcher/protocol and mechanism checks; representative affected Gmail/Drive cases if agent adherence changed                                              |
| Gmail tasks                                               | Six independent cases: `read-search`, `reply`, `attachment`, `labels`, `pagination`, `failure`                                                              |
| Drive tasks                                               | Four cases: `read-file`, `list-pages`, `rename-file`, `conditional-update-unsupported`                                                                      |
| Pagination helper                                         | Built-Worker/live pagination controls; Gmail `pagination` and/or Drive `list-pages`, inspecting actual helper use and ordered resource reads                |
| Gmail/Drive file composition                              | Workerd media integration, live media controls; two media cases, `gmail-to-drive` and `drive-to-gmail`                                                      |
| Stored artifacts                                          | Workerd/R2 artifact integration; two artifact cases, `large-json` and `binary-attachment`; HTTP downloads use exact-byte no-model controls                  |
| Runner, isolation, accounting, reporting                  | Owning unit/integration checks; `just eval-preflight NEW_OUTPUT` for changed runner/MCP/file plumbing. Synthetic results do not establish agent feasibility |
| Gateway authentication, ownership and client transfers    | Gateway auth checks and root two-Worker integration; live S3 signature acceptance and native host connections require their own selected proof              |
| Hosted limits, deployment or native host behavior         | Maintained hosted controls or actual host journey; local actor passes cannot replace these boundaries                                                       |

Case definitions live in `apps/executor/tests/eval/{cases,drive,media,artifacts}.ts`; current
versions and required Sonnet/Sol roles come from those registries and `matrix.ts`.
A common contract needs an owning check, not a separate matrix for every skill.
Preserve cases that exercise distinct failure mechanisms. Sheets, Docs and
Calendar remain pending and cannot substitute a Gmail pass.

For handback, state the candidate and relevant source-equivalence decision,
selected/available cases and models, reused versus fresh results, grader/backend
identity, task/mechanism gates, cleanup/unknown effects and remaining acceptance.
Use the generated report for per-attempt and model-separated request/token/cache/
cost metrics, including failed attempts and unknown billing. Optional model score
failures remain informational; uncertainty, infrastructure or cleanup failures
block the selected run. A focused pass qualifies only its declared selection;
it does not establish the full pair, reliability, an untouched partition or
native host activation.

`just check` remains credential-free and inference-free. Paid evaluation is an
explicit verification step; neither a green Check workflow nor successful report
generation establishes agent acceptance. `eval-verify` consumes saved grades and
completion evidence, without rerunning oracles or enforcing GitHub branch rules.
