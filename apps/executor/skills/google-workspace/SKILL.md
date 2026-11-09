---
name: google-workspace
description: Discover Google Workspace API methods and run JavaScript through the describe and execute tools. This deployment supports Gmail v1 and Drive v3.
---

# Google Workspace Code Mode

Use `describe` to discover the deployment's available APIs, methods, parameters,
request bodies, response schemas, and snippets. Start with `describe({})`, then
read the returned Workspace skill URI through MCP Resources. Follow the returned
service and resource paths down to each method you need. Describe each method
before calling it in `execute`, including methods familiar from other Google
clients: this deployment's available methods, parameters, schemas and transport
limits come from its Discovery document.

Use `execute` to submit JavaScript. The trusted caller supplies a short-lived
OAuth `accessToken` as a standalone request argument. Through the authentication
gateway, sign in using MCP OAuth and omit this argument: the gateway injects the
current Google grant and rejects caller-supplied credentials or owner context.
Use the tool schema exposed by your endpoint. Never invent or supply a token in code. The program receives `google`, `inputs`,
deployment-provided `snippets`, `pagination`, and optional `artifacts`; it does not receive the token. Keep user data
in `inputs` instead of interpolating it into code.

The following illustrates the native client shape after method discovery. It is
not a substitute for describing `gmail/v1/users.messages.list` and checking its
current parameters and response schema.

```js
const gmail = google.gmail({ version: 'v1' });
const { data } = await gmail.users.messages.list({
  userId: 'me',
  maxResults: 10,
  q: inputs.query,
});
return data;
```

Google method names, parameters, request bodies, and the `.data` response envelope
are preserved. Handle `nextPageToken` explicitly when more results are needed.
For Drive `files.list`, include `nextPageToken,incompleteSearch` in the field mask.
Forward the token unchanged as `pageToken` with the same query. An empty page can still have a token.
If `incompleteSearch` is `true`, do not claim that the search is complete.
Use discovered snippet metadata for its inputs, required services and OAuth
scopes. Some deployment snippets also appear as tools with `inputs` and an optional
correlation `requestId`; standalone calls also require `accessToken`. The gateway
supplies that credential when it hides the argument.

Inspect the execution's mutation outcomes even if the program catches an error.
An uncertain mutation outcome requires reconciliation before repeating the write.
An execution identifier or `requestId` is correlation, not a Google idempotency
key. The service does not automatically retry mutations or durably deduplicate
submissions. Tasks, durable execution, and program replay are deferred.

The endpoint requires MCP revision `2026-07-28`. Each request is an independent
HTTP POST with a finite JSON response. Claude, ChatGPT, and OpenClaw host support
requires a compatible client or gateway; publishing this skill does not establish
that each host supports the revision or the Skills extension.

Invoke a bundled snippet from code with `await snippets.run('gmailInbox', inputs)`.
Read its descriptor with `describe({path: 'snippets'})`. Google scope declarations
are requirements, not grants; available scopes are unknown for an opaque token.

JSON requests and responses include Gmail base64url message bodies and attachments.
For Drive, use `google.drive({version: 'v3'})` and describe its native methods.
Supported media methods declare `runtime.mediaDownload`, `mediaSelection`, and
`maxDownloadBytes`. With R2 enabled, native Drive media downloads return stored
v2 references; `runtime.mediaResult` is `artifact-reference`. Upload them through
`media:{mimeType:file.mimeType,body:{artifact:file.uri}}` and change names/parents
with native metadata, keeping bytes outside Code Mode. Without R2, media `.data`
is `{encoding:'base64',data,size,mimeType,sha256}` with a 131072-byte cap.
Small inline uploads remain supported. Inspect `describe({path:'artifacts'})`
for streaming limits and expiry. With storage, trusted Gmail helpers compose and
retrieve up to 1 MiB of decoded attachments; larger Gmail helpers and resumable
paths remain pending. Native draft media upload accepts stored message/rfc822.
Other upload modes and transport overrides remain unavailable. Before composing
Gmail/Drive transfers, read [media transfers](skill://google-codemode-mcp/google-workspace/references/media-transfers.md)
through MCP Resources for encoding, composeMime, scopes, examples and limits. Google acknowledgement of a send does not establish recipient delivery.

Drive v3 `files.update` has no conditional-update parameter in Discovery revision 20261102. `File.version` is output-only, not a compare-and-swap input. Conditional
headers such as `If-Match` and second-argument SDK options are refused before
dispatch. A read followed by a write does not prevent concurrent lost updates.

For bounded Gmail message or Drive file traversal, inspect
`describe({path:'pagination'})` and read
[bounded pagination](skill://google-codemode-mcp/google-workspace/references/pagination.md)
before using `pagination.collect(nativeMethod,params,{maxPages,maxBytes})`. Native
pages and parameters are preserved. Inspect `exhausted`, `stoppedBy`,
`resumePageToken` and Drive `incompleteSearch`; an empty page may have a token,
and a bounded partial result is not a complete search. Return a small projection
or explicitly store larger results as an artifact.

Artifact storage is optional. Check `describe({path: 'artifacts'})` and read
[artifact storage](skill://google-codemode-mcp/google-workspace/references/artifacts.md)
through MCP Resources before using `artifacts.putJson` or `artifacts.putBytes`.
Explicit storage relieves the inline output channel without raising native limits.
Standalone artifact URIs grant their holder read/delete access until expiry.
Through the gateway, v1 and v2 references also require the verified owner and
Google account that created them; token rotation does not change ownership.
Use returned HTTP download links for host file retrieval. Signed R2 URLs expire
separately and need no Cloudflare Access headers; keep them private. When `clientUpload.enabled` is advertised, use the gateway's `artifact_upload`
MCP tool for upload grants and completion, with local file tooling for direct R2
PUT. Never extract host OAuth credentials or send MCP authorization to signed
transfer URLs. Stored Gmail composition/attachment helpers are described in the
media-transfer resource; inline inspection stays bounded. Helpers are
unavailable inside snippets.
Inspect the separate trusted storage ledger after errors; storage does not undo
Google writes. Physical R2 lifecycle and host file presentation need separate proof.

References:

- [Gmail recipes](skill://google-codemode-mcp/google-workspace/references/gmail.md)
- [Drive recipes](skill://google-codemode-mcp/google-workspace/references/drive.md)
- [Discovery, execution and outcomes](skill://google-codemode-mcp/google-workspace/references/execution.md)
- [Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest)
- [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Drive list and pagination](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Drive update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
- [Google Developer Knowledge MCP](https://developers.google.com/knowledge/mcp)

The separate Developer Knowledge MCP supplies official API guidance and can be
configured in the host. Execution does not depend on that documentation service.
