# google-codemode-mcp

Google Workspace through native Google APIs and server-side JavaScript Code Mode.
Discover methods, transform their results in code, and move files between Gmail,
Drive and temporary storage without passing file bytes through the model or MCP.
**Gmail v1 and Drive v3 are supported.** Sheets, Docs and Calendar come later.

## Which models work?

**Use Sonnet 5.5 or GPT 6.1 Sol.** Both passed bounded Gmail/Drive agent evaluations
with method discovery, actual skill-resource retrieval, independent result checks
and owned cleanup. These are recorded task-feasibility results, generally one
attempt per cell, not a reliability benchmark or a fresh pass on every later build.

| Model                                | Tested runner           | Result                                                                                          |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------- |
| **Sonnet 5.5** (`claude-sonnet-5-5`) | Claude Code 2.1.318     | Recommended; passing Drive, media, artifacts, pagination and content-selected Gmail/Drive cases |
| **GPT 6.1 Sol** (`gpt-6.1-sol`)      | Isolated Responses loop | Recommended; same coverage plus all six historical Gmail case grades                            |
| Haiku 5.5 (`claude-haiku-5-5`)       | Claude CLI              | Gmail task completed, but failed required method discovery                                      |
| GPT 6.1 Terra (`gpt-6.1-terra`)      | Responses loop          | Gmail task completed, but failed root discovery/skill retrieval                                 |
| GPT 6 Luna (`gpt-6-luna`)            | Responses loop          | Gmail task incomplete at the 18-request limit                                                   |
| Opus 5.5 (`claude-opus-5-5`)         | Reference cell          | Unattempted; no result                                                                          |

Passing coverage for the recommended pair, on each assessment's recorded candidate:

| Assessment                                                        | Sonnet | Sol | Evidence                                                                                                    |
| ----------------------------------------------------------------- | -----: | --: | ----------------------------------------------------------------------------------------------------------- |
| Drive download, pagination, rename, conditional-update limitation |    4/4 | 4/4 | [Drive results](apps/executor/tests/eval/README.md#current-candidate-drive-completion-2026-11-05)           |
| Gmail ↔ Drive media composition                                   |    2/2 | 2/2 | [Media results](apps/executor/tests/eval/README.md#media-composition-results-2026-11-05)                    |
| Large JSON and binary artifacts                                   |    2/2 | 2/2 | [Artifact results](apps/executor/tests/eval/README.md#artifact-agent-acceptance-2026-11-05)                 |
| Bounded pagination helper                                         |    1/1 | 1/1 | [Pagination results](apps/executor/tests/eval/README.md#pagination-helper-feasibility-2026-11-05)           |
| Frozen content-selected Gmail labelling and Drive renaming        |    2/2 | 2/2 | [Unused-case assessment](apps/executor/tests/eval/README.md#first-frozen-unused-case-assessment-2026-11-06) |
| Focused direct hosted Gmail attachment and pagination             |    2/2 | 2/2 | [Hosted Gmail results](apps/executor/tests/eval/README.md#focused-direct-hosted-gmail-results-2026-11-04)   |

The historical six-case Gmail suite had Sonnet **4/6 full grades**, despite 6/6 task
outcomes, and Sol 6/6 across retained runs. Later focused Sonnet passes do not
rewrite those failures. Runner/oracle/discovery failures remain in the
[detailed evaluation history](apps/executor/tests/eval/README.md). Its per-attempt
tables include input/output tokens, cache reads/creation and cost estimates;
missing billing or cache measurements stay unknown. No new model run was needed
to assemble this summary.

Model success is separate from host compatibility. The owner reported a successful
**Claude Sonnet 5.5 native-host 256 KiB upload → Drive → unsent Gmail draft → Drive
→ local download** trial, with matching hashes and complete cleanup
([#25](https://github.com/marcfargas/google-codemode-mcp/issues/25)). It is manual
evidence without a raw audit, exact deployment identity or usage metrics. Responses
loop results do not qualify ChatGPT or native Codex; ChatGPT, OpenClaw and actual
Skills activation remain [acceptance work](https://github.com/marcfargas/google-codemode-mcp/issues/5).

## Connect and use

A compatible client must support **MCP revision `2026-07-28`**, with independent
HTTP POST requests and finite JSON responses. This endpoint has no initialization
handshake, persistent sessions or streaming GET connection.

The hosted gateway endpoint is `https://google-workspace.lachispa.dev/mcp`; it
requires admission and MCP OAuth. The gateway holds durable Google credentials
and injects short-lived tokens into the executor. Standalone deployments instead
require a trusted caller to supply `accessToken`. See
[deployment and connection setup](DEPLOYMENT.md), including the HTTP contract.

Start with `describe({})`, read the returned Workspace skill, then follow service
and method paths before execution. For example, after describing
`gmail/v1/users.messages.list`, Code Mode can run:

```js
const gmail = google.gmail({ version: 'v1' });
const { data } = await gmail.users.messages.list({
  userId: 'me',
  maxResults: 10,
  q: inputs.query,
});
return data;
```

## Recipes and reference

These guides are also served as MCP Resources under
`skill://google-codemode-mcp/google-workspace/`:

- [Workspace skill](apps/executor/skills/google-workspace/SKILL.md): discovery and execution entry point.
- [Gmail](apps/executor/skills/google-workspace/references/gmail.md): search, read and unsent drafts.
- [Drive](apps/executor/skills/google-workspace/references/drive.md): metadata, rename and file access.
- [Gmail ↔ Drive transfers](apps/executor/skills/google-workspace/references/media-transfers.md): stored references, MIME and attachments.
- [Pagination](apps/executor/skills/google-workspace/references/pagination.md): bounded traversal and continuation.
- [Artifacts](apps/executor/skills/google-workspace/references/artifacts.md): large results and direct file upload/download.
- [Execution contract](apps/executor/skills/google-workspace/references/execution.md): native parameters, limits and mutation outcomes.

Transfers and writes are bounded. A lost or unknown mutation outcome requires
reconciliation before another write; there are no automatic mutation retries,
rollback or durable replay. Discover the endpoint's current limits and supported
media modes rather than assuming every Google SDK option is available.

## Develop and deploy

Requires Node 24 and `just`. From the repository root:

```sh
npm ci --ignore-scripts
just dev
```

Local executor URL: `http://localhost:8787/mcp`. `just check` runs the credential-free
GitHub Check workflow with Docker/`act`; `just verify` runs the same checks directly.

- [Deployment](DEPLOYMENT.md): Cloudflare prerequisites, gateway/executor bindings, Access, OAuth, R2 and HTTP examples.
- [Development and verification](apps/executor/tests/README.md): local checks, isolated Google test account and on-demand model evaluations.
- [Evaluation results and metrics](apps/executor/tests/eval/README.md): exact cases, candidates, failures, budgets and token/cache/cost accounting.
- [Hosted verification](apps/executor/tests/hosted/README.md): deployment and runtime evidence with its qualification limits.
