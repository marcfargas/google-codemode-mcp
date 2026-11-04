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
OAuth `accessToken` as a request argument. When a gateway hides this argument,
omit it: the gateway injects its current caller grant. Never invent or supply a
token in code. The program receives `google`, `inputs`,
and deployment-provided `snippets`; it does not receive the token. Keep user data
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
Use discovered snippet metadata for its inputs, required services and OAuth
scopes. Some deployment snippets also appear as tools; tool arguments contain
`accessToken`, `inputs`, and an optional correlation `requestId`.

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
`maxDownloadBytes`: `files.get` accepts `alt: 'media'`, while `files.export` returns
bytes directly. Media `.data` is `{encoding: 'base64', data, size, mimeType, sha256}`;
`data` contains standard base64. Decode it in the host when saving a file and verify
its byte length/hash. Downloads are limited to 131072 raw bytes. Media uploads,
transport overrides and durable artifacts remain unavailable. Google acknowledgement of a send does not establish recipient delivery.

References:

- [Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest)
- [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Google Developer Knowledge MCP](https://developers.google.com/knowledge/mcp)

The separate Developer Knowledge MCP supplies official API guidance and can be
configured in the host. Execution does not depend on that documentation service.
