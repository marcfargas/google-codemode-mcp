# GitHub operations

Run from this checkout with authenticated `gh`; establish the destination anew:

```sh
gh repo view marcfargas/google-codemode-mcp --json nameWithOwner,visibility
```

The repository was private when authored; do not assume it stays private. Never
publish OAuth/client material, mailbox content, proxy keys, or private deployment
bindings. References can disclose private names even without quoted content.

## Exact text writes

When `mafe-si:pre-post` is installed, locate its active package and read
`skills/pre-post/SKILL.md` plus `references/operations.md`. Use that package's
`dist/posting-review.mjs`: `digest REQUEST.json`, then `post REQUEST.json REVIEW.json`.
The request includes explicit `transport: "gh"`, `repo:
"github.com/marcfargas/google-codemode-mcp"`, `kind`, `operation`, exact body,
and title/number as required. The review binds the digest and records the actual
purpose, audience, visibility, disclosure, and preserved meaning. Changed payloads
need a new review. The helper transports text; it does not judge your review.

Without the shared plugin, perform and retain that same semantic review immediately
before the exact operation. Write the literal body to an external UTF-8 file, then
use `gh issue create --repo marcfargas/google-codemode-mcp --title TITLE --body-file FILE`
or `gh issue edit NUMBER --repo marcfargas/google-codemode-mcp --body-file FILE`.
For comments use `gh issue comment NUMBER ... --body-file FILE` only when separately
warranted. Avoid shell interpolation of payloads. This fallback has no native
review enforcement; a denial is not permission to bypass the installed gate.
Check current state again before status changes; closing/reopening needs actual
disposition authority, not merely a capture receipt.

For an ambiguous create receipt, search all states by title, source identity, and
distinctive body text, inspect recent records and read back any possible match.
For an edit, fetch the canonical body; for a comment inspect paginated comments.
GitHub issue creation offers no request-id deduplication. Repository + canonical
issue/comment ID is the destination identity; preserve an incoming handoff's full
source project/record/occurrence identity in retained context and appropriate safe
issue references. Do not invent a provider idempotency key. If receipt remains
uncertain, stop that write and report the gap rather than creating another issue.

## Relationships

Read actual native relationships using `gh issue view NUMBER --repo
marcfargas/google-codemode-mcp --json blockedBy,blocking,parent,subIssues` or:

```text
GET /repos/marcfargas/google-codemode-mcp/issues/N/dependencies/blocked_by
GET /repos/marcfargas/google-codemode-mcp/issues/N/dependencies/blocking
GET /repos/marcfargas/google-codemode-mcp/issues/N/sub_issues
```

`gh api` can paginate these reads. For a genuine prerequisite, resolve both records
and the supplier's REST database `id` (`gh api repos/OWNER/REPO/issues/N --jq .id`),
not its number or GraphQL node ID. Native REST add is `POST` to the **consumer's**
`.../dependencies/blocked_by` with integer `issue_id`; remove is `DELETE
.../dependencies/blocked_by/SUPPLIER_ID`. Read back both directions afterward.
GitHub allows up to 50 blocking and 50 blocked-by edges per issue; confirm current
API capabilities/permissions at use. Reads need Issues read; mutations need Issues
write and actual access to both repositories for cross-repository work.

No dependency mutation was exercised during authoring. The installed text posting
dispatcher does not support relationship mutations; inspect available authorized
native operations and review requirements before using an API write. Do not bypass
a tool denial or pretend a prose link is a native edge. Retain a specific capability
gap when unsupported. Missing supplier coverage needs authorized capture in its
owner context, not a shadow supplier issue here. Remove obsolete edges only on a
supported scope change and recheck consuming acceptance after supplier completion.
Subissues express decomposition, not blocking; ordinary explicit issue links suffice
for this project's current umbrella breakdown.
