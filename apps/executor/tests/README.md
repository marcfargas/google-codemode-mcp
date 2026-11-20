# Development and verification

For change delivery, use the [project verifier](../../../.agents/skills/google-codemode-verify/SKILL.md)
and its [case/evidence selection procedure](../../../.agents/skills/google-codemode-verify/references/change-verification.md).
Select existing checks by affected behavior, reuse applicable retained evidence,
and run fresh paid cells only for unresolved agent behavior. `just check` qualifies
its deterministic checks; agent and hosted acceptance remain separate.

Executor test suites and infrastructure live here: `unit/` for isolated checks,
`integration/` for Worker, HTTP, CLI and runner checks, `live/` for credentialed
Google checks, and `fixtures/`, `support/`, `eval/` and `hosted/` for their helpers.
`.github/` contains GitHub workflows and repository-secret installation. Local
workflow launchers live in `apps/executor/tests/`; the deployment entrypoint is `apps/executor/deploy.mjs`. Commands are
exposed through `justfile`. Use Node 24, Docker, `act` and `just`; repository-secret
installation also needs authenticated `gh`.
GitHub and local checks invoke `apps/executor/tests/run.mjs` directly.

Local workflow launchers can set `ACT_NODE_OPTIONS` to pass Node options verbatim
to the container. For a local network-family selection timeout, use
`ACT_NODE_OPTIONS=--no-network-family-autoselection just live-drive`. This changes
only Node in that invocation; it does not configure the Worker or GitHub runner.
Live runs retain the current source files, hashes and baseline/diff identity under
`dist/act-artifacts/candidate-*`, alongside the workflow's fixture receipt. The
receipt's `source` field alone identifies the baseline commit, not dirty bytes.

```sh
npm ci --ignore-scripts
just check       # Run the credential-free Check workflow in act
just verify      # Run its steps directly for fast feedback
just live        # Run the explicit Live Gmail workflow in act
```

Check runs on pushes and pull requests with no OAuth credentials. Live Gmail is
manual-only on `main`, serialized in GitHub, and receives only its three required
repository secrets. Local `act` copies the working tree respecting `.gitignore`,
uses explicit env/secret files, and does not bind-mount the repository or expose
its account-password file to the container. It tests current working-tree bytes;
a remote run tests its checked-out commit.

## Select a check

Run commands from the repository root. Gateway unit/integration checks belong in
`apps/gateway/tests`; only cross-app integration checks live in root `tests/integration`.
Ordinary checks make no Google or model requests.

| Command                                      | What it checks                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `just check`                                 | GitHub Check workflow through local `act`: types, builds, tests, formatting        |
| `just verify`                                | The same check steps directly on the host                                          |
| `just live`                                  | Real Gmail reads, owned label/draft CRUD and controlled self-send                  |
| `just live-drive`                            | Real owned Drive download, rename, pagination and conditional-option refusal       |
| `just live-media`                            | Real Gmail/Drive composition, native export and 256 KiB stored round trip; no send |
| `just eval-preflight /absolute/new/evidence` | Both isolated actor runners with synthetic responses; no inference                 |

Live tests require the isolated test account below. Cleanup acts only on trusted
fixture IDs. Unknown effects and failed cleanup remain failures, never permission
for broad mailbox or folder cleanup. The live workflow tests the built Worker
locally; actual hosted/native-host acceptance is separate.

## Agent evaluations

Use the [maintained agent gate](eval/README.md) for case selection, model identities,
budgets, fixture isolation and historical results. These runs are on demand and
use the local CLIProxyAPI; ordinary CI does not spend model tokens.

```sh
just eval-gmail http://127.0.0.1:8317 /absolute/new/gmail-evidence
just eval-drive http://127.0.0.1:8317 /absolute/new/drive-evidence
just eval-media http://127.0.0.1:8317 /absolute/new/media-evidence all required
just eval-artifacts http://127.0.0.1:8317 /absolute/new/artifact-evidence all required
```

Sonnet 5.5 and GPT-6.2 Sol are required. GPT-6.2 Astra and other probe/reference
cells are explicitly selected. One attempt
per cell, no retries or model fallback. Reuse relevant retained evidence before
spending; each fresh attempt has its five-minute, request/output and $1 estimate
limits. Estimates are distinct from billing.

Workflows generate `workflow-report/summary.md` and `summary.json`, including
unattempted cells, cleanup, token/cache/cost counters and unknown measurements.
Regenerate without inference or Google calls:

```sh
just eval-report SAVED_EVIDENCE NEW_REPORT_DIRECTORY
just eval-verify SAVED_EVIDENCE NEW_REPORT_DIRECTORY
```

`eval-verify` fails on incomplete/failed/synthetic acceptance. Neither command
establishes that old evidence applies to changed source. See the guide's
[report contract](eval/README.md#generated-run-reports).

## Deployment and hosted controls

[DEPLOYMENT.md](../../../DEPLOYMENT.md) owns deployment, OAuth gateway, Access,
bindings and direct HTTP examples. The [hosted controls](hosted/README.md) retain
exact versions, receipts, CPU/timeout/isolation observations and their limits.
Synthetic hosted controls make no Google or model calls; they do not prove
real-account behavior or native-host file presentation.

## Test account OAuth and CI secrets

The installed-app client lives at
`~/.config/google-codemode-mcp/test-oauth-client.json`, beside the retained refresh
grant. If this durable client is absent, the helper imports the original
`/tmp/google-codemode-mcp-oauth-client.json` once after validating the client and
any existing grant's account/client binding. A missing client file does not mean
that renewed consent is needed. The ignored `.test.env` provides
`GOOGLE_TEST_USER`, `GOOGLE_TEST_PASSWORD`, and `GOOGLE_TEST_TOPT_KEY` (that spelling
matches the supplied file). Password and authenticator seed remain local. The
CLI uses PKCE, a random OAuth state, and a temporary localhost callback.

```sh
just oauth                       # Refresh and verify the existing grant; consent if needed
just oauth --drive               # Also require the Drive file scope
just oauth --reauth              # Explicitly request fresh consent
just oauth --automate            # Use Playwright only when consent is needed
just github-secrets              # Install OAuth client, refresh grant, expected user
just live
```

`just oauth` first refreshes the saved grant and verifies the actual granted
scopes and expected Gmail account. A valid grant requires no browser and is not
rewritten. Consent starts only when no grant exists, Google explicitly reports
`invalid_grant`, a requested scope is missing, or `--reauth` is supplied. Network,
client authentication, malformed credential and account-verification failures
stop without starting consent or replacing the existing grant.
If the existing grant lacks the requested Gmail scope, account verification runs
on the newly consented grant before replacing the old one.

Automated consent uses Playwright; install its Chromium with
`node_modules/.bin/playwright install chromium` or set `GOOGLE_CHROME_PATH` to an
existing compatible executable. Google can reject automated sign-in. In that case
use interactive `just oauth`. Open its authorization URL in your own
browser, complete consent, then paste the full localhost redirect URL into the
waiting CLI. A failed localhost page is expected when the browser runs on another
machine; no port forwarding is required. Paste input is hidden and is also accepted
through stdin for private file delivery. Use the URL from the same still-running
consent attempt. Browser-copied addresses that omit the `http://` prefix are also
accepted. Automatic localhost callbacks still work.

Consent requests `gmail.modify` (plus `drive.file` with `--drive`), verifies the
granted scopes and expected Gmail profile, then atomically saves the refresh
grant and binding metadata at `~/.config/google-codemode-mcp/test-oauth.json`.
The default credential directory is private (0700); installed client and grant
files are private (0600). Override inputs with `GOOGLE_OAUTH_CLIENT_FILE` and
`GOOGLE_TEST_TOKEN_FILE` when needed. Explicit overrides win; an invalid override
never falls back to another client or grant. No refresh
credential is stored in the repository. In Google's External/Testing mode, Gmail
refresh grants expire after seven days; renew consent and reinstall the secret.

GitHub secrets are `GOOGLE_OAUTH_CLIENT_JSON`, `GOOGLE_TEST_REFRESH_TOKEN`, and
`GOOGLE_TEST_USER`. `just github-secrets` passes values over stdin, never argv.
The helper's `--client-only` option installs the client and expected user before a
grant exists. Missing or invalid live credentials fail the job; they do not skip
it. Password/TOTP are not required by CI.
