# google-codemode-mcp

We started this experiment to see whether Code Mode could give AI agents the
best way to work with Google Workspace. We ended the project at the MVP after
Google announced its new Workspace AI Tools Addendum on November 24, 2026.
Google requires AI agents to access Workspace through its own MCP servers or
Workspace CLI, with technical enforcement starting February 1, 2027. The MVP
depended on direct Workspace REST API access through our own MCP server. See
[Google’s announcement][google-announcement] and the [Workspace AI Tools Addendum][google-terms].

The MVP let agents discover native Gmail and Drive methods on demand, compose
calls and filter results in server-side JavaScript, and move attachments between
Gmail and Drive without passing file bytes through the model or MCP. In bounded
evaluations, Sonnet 5.5 and GPT-6.1 Sol completed cross-service file transfers,
paginated searches, and tasks that selected which messages to label or files to
rename based on their contents. See the [evaluation history](apps/executor/tests/eval/README.md).

The source is available under the [Apache License 2.0](LICENSE).

[google-announcement]: https://workspaceupdates.googleblog.com/2026/11/mcp-servers-cli-standardized-usage-tiers-now-available.html
[google-terms]: https://workspace.google.com/terms/ai-tools/

## Which models work?

**Sonnet 5.5 and GPT-6.1 Sol were the MVP’s tested recommendations.** Both passed bounded Gmail/Drive agent evaluations
with method discovery, actual skill-resource retrieval, independent result checks
and owned cleanup. These are recorded task-feasibility results, generally one
attempt per cell, not a reliability benchmark or a fresh pass on every later build.

[Matrix v3](apps/executor/tests/eval/README.md#model-matrix) uses `gpt-6.2-sol`
as the required GPT model and `gpt-6.2-astra` as an optional reference. Both
passed [one live Gmail read/search trial each](apps/executor/tests/eval/README.md#gpt-62-gmail-readsearch-2026-11-20),
including the Workspace skill read and method discovery before execution.

| Model                                | Tested runner           | Result                                                                                          |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------- |
| **Sonnet 5.5** (`claude-sonnet-5-5`) | Claude Code 2.1.318     | Recommended; passing Drive, media, artifacts, pagination and content-selected Gmail/Drive cases |
| **GPT 6.1 Sol** (`gpt-6.1-sol`)      | Isolated Responses loop | Recommended; same coverage plus all six historical Gmail case grades                            |
| Haiku 5.5 (`claude-haiku-5-5`)       | Claude CLI              | Gmail task completed, but failed required method discovery                                      |
| GPT 6.1 Terra (`gpt-6.1-terra`)      | Responses loop          | Gmail task completed, but failed root discovery/skill retrieval                                 |
| GPT 6 Luna (`gpt-6-luna`)            | Responses loop          | Gmail task incomplete at the 18-request limit                                                   |
| Opus 5.5 (`claude-opus-5-5`)         | Reference cell          | Unattempted; no result                                                                          |

Passing coverage for the recommended pair, on each assessment's recorded candidate:

| Assessment                                                        | Sonnet | GPT-6.1 Sol | Evidence                                                                                                    |
| ----------------------------------------------------------------- | -----: | ----------: | ----------------------------------------------------------------------------------------------------------- |
| Drive download, pagination, rename, conditional-update limitation |    4/4 |         4/4 | [Drive results](apps/executor/tests/eval/README.md#current-candidate-drive-completion-2026-11-05)           |
| Gmail ↔ Drive media composition                                   |    2/2 |         2/2 | [Media results](apps/executor/tests/eval/README.md#media-composition-results-2026-11-05)                    |
| Large JSON and binary artifacts                                   |    2/2 |         2/2 | [Artifact results](apps/executor/tests/eval/README.md#artifact-agent-acceptance-2026-11-05)                 |
| Bounded pagination helper                                         |    1/1 |         1/1 | [Pagination results](apps/executor/tests/eval/README.md#pagination-helper-feasibility-2026-11-05)           |
| Frozen content-selected Gmail labelling and Drive renaming        |    2/2 |         2/2 | [Unused-case assessment](apps/executor/tests/eval/README.md#first-frozen-unused-case-assessment-2026-11-06) |
| Focused direct hosted Gmail attachment and pagination             |    2/2 |         2/2 | [Hosted Gmail results](apps/executor/tests/eval/README.md#focused-direct-hosted-gmail-results-2026-11-04)   |

The historical six-case Gmail suite had Sonnet **4/6 full grades**, despite 6/6 task
outcomes, and GPT-6.1 Sol 6/6 across retained runs. Later focused Sonnet passes do not
rewrite those failures. Runner/oracle/discovery failures remain in the
[detailed evaluation history](apps/executor/tests/eval/README.md). Its per-attempt
tables include input/output tokens, cache reads/creation and cost estimates;
missing billing or cache measurements stay unknown.

Model success is separate from host compatibility. The owner reported a successful
**Claude Sonnet 5.5 native-host 256 KiB upload → Drive → unsent Gmail draft → Drive
→ local download** trial, with matching hashes and complete cleanup
([#25](https://github.com/marcfargas/google-codemode-mcp/issues/25)). It is manual
evidence without a raw audit, exact deployment identity or usage metrics. Responses
loop results do not qualify ChatGPT or native Codex. ChatGPT, OpenClaw and actual
Skills activation were still [open acceptance work](https://github.com/marcfargas/google-codemode-mcp/issues/5)
when the experiment ended.

## How the MVP worked

A compatible client needed **MCP revision `2026-07-28`**, with independent
HTTP POST requests and finite JSON responses. The endpoint had no initialization
handshake, persistent sessions or streaming GET connection.

The hosted gateway required admission and MCP OAuth. It held durable Google
credentials and injected short-lived tokens into the executor. Standalone
deployments required a trusted caller to supply `accessToken`. The
[deployment notes](DEPLOYMENT.md) record the setup and HTTP contract.

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

Method paths return a compact brief with callable arguments, runtime limits,
and links to shared arguments and named schemas. Follow `drive/v3#File` for its
field list and `drive/v3#File/properties/modifiedTime` for field details.
Existing consumers of an expanded method or named schema can pass `view: 'full'`
with the same path. This also retrieves generated TypeScript for a method.

## Recipes and reference

These guides are also served as MCP Resources under
`skill://google-codemode-mcp/google-workspace/`:

- [Workspace skill](apps/executor/skills/google-workspace/SKILL.md): discovery and execution entry point.
- [Gmail](apps/executor/skills/google-workspace/references/gmail.md): search, read and unsent drafts.
- [Drive](apps/executor/skills/google-workspace/references/drive.md): metadata, rename and file access.
- [Gmail ↔ Drive transfers](apps/executor/skills/google-workspace/references/media-transfers.md): stored references, MIME and attachments.
- [Pagination](apps/executor/skills/google-workspace/references/pagination.md): bounded traversal and continuation.
- [Artifacts](apps/executor/skills/google-workspace/references/artifacts.md): large results and direct file upload/download.
- [Shared conventions](apps/executor/skills/google-workspace/references/conventions.md): field masks, pagination, value formats and validation.
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
