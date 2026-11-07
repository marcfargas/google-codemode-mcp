# Store and inspect bounded artifacts

Call `describe({path:'artifacts'})` to check whether this deployment enables
artifacts and inspect its current operations and limits. Artifact helpers are
available only to top-level `execute` programs, not nested or exposed snippets.
Discover each Google method first and read this reference before storing results.
The trusted caller still supplies the Google token outside the sandbox.

## Native streamed media (v2)

When `streaming.enabled:true`, native Drive media downloads automatically store
content and return a v2 reference. Upload with
`media:{mimeType:file.mimeType,body:{artifact:file.uri}}` to keep bytes outside
Code Mode; discover the destination method first. See the
[streaming example](skill://google-codemode-mcp/google-workspace/references/media-transfers.md).
`artifacts.delete(uri)` removes its data and manifest. `artifacts.readBytes(uri)`
permits explicit inspection only up to 131072 bytes; do not hydrate a large file.

V2 manifest resources contain metadata only. There is no v2 chunk endpoint or
executor-generated download URL. The authentication gateway can add direct signed
R2 download links and issue client-upload grants, described below. Standalone v1
URLs/chunks remain available as described in their own section.

V2 limits: 64 MiB per file, 128 MiB transferred per execution, one active transfer,
four put attempts, 32 operations and 3600-second expiry. A round trip counts the
file twice; reads reserve its declared size before streaming, writes count chunks
as received. Failed attempts consume reservations. R2 buffers one 5 MiB part and
admits two writers per isolate. Existing 15-second deadlines still apply, so the
byte cap is not a measured transfer capacity guarantee.

The data commits before a complete manifest becomes readable. Source/storage
failure publishes no completed reference and attempts partial cleanup. Google
acknowledgements and storage outcomes remain separate; never replay a write to
repair storage. Logical expiry does not prove physical deletion.

Standalone references use bearer possession. Through the authentication gateway,
both v1 and v2 references also require the verified caller and linked Google
account that created them. Execution, resource reads and URL issuance check that
owner, independent of Google token rotation. Clients cannot assert an owner
through MCP. Shared bucket access remains an accepted executor-compromise risk;
refresh credentials and URL-signing keys stay in the gateway.

## Gateway client uploads and downloads

When the gateway has private R2 storage and signing credentials, acknowledged
artifact references can also appear as HTTPS MCP resource links. The tool result's
`_meta.artifactDownloads` contains references with `downloadUrl` and
`downloadExpiresAt`; reading the artifact manifest through MCP Resources can also
return those fields. Keep the original artifact `uri` for Code Mode operations.
Do not manufacture a download URL or treat its absence as a failed Google call.

The gateway checks ownership and artifact expiry before signing a GET URL, valid
for at most ten minutes and no later than artifact expiry. The signed URL itself
is a read-only bearer capability: its holder can fetch directly from private R2
without Cloudflare Access headers or an MCP token. Do not send the MCP token to
R2. Request a fresh link through the authenticated gateway after URL expiry.
A valid link does not establish that your host presents a downloadable file.

To upload a local file, inspect `describe({path:'artifacts'})` for
`clientUpload.enabled`. When enabled, use the gateway's `artifact_upload` MCP
tool through the existing authenticated MCP connection:

1. Call `artifact_upload({action:'grant',size,sha256,mimeType,name?})`. Size is
   the raw byte length, at most 64 MiB; SHA-256 is its lowercase hexadecimal hash.
2. Use local file tooling to PUT the bytes directly to `uploadUrl` with the exact
   returned `method` and `headers`. The signature fixes size, MIME type and
   `If-None-Match: *`. Do not attach MCP OAuth or Cloudflare Access headers.
3. Call `artifact_upload({action:'complete',uri})` on the same MCP connection.
   The executor verifies stored size/hash and commits the complete owner-bound
   v2 manifest. Pass that reference to a discovered native Drive upload method.

Never extract OAuth tokens from the host credential store to authenticate a
separate HTTP tool. The file bytes travel directly between the client and R2;
only grant and reference metadata travel through MCP or the service binding.
Signed upload and download URLs are capabilities: keep them private even though
the host needs to see them to perform the transfer.

If a PUT response is lost, complete the retained URI to check whether correct
bytes reached storage; a repeated create-only PUT can return 412. A lost
completion response can be reconciled by repeating `complete` on the same URI
while the ten-minute grant remains valid. After grant expiry, `resources/read`
can recover an already committed manifest until its one-hour expiry; it cannot
finalize staging data. An uncommitted expired upload needs a new grant. Abandoned
staging data waits for lifecycle cleanup. None of this replays a Google mutation.

HTTP clients which already manage gateway authentication can still POST metadata
to `/mcp/artifacts/upload`, `/mcp/artifacts/complete` or
`/mcp/artifacts/download`. These endpoints retain normal authentication and
configured admission; ordinary host HTTP tools do not inherit MCP credentials.

Local two-Worker checks cover ownership, signed-grant shape, completion integrity
and metadata-only transfer. Live R2 signatures, hosted deployment and actual
Claude, ChatGPT or OpenClaw file handling need separate qualification.

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
with required MIME type and optional size/SHA-256 assertions. Without streamed storage, Drive download/export envelopes can be passed directly; Gmail attachment bodies need
`encoding:'base64url'` and their MIME type. Integrity assertions are checked against
the decoded bytes. A name is display metadata, not a filesystem path.

```js
const drive = google.drive({ version: 'v3' });
const { data } = await drive.files.get({ fileId: inputs.fileId, alt: 'media' });
return data.uri ? data : await artifacts.putBytes(data, { name: inputs.name });
```

A reference contains `uri`, `kind`, original `mimeType`, optional `name`, decoded
`size`, whole-byte `sha256`, Unix-millisecond `createdAt`/`expiresAt` and
`complete:true`. A later execution can use `artifacts.readJson(uri)` or
`artifacts.readBytes(uri)` to inspect stored content in JavaScript and return only
a useful selection. Byte reads return a standard base64 envelope. Keep the
capability in inputs when passing it to code. `await artifacts.delete(uri)`
explicitly removes the object; do not infer recipient delivery from storage.

## Bounded v1 whole-file download and cross-service transfer

If `describe({path:'artifacts'})` reports `downloads.enabled:true`, stored references
and manifests also contain a `downloadUrl`. The standalone MCP Worker serves that
HTTPS URL directly from private storage; no gateway is needed. GET downloads the
whole original file, and HEAD checks it without returning a body. Both verify size,
expiry and the whole SHA-256 before success. Byte and JSON limits above still apply.
Range requests receive the complete file. There is no HTTP upload or delete route.

The URL is a separate read-only bearer capability. Keep it private; it expires at
the reference's `expiresAt`, and deleting the original artifact revokes subsequent
downloads. It cannot authorize MCP reads or deletion. Deployment ingress policies
still apply, so a Cloudflare Access-protected origin requires its normal ingress
credentials. An absent URL means HTTP delivery is disabled or the object predates
this feature; MCP resources and helpers still work. Do not manufacture a URL from
an artifact URI. A download endpoint does not guarantee native host file display.

For a transfer to another Google service, keep the bytes inside Code Mode. In a
later execution, pass the original artifact capability in `inputs.uri`:

```js
const body = await artifacts.readBytes(inputs.uri);
const drive = google.drive({ version: 'v3' });
return (
  await drive.files.create({
    requestBody: { name: inputs.name },
    media: { mimeType: body.mimeType, body },
    fields: 'id,name',
  })
).data;
```

Discover the destination method before execution. Its native mutation outcome
remains separate from artifact reads/deletion. A failed upload does not remove the
source. To attach stored bytes to Gmail, pass the `readBytes` envelope to the
`composeMime` snippet described in the media-transfer reference, then create a draft.
Neither path requires downloading bytes to the model or fetching the HTTPS URL.

## MCP resources and chunks

For v1, the base URI `artifact://google-codemode-mcp/v1/<capability>` reads as a small JSON
manifest with a reference and first-chunk URI. Trusted acknowledged stored
references also appear as MCP resource links. Manifest links have MIME type
`application/json`, even when the original object is a PDF or binary file.
The server does not enumerate artifact capabilities. Use resource-link and chunk
URIs for host resource reads; a gateway may prefix these navigation URIs. Keep the
manifest's raw `uri` for sandbox `artifacts.readJson`, `readBytes` and `delete`.

Some hosts save blob resources to local files but omit chunk metadata. Start with
`firstChunkUri` from the manifest, decode or save each chunk, and advance its
`/chunk/<offset>/<length>` suffix by the actual decoded byte count. Preserve any
URI prefix and request `min(previousLength, size - nextOffset)` bytes until the
manifest's `size` is reached. Reject empty or oversized chunks before completion.
Concatenate in offset order and verify the manifest's `sha256` before using the
file. This requires a host with binary file handling; a text preview is insufficient.
An empty artifact has a null first-chunk URI and needs no chunk reads.

Read `/chunk/<offset>/<length>` with a raw byte offset and length from 1 to 65536.
Chunks are base64 blobs with MIME `application/octet-stream`; metadata identifies
the original MIME type, offset, returned and total byte counts, whole-object and
chunk SHA-256, and the next URI when bytes remain. Concatenate decoded bytes,
verify the whole hash, then UTF-8 decode JSON. A chunk can split a UTF-8 character.
A partial chunk is not a complete file. Choose smaller chunks if a host truncates
resource previews. Resource retrieval alone does not establish that Claude,
ChatGPT or OpenClaw offers a downloadable host file.

## Authorization, expiry and limits

In standalone mode, anyone holding the complete random capability URI can read
or delete the object until expiry; sharing deliberately delegates that access.
Gateway access requires both the URI and its verified owner/Google account.
Ownership is independent of Google-token rotation and request IDs. Keep full URIs
and signed URLs private. Wrong-owner, missing and expired references are
unavailable. There is no public bucket URL or capability listing.

Access expires 3600 seconds after storage, checked on every read/delete. Logical
expiry does not physically delete R2 bytes. Operators must configure the private
bucket's physical lifecycle separately; exact hosted retention is unqualified
until verified. Explicit deletion and access expiry are separate mechanisms.

Bounded v1 caps:

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
