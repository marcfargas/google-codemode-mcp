---
name: google-codemode-capture
description: Capture, triage, or retrieve Google Code Mode requests and deferred observations in GitHub; choose existing coverage, a separate issue, docs, or no write before drafting.
---

# Capture project work

Use GitHub `marcfargas/google-codemode-mcp` for actionable work. Start with a
supplied issue; [#1](https://github.com/marcfargas/google-codemode-mcp/issues/1)
retains the project outcome and remaining acceptance. Recording work does not
schedule it, select its implementation, or authorize deployment.

## Choose the operation and home

1. Preserve the request, source, uncertainty, authority, and open decisions.
   Distinguish owner requirements from suggestions. For issue work, recover the
   task area through `mafe-si:keep-a-worklog` when available.
2. Read the explicit reference, then search related open **and closed** coverage:

   ```sh
   gh issue view NUMBER --repo marcfargas/google-codemode-mcp --json number,title,body,state,url
   gh issue list --repo marcfargas/google-codemode-mcp --state all --search 'SEARCH TERMS' --limit 100 --json number,title,state,url
   ```

   Search several meaningful terms; inspect matching bodies, relevant comments
   (`gh issue view NUMBER --repo marcfargas/google-codemode-mcp --comments`), and
   linked work. Search is ranked, not a uniqueness guarantee; paginate `gh api`
   when results are truncated. A closed issue can cover the same request or dated
   delivery; closure alone does not establish current consuming acceptance.

3. **Before drafting**, decide: reuse sufficient coverage; materially update a
   current record; create an independently useful outcome/investigation; or make
   no write. Conversation or an existing PR can suffice for bounded work. Honor
   explicit capture requests, retaining remaining work early without requiring a
   settled solution. Do not make a retrospective issue just for a completed check.
4. Select purpose, audience, and home. Work and unsettled acceptance belong in
   issues; maintained product/operator knowledge goes to
   [google-codemode-docs](../google-codemode-docs/SKILL.md). Keep provisional
   designs, raw reviews, recovery detail, and private evidence in the task area,
   not pasted into GitHub. Use `mafe-si:owner-paths` if available; otherwise reuse
   the task's existing external evidence directory. If absent, retained material
   can use `~/.share/agent-work/google-codemode-mcp/<task>/`. A local-only path
   is not evidence that other issue readers can access it.

Local retention and outgoing handoffs are different operations. Gateway work may
involve a sibling owner; Cloudflare provisioning may involve the platform owner.
Retain the likely owner and gap here without guessing a sibling tracker or sending
messages. An authorized outgoing handoff uses `mafe-si:coordinate-projects` when
available for fresh receiving-owner capture. Without it, resolve that owner's
destination and authorized dispatch mechanism before sending. Incoming capture
preserves attributed authority and returns canonical links/disposition in the
invocation only. No automatic pickup queue or scheduler is configured here.

## Compose and publish selected work

Write a self-contained problem/outcome, relevant constraints, bounded acceptance
or next investigation, source links, and unresolved decisions. For a breakdown,
link focused issues from #1 and back to it; preserve the umbrella's active
acceptance. Priority order, related work, parentage, and true blocked-by edges are
different: Gmail → Drive → Sheets → Docs → Calendar is priority, not proof of a
dependency. Read [GitHub operations](references/github.md) for real dependencies,
provider writes, and uncertain receipts.

Use `mafe-si:reporting-for-humans` when available with the chosen readers, purpose,
destination, claims, and qualifications. Otherwise lead with the reader's concrete
problem and next useful action; omit session chronology and private plumbing.

Immediately before **each** create/edit/comment/review, use `mafe-si:pre-post`
when installed and its exact-payload posting dispatcher. Read fresh destination
visibility, compare the complete current/proposed text, and review credentials,
personal content, private sources, URL targets, scope, and acceptance. Read the
linked fallback when the plugin is unavailable; no unchecked direct write follows
from a missing helper. Keep review/draft artifacts outside the checkout.

Read back the full resulting title/body/state/URL and compare meaning and links.
An uncertain write requires canonical reconciliation before any retry. A meaningful
scope/disposition/acceptance change, decision, actionable blocker, next actor, or
contradictory active summary can warrant an edit; routine progress, a handback,
or an unchanged pass alone does not. A comment needs a separate discussion purpose.
Keep closed delivery accounts as dated history, not rewritten current acceptance.

For a **deferred observation**, search and briefly retain its problem, source,
uncertainty, and next check in the selected existing/new record, read back, then
resume the original task. Read-only requests return proposed capture without
writing. At handback use `mafe-si:wrapup-the-worklog` when available; otherwise
checkpoint retained evidence, remaining work, and warranted dispositions without
publishing session memory. Report created/updated/already-covered/no-write plus
canonical links and unresolved gaps; do not equate capture with completion.
