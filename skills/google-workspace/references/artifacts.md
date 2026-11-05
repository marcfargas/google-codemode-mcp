# Store and inspect bounded artifacts

Call `describe({path:'artifacts'})` to check whether this deployment enables
artifacts and inspect its current operations and limits. Artifact helpers are
available only to top-level `execute` programs, not nested or exposed snippets.
Discover each Google method first and read this reference before storing results.
The trusted caller still supplies the Google token outside the sandbox.

## Explicit JSON storage

A native Google response may fit its per-call limit but exceed the final inline
output channel. Select storage explicitly, then return a small reference:

```js
const drive = google.drive({ version: 'v3' });
const { data } = await drive.files.list({
  pageSize: 100,
  fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType)',
});
return await artifacts.putJson(data, { name: 'drive-page.json' });
```

An acknowledged Google call must complete earlier in the same execution before
any put. This is a storage admission rule, not caller identity or a global quota.
A stored page remains a page: follow native pagination and inspect
`incompleteSearch` before making completeness claims. Storage's `complete:true`
means the selected bytes were stored completely, not that a search is complete.
There is no automatic spill, truncation, retry or cap increase.

`putJson(value,{name?})` stores the exact compact UTF-8 JSON serialization selected
in Code Mode. This is not the original HTTP response formatting. Values must be
strict JSON: plain objects, dense arrays, strings, finite numbers except negative
zero, booleans and null. Cycles, unsupported prototypes, accessors, symbols,
undefined, functions, bigint, sparse arrays and extra array properties are refused
before serialization. Remaining request-token echoes are rejected, not redacted
inside stored bytes. Google's existing dispatcher redaction already applies to
native JSON returned to the program.

## Byte storage and later use

`putBytes(envelope,{name?})` accepts a canonical base64/base64url byte envelope
with required MIME type and optional size/SHA-256 assertions. Drive download and
export envelopes can be passed directly; Gmail attachment bodies need
`encoding:'base64url'` and their MIME type. Integrity assertions are checked against
the decoded bytes. A name is display metadata, not a filesystem path.

```js
const drive = google.drive({ version: 'v3' });
const { data } = await drive.files.get({ fileId: inputs.fileId, alt: 'media' });
return await artifacts.putBytes(data, { name: inputs.name });
```

A reference contains `uri`, `kind`, original `mimeType`, optional `name`, decoded
`size`, whole-byte `sha256`, Unix-millisecond `createdAt`/`expiresAt` and
`complete:true`. A later execution can use `artifacts.readJson(uri)` or
`artifacts.readBytes(uri)` to inspect stored content in JavaScript and return only
a useful selection. Byte reads return a standard base64 envelope. Keep the
capability in inputs when passing it to code. `await artifacts.delete(uri)`
explicitly removes the object; do not infer recipient delivery from storage.

## MCP resources and chunks

The base URI `artifact://google-codemode-mcp/v1/<capability>` reads as a small JSON
manifest with a reference and first-chunk URI. Trusted acknowledged stored
references also appear as MCP resource links. Manifest links have MIME type
`application/json`, even when the original object is a PDF or binary file.
The server does not enumerate artifact capabilities.

Read `/chunk/<offset>/<length>` with a raw byte offset and length from 1 to 65536.
Chunks are base64 blobs with MIME `application/octet-stream`; metadata identifies
the original MIME type, offset, returned and total byte counts, whole-object and
chunk SHA-256, and the next URI when bytes remain. Concatenate decoded bytes,
verify the whole hash, then UTF-8 decode JSON. A chunk can split a UTF-8 character.
A partial chunk is not a complete file. Choose smaller chunks if a host truncates
resource previews. Resource retrieval alone does not establish that Claude,
ChatGPT or OpenClaw offers a downloadable host file.

## Authorization, expiry and limits

Anyone holding the complete random capability URI can read or delete the object
until access expiry. Sharing deliberately delegates this access. It is independent
of Google-token rotation, request IDs and user identity. Keep full URIs private;
a leaked URI authorizes its holder. Wrong, missing and expired capabilities are
unavailable. There is no public bucket URL or capability listing.

Access expires 3600 seconds after storage, checked on every read/delete. Logical
expiry does not physically delete R2 bytes. Operators must configure the private
bucket's physical lifecycle separately; exact hosted retention is unqualified
until verified. Explicit deletion and access expiry are separate mechanisms.

Current caps:

- JSON: 1000000 UTF-8 bytes per object; bytes: 131072 decoded bytes per object.
- Four put attempts and 4000000 attempted stored bytes per execution.
- 32 artifact operations and 4000000 read bytes per execution.
- Resource chunks: at most 65536 raw bytes per request.

Reservations are consumed before awaiting storage and are not refunded after
failed or unknown attempts. Existing native response, download, call, time and
256000-character execution-output limits still apply. A single Google response
above its hard limit cannot be rescued by artifacts. An absent binding refuses
storage without Google or R2 side effects.

## Outcomes and partial failures

Inspect the separate trusted artifact operation ledger and references alongside
Google outcomes, including when the program catches an error. A storage failure
does not undo an acknowledged Google write. Known stored references survive later
program/output errors; program-returned objects cannot forge trusted resource
links. No transaction, deduplication, resumable transfer or replay is provided.

An R2 operation may complete after the execution closes. New operations are fenced;
pending writes retain tentative capabilities with unknown outcomes. Completion-
aware best-effort cleanup may run through the request context, but a returned
unknown receipt does not later become an acknowledged result and rollback is not
guaranteed. Preserve the tentative capability for reconciliation and operator
cleanup. Physical lifecycle is the backstop, not proof of immediate cleanup.

References:

- [MCP Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
