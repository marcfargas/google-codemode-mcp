# Drive recipes

Use `google.drive({version:'v3'})` after root discovery, the Workspace skill read
and descriptions of every method the program will call. Native metadata and
`requestBody` fields are preserved; the running description determines supported
parameters and transport. A file ID is not an access grant: `drive.file` covers
files created by, or explicitly shared/opened with, the OAuth application.

## List metadata

Describe `drive/v3/files.list` before using this one-page query:

```js
const { data } = await google.drive({ version: 'v3' }).files.list({
  q: inputs.query,
  pageSize: 20,
  orderBy: 'name',
  fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,parents)',
});
return data;
```

Include top-level `nextPageToken` and `incompleteSearch` in field masks. Pass each
token unchanged with the same query and ordering; an empty page can still have a
continuation token. `incompleteSearch:true` prevents a complete-search claim.
Read [bounded pagination](skill://google-codemode-mcp/google-workspace/references/pagination.md)
for `pagination.collect` and continuation after a bound is reached.

## Rename a file

Describe `drive/v3/files.update`, then use the native PATCH body:

```js
const { data } = await google.drive({ version: 'v3' }).files.update({
  fileId: inputs.fileId,
  requestBody: { name: inputs.name },
  fields: 'id,name',
});
return data;
```

Describe `files.get` before independent readback when verification is required.
Inspect the trusted mutation ledger after errors: a later parsing or output
failure does not undo an acknowledged rename. See
[execution outcomes](skill://google-codemode-mcp/google-workspace/references/execution.md).

**Atomic conditional updates/CAS are unsupported.** Drive v3 Discovery revision
`20261102` has no conditional-update parameter on `files.update`; `File.version`
is output-only. Invented parameters, `If-Match` headers and second-argument SDK
options are refused before dispatch. A read followed by this rename cannot
prevent concurrent lost updates. If the task requires that protection, leave the
file unchanged and explain the limitation.

## Download, export and transfer files

Describe `files.get` with `alt:'media'` for blob content, or `files.export` with a
supported export MIME type for a Google-native document. With artifact storage,
media downloads return a stored reference. Without storage they return a bounded
base64 envelope; native metadata reads keep their ordinary `.data` shape.

Read [media transfers](skill://google-codemode-mcp/google-workspace/references/media-transfers.md)
for reference uploads, inline limits, Gmail compositions and cleanup, and
[artifact storage](skill://google-codemode-mcp/google-workspace/references/artifacts.md)
for client upload/download URLs and retention. Keep bulk bytes outside MCP and
return selected metadata or an artifact reference.

- [Drive file listing](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Drive file update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
