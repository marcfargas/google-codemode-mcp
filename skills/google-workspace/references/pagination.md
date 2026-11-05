# Collect bounded native pages

Call `describe({path:'pagination'})`, describe the selected native method and read
this reference before use. The helper supports Gmail `users.messages.list` and
Drive `files.list`. Single-page native calls keep their existing behavior.

```js
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
```

Both bounds are required: `maxPages` is 1–50 and `maxBytes` is 1–1000000 UTF-8
bytes, including the serialized result envelope. A budget too small for metadata
is refused before dispatch. Each accepted page is a complete
native `.data` object in `pages`; the helper does not flatten, deduplicate or
truncate items. The result contains `pages`, `exhausted`, `stoppedBy`,
`resumePageToken` and `incompleteSearch`.

`stoppedBy` is `end`, `maxPages` or `maxBytes`. `exhausted:true` means the native
continuation token ended. For Drive, `incompleteSearch:true` means Google reports
an incomplete search; `false` requires explicit false on every accepted page,
and `null` means unknown or not applicable. Neither token exhaustion nor storing
an artifact establishes that a mutable collection was read as a snapshot.

Empty pages with a token continue. Opaque tokens are forwarded unchanged, with a
4096-character bound. Other native parameters are held constant. A caller-supplied
`pageToken` resumes a traversal. If `fields` is supplied, its top-level selection
must contain `nextPageToken` and, for Drive, `incompleteSearch`, or `*`. A nested
field with the same name is insufficient. The helper refuses an unsafe mask
before calling Google.

When a fetched page cannot fit, it is excluded entirely and `resumePageToken`
identifies that page's request, so resumption does not skip its data. A null token
with `exhausted:false` means restart at the original first page. Pass a non-null
resume token back as the native `pageToken` with the same remaining parameters.
Repeated/malformed response tokens and native errors throw with `.partial`, retaining
accepted pages and the failed request's continuation state. There are no retries
or automatic restarts. Inspect partial results before deciding what to do next.

Native response, call, time and execution-output limits remain in force. A result
can exceed the 256000-character inline-output cap even though it fits `maxBytes`.
Return a small projection or explicitly use `artifacts.putJson(result)` when
storage is enabled. Artifact `complete:true` describes stored bytes, independently
of pagination's `exhausted` and `incompleteSearch` flags. A native response above
its per-call cap cannot be recovered by collecting or storing it.

- [Gmail messages list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Drive files list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
