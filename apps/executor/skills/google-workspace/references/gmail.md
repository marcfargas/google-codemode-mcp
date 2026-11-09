# Gmail recipes

Use `google.gmail({version:'v1'})` after root discovery, the Workspace skill read
and descriptions of every method the program will call. These examples illustrate
native shapes; the running method description supplies the supported parameters,
schemas and scope alternatives. See [execution](skill://google-codemode-mcp/google-workspace/references/execution.md)
for the common contract and outcomes.

## Search, then read selected messages

Describe `gmail/v1/users.messages.list` and `gmail/v1/users.messages.get` first:

```js
const gmail = google.gmail({ version: 'v1' });
const { data: page } = await gmail.users.messages.list({
  userId: 'me',
  q: inputs.query,
  maxResults: 10,
});
const messages = [];
for (const message of page?.messages ?? []) {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: message.id,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject'],
  });
  messages.push({ id: data.id, headers: data.payload?.headers ?? [] });
}
return { messages, nextPageToken: page?.nextPageToken };
```

This reads one page. Follow `nextPageToken` unchanged to continue, including when
the current page has no messages. Read [bounded pagination](skill://google-codemode-mcp/google-workspace/references/pagination.md)
before using `pagination.collect`. A bounded partial traversal is not a complete
mailbox search. Use `format:'full'` and inspect nested MIME parts when the task
depends on message bodies rather than headers.

## Create an unsent draft

Describe `gmail/v1/users.drafts.create`. Supply a complete RFC MIME message as
base64url in `inputs.raw`; this does not send it:

```js
const { data: draft } = await google.gmail({ version: 'v1' }).users.drafts.create({
  userId: 'me',
  requestBody: { message: { raw: inputs.raw } },
});
return { draftId: draft.id, messageId: draft.message?.id };
```

Describe `users.drafts.get` before reading the returned draft ID to verify its
recipient, MIME structure and content. Delete only known-owned drafts when a
test or task requires cleanup. Acknowledgement of a send does not prove recipient
delivery; inspect the execution ledger before repeating any mutation.

For attachments, MIME composition and Drive transfers, read
[media transfers](skill://google-codemode-mcp/google-workspace/references/media-transfers.md).
Gmail attachment bodies are JSON/base64url. Stored MIME and attachment helpers
avoid returning those bytes to Code Mode and have their own advertised bounds;
they do not provide unbounded Gmail streaming.

Native empty responses may be `status:204,data:null`. Inspect status/outcomes and
tolerate missing list arrays instead of treating an empty body as a failed write.

- [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail draft creation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create)
