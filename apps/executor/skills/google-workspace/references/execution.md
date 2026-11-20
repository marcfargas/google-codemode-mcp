# Discovery, execution and outcomes

Start with `describe({})`, read the returned Workspace skill URI through MCP
Resources, then follow service/resource paths to each native method. Describe
every method before the execution that calls it, including calls inside loops,
helpers and snippets. A familiar Google method name is not evidence that this
deployment supports its parameters or transport.

Method briefs provide the callable signature, method arguments, supported
runtime modes and limits, exclusions, scope alternatives and Discovery
provenance. A brief describes the method for the required lookup before
execution. Follow the brief's `commonParameters.path` for the shared arguments
it lists and read [shared conventions](skill://google-codemode-mcp/google-workspace/references/conventions.md)
for field masks, pagination, formats and validation.

For a named request or response schema, follow its `schemaPath`. For example,
`describe({path:'drive/v3#File'})` lists fields and their types and links.
`describe({path:'drive/v3#File/properties/modifiedTime'})` returns the original
Discovery metadata for that field. Use `~1` for a slash and `~0` for a tilde in
a field name. A field detail can point to another named schema. Match
service/version and Discovery revision when reusing details on the same
deployment. Resolve them afresh when the revision is missing or changes, or
the deployment's capabilities change.

For the expanded method description with generated TypeScript or the expanded
named schema, call the same path with `view:'full'`. The Discovery source URL
provides the original document. Scope requirements do not grant access.
Available scopes are unknown for an opaque token.

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
