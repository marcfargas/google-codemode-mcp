# Discovery, execution and outcomes

Start with `describe({})`, read the returned Workspace skill URI through MCP
Resources, then follow service/resource paths to each native method. Describe
every method before the execution that calls it, including calls inside loops,
helpers and snippets. A familiar Google method name is not evidence that this
deployment supports its parameters or transport.

Method descriptions provide the callable signature, supported parameters,
generated declarations, request/response schemas, scope alternatives, Discovery
source/revision and runtime limits. Inspect the leading runtime/navigation fields
and retrieve the full result if a host shows only a preview. Native schemas are
not silently truncated. Descriptions of excluded authentication/transport
parameters explain their exclusion. Scope requirements do not grant access;
available scopes are unknown for opaque tokens.

## Submit an async JavaScript body

`execute` accepts `code`, immutable `inputs` and optional correlation `requestId`.
The trusted caller injects a short-lived Google `accessToken` for a standalone
executor. Gateway clients authenticate with MCP OAuth and omit that argument.
Never invent a token or put one in code. The program receives `google`, `inputs`,
`snippets`, `pagination` and optional `artifacts`, without the token itself.

Native resource trees, method parameters, `requestBody` and the response
`{data,status,headers}` envelope remain intact. Arbitrary URLs, headers,
callbacks, streams and second-argument SDK transport options are refused.
Sandbox networking is denied. Return small projections; explicit
[artifact storage](skill://google-codemode-mcp/google-workspace/references/artifacts.md)
can retain larger valid results without raising native response limits.

Discover deployment snippets with `describe({path:'snippets'})`, then invoke
`await snippets.run(name, inputs)`. Service/read-only restrictions apply through
nested calls; declared scopes are requirements rather than grants. Snippets are
bundled at deployment, with no runtime installation API.

## Inspect trusted outcomes

Execution results include status/result, bounded logs, `outcomes`,
`outcomesComplete`, `hasUnknownOutcome` and loaded Discovery sources/revisions.
The dispatcher records Google outcomes even when the program catches an error:

| Outcome          | Meaning                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `not_dispatched` | Validation, policy or the dispatch gate prevented the call.                                              |
| `rejected`       | Google returned an authoritative 4xx rejection, excluding 408.                                           |
| `acknowledged`   | Google returned success; later parsing/output failure does not undo it.                                  |
| `unknown`        | A dispatched call lacks an authoritative result, including a timeout, connection loss or server failure. |

Mutations are serialized. An unknown mutation blocks later mutations in the same
execution; reads remain available for reconciliation. No automatic mutation
retry, rollback, durable deduplication or replay is provided. `requestId` is
correlation, not an idempotency key. A lost outer response can lose the in-memory
ledger; repeating the submission may repeat effects. Gmail acknowledgement does
not establish recipient delivery. Inspect separate storage outcomes when
artifacts are involved; storage failure does not reverse a Google write.

Execution completion closes admission and aborts active work. A dispatched write
remains unknown without a successful observed status; queued calls cannot start
afterward. Current defaults are:

| Limit                                         | Bound                              |
| --------------------------------------------- | ---------------------------------- |
| Execution / Google-call asynchronous deadline | 15 seconds each                    |
| Google call attempts                          | 100 per execution                  |
| Native JSON response                          | 1,000,000 bytes per call           |
| Code / serialized inputs                      | 64,000 characters each             |
| Serialized output                             | 256,000 characters                 |
| Logs                                          | 100 entries of 4,096 characters    |
| Nested snippets                               | 16 invocations, depth at most four |

Oversized or non-JSON results fail without erasing recorded outcomes. The
requested dynamic-Worker CPU budget is 1,000 ms; its asynchronous timer cannot
interrupt a synchronous loop. Deployment/runtime enforcement needs its own proof.
Media, pagination and storage have additional advertised limits; consult their
references before use.
