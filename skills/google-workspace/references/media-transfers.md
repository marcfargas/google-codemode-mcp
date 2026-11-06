# Compose Gmail and Drive file transfers

Describe every Google method used before execution, including calls in loops and
helpers. Read this resource through MCP Resources. The deployment supports bounded
Drive `files.create` multipart uploads; native method names and metadata remain
unchanged. A file or folder ID does not grant access: `drive.file` covers files
created by, or explicitly shared/opened with, this OAuth application.

## Stored Drive files without byte values in Code Mode

Inspect `describe({path:'artifacts'})` and the native method descriptions. When
`streaming.enabled:true`, native Drive media downloads return `.data` as a v2
artifact reference (`uri`, `mimeType`, `size`, `sha256`, expiry and completeness).
Google HTTP bodies stream directly to/from private storage in the trusted
executor. Pass the reference as a Drive upload body; change names/parents using
native metadata:

```js
const drive = google.drive({ version: 'v3' });
const { data: file } = await drive.files.get({ fileId: inputs.fileId, alt: 'media' });
const { data: copy } = await drive.files.create({
  requestBody: { name: inputs.name, parents: [inputs.folderId] },
  media: { mimeType: file.mimeType, body: { artifact: file.uri } },
});
await artifacts.delete(file.uri);
return copy;
```

Describe both native methods first. Keep the original MIME type; names are
metadata, never storage keys. References can be reused in later executions until
expiry. Limits are 64 MiB per object, 128 MiB transferred per execution (downloads
and uploads both count), one active transfer, four put attempts, 32 storage
operations and one-hour expiry. The 15-second deadlines still apply through
storage completion. Failed transfers consume reservations; no automatic retry is
provided. These bounds are not measured live/hosted capacity.

Without storage, downloads retain the 128 KiB inline envelope below and reference
uploads are unavailable. Small inline uploads remain supported with storage too.
Gmail attachments remain bounded JSON/base64url; large Gmail decode/MIME streaming
and resumable upload are not implemented. Do not move large files through
`artifacts.readBytes`, `putBytes`, MCP chunks or a giant Gmail `raw` value.

## Gmail attachments to a chosen Drive folder

Gmail `MessagePart` supplies the filename and MIME type. Its body either contains
inline `data` or an `attachmentId` for `users.messages.attachments.get`. Walk nested
MIME parts when selecting attachments. Gmail attachment `data` is **base64url**;
`size` is the decoded byte count, not the encoded string length.

After discovering `gmail/v1/users.messages.attachments.get` and
`drive/v3/files.create`, this program transfers selected external attachments,
changes their names in JavaScript, and returns metadata instead of bytes:

```js
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
      name: part.name.replace(/\s+/g, '_'),
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
```

For inline Gmail parts use their existing `body.data` and `body.size`; no separate
attachment-get call is needed. Empty multipart container bodies are not files.
Native metadata controls the destination name and parent; no folder wrapper or
host-side intermediate file is required.

## Drive bytes to a Gmail draft

Discover `drive/v3/files.get`, the `composeMime` snippet descriptor, and
`gmail/v1/users.drafts.create`. Without storage, downloaded `.data` is a byte envelope with standard
**base64**, decoded `size`, `mimeType`, and `sha256`. It can also be forwarded as a
Drive upload's `media.body` unchanged, with its MIME type supplied alongside it.

```js
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
```

For a Google-native document, describe and use
`drive.files.export({fileId, mimeType: 'text/plain'})` instead of blob download;
select an export MIME type supported by that document. This export has the same
application download limit. Google's native export limit is separate.

`composeMime` is a pure deployment snippet with no Google calls and no standalone
tool. It returns a complete RFC MIME message encoded as Gmail `raw` base64url. The
inner attachment transfer encoding is standard base64 with folded lines, distinct
from the outer message encoding. It checks byte size/hash assertions, protects
headers, and encodes Unicode subjects/filenames. It supports one ASCII mailbox per
address (optional `from`), at most eight attachments totalling 131072 decoded
bytes, 65536 UTF-8 text bytes, filenames up to 240 UTF-8 bytes, and a subject up to
512 characters. MIME types must be valid bounded ASCII values. For a send, discover
`users.messages.send` and use `requestBody: {raw}`; acknowledgement is not recipient
delivery. Drafts let you verify bytes before any send.

## Limits, outcomes and unsupported modes

Uploads accept `media: {mimeType, body: {encoding, data, size?, sha256?, mimeType?}}`.
Encoding is `base64` or `base64url`, with canonical bits and optional valid padding;
whitespace, mixed alphabets and invalid padding are rejected. `size` and `sha256`
are checked against decoded bytes. A body MIME assertion must match outer MIME.
If metadata includes `mimeType`, it must also match the upload MIME type.
Inline limits are 131072 decoded bytes per upload, 1048576 uploaded bytes per execution,
65536 UTF-8 metadata bytes, 2097152 UTF-8 serialized parameter bytes per native call,
and 262144 collected multipart wire bytes. Inline downloads remain 131072 bytes; native
JSON responses remain bounded to 1000000 bytes and execution output to 256000
characters. Return small metadata, not large base64 strings.

Only Drive `files.create` multipart blob uploads with a metadata object are
supported. Media-only upload, media on `files.update`, Google-native conversion,
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
`drive.file` or another native accepted alternative. Opaque token scope availability
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
