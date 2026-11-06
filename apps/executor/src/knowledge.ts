// Mirrored from the distributable references; protocol tests verify exact bytes.
export const MEDIA_TRANSFERS_GUIDE = `# Compose Gmail and Drive file transfers

Describe every Google method used before execution, including calls in loops and
helpers. Read this resource through MCP Resources. The deployment supports bounded
Drive \`files.create\` multipart uploads; native method names and metadata remain
unchanged. A file or folder ID does not grant access: \`drive.file\` covers files
created by, or explicitly shared/opened with, this OAuth application.

## Stored Drive files without byte values in Code Mode

Inspect \`describe({path:'artifacts'})\` and the native method descriptions. When
\`streaming.enabled:true\`, native Drive media downloads return \`.data\` as a v2
artifact reference (\`uri\`, \`mimeType\`, \`size\`, \`sha256\`, expiry and completeness).
Google HTTP bodies stream directly to/from private storage in the trusted
executor. Pass the reference as a Drive upload body; change names/parents using
native metadata:

\`\`\`js
const drive = google.drive({ version: 'v3' });
const { data: file } = await drive.files.get({ fileId: inputs.fileId, alt: 'media' });
const { data: copy } = await drive.files.create({
  requestBody: { name: inputs.name, parents: [inputs.folderId] },
  media: { mimeType: file.mimeType, body: { artifact: file.uri } },
});
await artifacts.delete(file.uri);
return copy;
\`\`\`

Describe both native methods first. Keep the original MIME type; names are
metadata, never storage keys. References can be reused in later executions until
expiry. Gateway references also require the same verified owner and linked Google
account in later executions. Client uploads can supply a v2 reference through
direct R2 upload and authenticated completion; host downloads use the gateway
links described in the
[artifact reference](skill://google-codemode-mcp/google-workspace/references/artifacts.md).
Those transfers keep bytes outside MCP. Limits are 64 MiB per object, 128 MiB transferred per execution (downloads
and uploads both count), one active transfer, four put attempts, 32 storage
operations and one-hour expiry. The 15-second deadlines still apply through
storage completion. Failed transfers consume reservations; no automatic retry is
provided. These bounds are not measured live/hosted capacity.

Without storage, downloads retain the 128 KiB inline envelope below and reference
uploads are unavailable. Small inline uploads remain supported with storage too.
Gmail attachments remain bounded JSON/base64url; large Gmail decode/MIME streaming
and resumable upload are not implemented. Do not move large files through
\`artifacts.readBytes\`, \`putBytes\`, MCP chunks or a giant Gmail \`raw\` value.

## Gmail attachments to a chosen Drive folder

Gmail \`MessagePart\` supplies the filename and MIME type. Its body either contains
inline \`data\` or an \`attachmentId\` for \`users.messages.attachments.get\`. Walk nested
MIME parts when selecting attachments. Gmail attachment \`data\` is **base64url**;
\`size\` is the decoded byte count, not the encoded string length.

After discovering \`gmail/v1/users.messages.attachments.get\` and
\`drive/v3/files.create\`, this program transfers selected external attachments,
changes their names in JavaScript, and returns metadata instead of bytes:

\`\`\`js
const gmail = google.gmail({ version: 'v1' });
const drive = google.drive({ version: 'v3' });
const uploaded = [];
for (const part of inputs.attachments.filter((part) => part.keep !== false)) {
  const { data: body } = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId: part.messageId,
    id: part.attachmentId,
  });
  const { data: file } = await drive.files.create({
    requestBody: {
      name: part.name.replace(/\\s+/g, '_'),
      parents: [inputs.folderId],
    },
    media: {
      mimeType: part.mimeType,
      body: { encoding: 'base64url', data: body.data, size: body.size },
    },
    fields: 'id,name,mimeType,size,parents',
  });
  uploaded.push(file);
}
return uploaded;
\`\`\`

For inline Gmail parts use their existing \`body.data\` and \`body.size\`; no separate
attachment-get call is needed. Empty multipart container bodies are not files.
Native metadata controls the destination name and parent; no folder wrapper or
host-side intermediate file is required.

## Drive bytes to a Gmail draft

Discover \`drive/v3/files.get\`, the \`composeMime\` snippet descriptor, and
\`gmail/v1/users.drafts.create\`. Without storage, downloaded \`.data\` is a byte envelope with standard
**base64**, decoded \`size\`, \`mimeType\`, and \`sha256\`. It can also be forwarded as a
Drive upload's \`media.body\` unchanged, with its MIME type supplied alongside it.

\`\`\`js
const drive = google.drive({ version: 'v3' });
const gmail = google.gmail({ version: 'v1' });
const { data: file } = await drive.files.get({ fileId: inputs.fileId, alt: 'media' });
const bytes = file.uri ? await artifacts.readBytes(file.uri) : file;
const raw = await snippets.run('composeMime', {
  to: inputs.to,
  subject: inputs.subject,
  text: inputs.text,
  attachments: [{ name: inputs.name, ...bytes }],
});
return (
  await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  })
).data;
\`\`\`

For a Google-native document, describe and use
\`drive.files.export({fileId, mimeType: 'text/plain'})\` instead of blob download;
select an export MIME type supported by that document. This export has the same
application download limit. Google's native export limit is separate.

\`composeMime\` is a pure deployment snippet with no Google calls and no standalone
tool. It returns a complete RFC MIME message encoded as Gmail \`raw\` base64url. The
inner attachment transfer encoding is standard base64 with folded lines, distinct
from the outer message encoding. It checks byte size/hash assertions, protects
headers, and encodes Unicode subjects/filenames. It supports one ASCII mailbox per
address (optional \`from\`), at most eight attachments totalling 131072 decoded
bytes, 65536 UTF-8 text bytes, filenames up to 240 UTF-8 bytes, and a subject up to
512 characters. MIME types must be valid bounded ASCII values. For a send, discover
\`users.messages.send\` and use \`requestBody: {raw}\`; acknowledgement is not recipient
delivery. Drafts let you verify bytes before any send.

## Limits, outcomes and unsupported modes

Uploads accept \`media: {mimeType, body: {encoding, data, size?, sha256?, mimeType?}}\`.
Encoding is \`base64\` or \`base64url\`, with canonical bits and optional valid padding;
whitespace, mixed alphabets and invalid padding are rejected. \`size\` and \`sha256\`
are checked against decoded bytes. A body MIME assertion must match outer MIME.
If metadata includes \`mimeType\`, it must also match the upload MIME type.
Inline limits are 131072 decoded bytes per upload, 1048576 uploaded bytes per execution,
65536 UTF-8 metadata bytes, 2097152 UTF-8 serialized parameter bytes per native call,
and 262144 collected multipart wire bytes. Inline downloads remain 131072 bytes; native
JSON responses remain bounded to 1000000 bytes and execution output to 256000
characters. Return small metadata, not large base64 strings.

Only Drive \`files.create\` multipart blob uploads with a metadata object are
supported. Media-only upload, media on \`files.update\`, Google-native conversion,
Gmail media upload endpoints, resumable upload, arbitrary streams/URLs, Range,
headers and second-argument transport options are refused. Native metadata-only
methods remain available. Only the stored-reference path above raises media size
limits; native JSON limits and inline encodings remain bounded.

A transfer loop is not atomic. Earlier writes may be acknowledged when a later
file fails. Inspect all execution mutation outcomes, even if code catches an
exception. Response parsing, hashing or file delivery failures do not undo an
acknowledged Google write. Reconcile an unknown result before repeating a mutation;
there are no automatic retries, rollback, durable deduplication or resumable Tasks.
Snippet services/scopes are requirements, not grants. Gmail attachment reads need
an appropriate Gmail read grant; drafts need compose/modify and Drive needs
\`drive.file\` or another native accepted alternative. Opaque token scope availability
remains unknown.

## Official knowledge

- [Gmail attachment body](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments)
- [Gmail MIME sending](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Drive folders](https://developers.google.com/workspace/drive/api/guides/folder)
- [Drive download and export](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Drive file-scoped access](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Developer Knowledge MCP](https://developers.google.com/knowledge/mcp)

Use the separate Developer Knowledge MCP for official details and current export
formats. The running deployment's descriptions define its supported transport;
Google's broader capabilities do not override these bounds.
`;

export const ARTIFACTS_GUIDE = `# Store and inspect bounded artifacts

Call \`describe({path:'artifacts'})\` to check whether this deployment enables
artifacts and inspect its current operations and limits. Artifact helpers are
available only to top-level \`execute\` programs, not nested or exposed snippets.
Discover each Google method first and read this reference before storing results.
The trusted caller still supplies the Google token outside the sandbox.

## Native streamed media (v2)

When \`streaming.enabled:true\`, native Drive media downloads automatically store
content and return a v2 reference. Upload with
\`media:{mimeType:file.mimeType,body:{artifact:file.uri}}\` to keep bytes outside
Code Mode; discover the destination method first. See the
[streaming example](skill://google-codemode-mcp/google-workspace/references/media-transfers.md).
\`artifacts.delete(uri)\` removes its data and manifest. \`artifacts.readBytes(uri)\`
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
\`_meta.artifactDownloads\` contains references with \`downloadUrl\` and
\`downloadExpiresAt\`; reading the artifact manifest through MCP Resources can also
return those fields. Keep the original artifact \`uri\` for Code Mode operations.
Do not manufacture a download URL or treat its absence as a failed Google call.

The gateway checks ownership and artifact expiry before signing a GET URL, valid
for at most ten minutes and no later than artifact expiry. The signed URL itself
is a read-only bearer capability: its holder can fetch directly from private R2
without Cloudflare Access headers or an MCP token. Do not send the MCP token to
R2. Request a fresh link through the authenticated gateway after URL expiry.
A valid link does not establish that your host presents a downloadable file.

To upload a host-side file without sending bytes through MCP or Code Mode, use
the gateway's authenticated HTTP endpoints:

1. POST \`/mcp/artifacts/upload\` with JSON
   \`{size,sha256,mimeType,name?}\`. Size is the raw byte length, at most 64 MiB;
   SHA-256 is the lowercase hexadecimal digest of those bytes.
2. PUT the raw bytes to the returned \`uploadUrl\`, using the returned \`method\` and
   \`headers\` exactly. The signature fixes length, MIME type and \`If-None-Match: *\`,
   which refuses replacement. The upload grant expires after ten minutes.
3. POST \`/mcp/artifacts/complete\` with JSON \`{uri}\` using the same authenticated
   gateway identity. The executor reads storage directly, verifies size and hash,
   then commits the owner's complete v2 manifest. Use the returned reference only
   after completion. A lost completion response can be reconciled through the same
   endpoint before the grant expires; this does not replay a Google mutation.

The original bytes move between the client and R2. Completion carries metadata
through the service binding, and Code Mode can subsequently pass the reference to
a discovered Drive upload method. The gateway also accepts POST
\`/mcp/artifacts/download\` with JSON \`{uri}\` to issue a fresh download reference.
These HTTP endpoints are separate from MCP tool calls and require the gateway's
normal authentication and configured admission.

Local two-Worker checks cover ownership, signed-grant shape, completion integrity
and metadata-only transfer. Live R2 signatures, hosted deployment and actual
Claude, ChatGPT or OpenClaw file handling need separate qualification.

## Explicit JSON storage

A native Google response may fit its per-call limit but exceed the final inline
output channel. Select storage explicitly, then return a small reference:

\`\`\`js
const drive = google.drive({ version: 'v3' });
const { data } = await drive.files.list({
  pageSize: 100,
  fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType)',
});
return await artifacts.putJson(data, { name: 'drive-page.json' });
\`\`\`

An acknowledged Google call must complete earlier in the same execution before
any put. This is a storage admission rule, not caller identity or a global quota.
A stored page remains a page: follow native pagination and inspect
\`incompleteSearch\` before making completeness claims. Storage's \`complete:true\`
means the selected bytes were stored completely, not that a search is complete.
There is no automatic spill, truncation, retry or cap increase.

\`putJson(value,{name?})\` stores the exact compact UTF-8 JSON serialization selected
in Code Mode. This is not the original HTTP response formatting. Values must be
strict JSON: plain objects, dense arrays, strings, finite numbers except negative
zero, booleans and null. Cycles, unsupported prototypes, accessors, symbols,
undefined, functions, bigint, sparse arrays and extra array properties are refused
before serialization. Remaining request-token echoes are rejected, not redacted
inside stored bytes. Google's existing dispatcher redaction already applies to
native JSON returned to the program.

## Byte storage and later use

\`putBytes(envelope,{name?})\` accepts a canonical base64/base64url byte envelope
with required MIME type and optional size/SHA-256 assertions. Without streamed storage, Drive download/export envelopes can be passed directly; Gmail attachment bodies need
\`encoding:'base64url'\` and their MIME type. Integrity assertions are checked against
the decoded bytes. A name is display metadata, not a filesystem path.

\`\`\`js
const drive = google.drive({ version: 'v3' });
const { data } = await drive.files.get({ fileId: inputs.fileId, alt: 'media' });
return data.uri ? data : await artifacts.putBytes(data, { name: inputs.name });
\`\`\`

A reference contains \`uri\`, \`kind\`, original \`mimeType\`, optional \`name\`, decoded
\`size\`, whole-byte \`sha256\`, Unix-millisecond \`createdAt\`/\`expiresAt\` and
\`complete:true\`. A later execution can use \`artifacts.readJson(uri)\` or
\`artifacts.readBytes(uri)\` to inspect stored content in JavaScript and return only
a useful selection. Byte reads return a standard base64 envelope. Keep the
capability in inputs when passing it to code. \`await artifacts.delete(uri)\`
explicitly removes the object; do not infer recipient delivery from storage.

## Bounded v1 whole-file download and cross-service transfer

If \`describe({path:'artifacts'})\` reports \`downloads.enabled:true\`, stored references
and manifests also contain a \`downloadUrl\`. The standalone MCP Worker serves that
HTTPS URL directly from private storage; no gateway is needed. GET downloads the
whole original file, and HEAD checks it without returning a body. Both verify size,
expiry and the whole SHA-256 before success. Byte and JSON limits above still apply.
Range requests receive the complete file. There is no HTTP upload or delete route.

The URL is a separate read-only bearer capability. Keep it private; it expires at
the reference's \`expiresAt\`, and deleting the original artifact revokes subsequent
downloads. It cannot authorize MCP reads or deletion. Deployment ingress policies
still apply, so a Cloudflare Access-protected origin requires its normal ingress
credentials. An absent URL means HTTP delivery is disabled or the object predates
this feature; MCP resources and helpers still work. Do not manufacture a URL from
an artifact URI. A download endpoint does not guarantee native host file display.

For a transfer to another Google service, keep the bytes inside Code Mode. In a
later execution, pass the original artifact capability in \`inputs.uri\`:

\`\`\`js
const body = await artifacts.readBytes(inputs.uri);
const drive = google.drive({ version: 'v3' });
return (
  await drive.files.create({
    requestBody: { name: inputs.name },
    media: { mimeType: body.mimeType, body },
    fields: 'id,name',
  })
).data;
\`\`\`

Discover the destination method before execution. Its native mutation outcome
remains separate from artifact reads/deletion. A failed upload does not remove the
source. To attach stored bytes to Gmail, pass the \`readBytes\` envelope to the
\`composeMime\` snippet described in the media-transfer reference, then create a draft.
Neither path requires downloading bytes to the model or fetching the HTTPS URL.

## MCP resources and chunks

For v1, the base URI \`artifact://google-codemode-mcp/v1/<capability>\` reads as a small JSON
manifest with a reference and first-chunk URI. Trusted acknowledged stored
references also appear as MCP resource links. Manifest links have MIME type
\`application/json\`, even when the original object is a PDF or binary file.
The server does not enumerate artifact capabilities. Use resource-link and chunk
URIs for host resource reads; a gateway may prefix these navigation URIs. Keep the
manifest's raw \`uri\` for sandbox \`artifacts.readJson\`, \`readBytes\` and \`delete\`.

Some hosts save blob resources to local files but omit chunk metadata. Start with
\`firstChunkUri\` from the manifest, decode or save each chunk, and advance its
\`/chunk/<offset>/<length>\` suffix by the actual decoded byte count. Preserve any
URI prefix and request \`min(previousLength, size - nextOffset)\` bytes until the
manifest's \`size\` is reached. Reject empty or oversized chunks before completion.
Concatenate in offset order and verify the manifest's \`sha256\` before using the
file. This requires a host with binary file handling; a text preview is insufficient.
An empty artifact has a null first-chunk URI and needs no chunk reads.

Read \`/chunk/<offset>/<length>\` with a raw byte offset and length from 1 to 65536.
Chunks are base64 blobs with MIME \`application/octet-stream\`; metadata identifies
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
`;

export const PAGINATION_GUIDE = `# Collect bounded native pages

Call \`describe({path:'pagination'})\`, describe the selected native method and read
this reference before use. The helper supports Gmail \`users.messages.list\` and
Drive \`files.list\`. Single-page native calls keep their existing behavior.

\`\`\`js
const drive = google.drive({ version: 'v3' });
const result = await pagination.collect(
  drive.files.list,
  {
    q: inputs.query,
    pageSize: 100,
    fields: 'nextPageToken,incompleteSearch,files(id,name)',
  },
  { maxPages: 5, maxBytes: 200000 },
);
return result;
\`\`\`

Both bounds are required: \`maxPages\` is 1–50 and \`maxBytes\` is 1–1000000 UTF-8
bytes, including the serialized result envelope. A budget too small for metadata
is refused before dispatch. Each accepted page is a complete
native \`.data\` object in \`pages\`; the helper does not flatten, deduplicate or
truncate items. The result contains \`pages\`, \`exhausted\`, \`stoppedBy\`,
\`resumePageToken\` and \`incompleteSearch\`.

\`stoppedBy\` is \`end\`, \`maxPages\` or \`maxBytes\`. \`exhausted:true\` means the native
continuation token ended. For Drive, \`incompleteSearch:true\` means Google reports
an incomplete search; \`false\` requires explicit false on every accepted page,
and \`null\` means unknown or not applicable. Neither token exhaustion nor storing
an artifact establishes that a mutable collection was read as a snapshot.

Empty pages with a token continue. Opaque tokens are forwarded unchanged, with a
4096-character bound. Other native parameters are held constant. A caller-supplied
\`pageToken\` resumes a traversal. If \`fields\` is supplied, its top-level selection
must contain \`nextPageToken\` and, for Drive, \`incompleteSearch\`, or \`*\`. A nested
field with the same name is insufficient. The helper refuses an unsafe mask
before calling Google.

When a fetched page cannot fit, it is excluded entirely and \`resumePageToken\`
identifies that page's request, so resumption does not skip its data. A null token
with \`exhausted:false\` means restart at the original first page. Pass a non-null
resume token back as the native \`pageToken\` with the same remaining parameters.
Repeated/malformed response tokens and native errors throw with \`.partial\`, retaining
accepted pages and the failed request's continuation state. There are no retries
or automatic restarts. Inspect partial results before deciding what to do next.

Native response, call, time and execution-output limits remain in force. A result
can exceed the 256000-character inline-output cap even though it fits \`maxBytes\`.
Return a small projection or explicitly use \`artifacts.putJson(result)\` when
storage is enabled. Artifact \`complete:true\` describes stored bytes, independently
of pagination's \`exhausted\` and \`incompleteSearch\` flags. A native response above
its per-call cap cannot be recovered by collecting or storing it.

- [Gmail messages list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Drive files list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
`;
