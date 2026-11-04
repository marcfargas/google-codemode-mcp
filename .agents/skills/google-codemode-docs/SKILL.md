---
name: google-codemode-docs
description: Retrieve, author, or assess Google Code Mode documentation; prepare proposed usage before contract changes and reconcile affected claims after verification, keeping report-only requests read-only.
---

# Work with project knowledge

Use these existing homes according to the reader's question:

| Home                                                                                     | Purpose / evidence to inspect                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [README.md](../../../README.md)                                                          | Product contract, discovery/execution examples, deployment, HTTP headers, OAuth and verification setup              |
| [.github/eval/README.md](../../../.github/eval/README.md)                                | Agent gate commands, coverage, caps, model/runner identities, qualified pilot results                               |
| [skills/google-workspace/SKILL.md](../../../skills/google-workspace/SKILL.md)            | Distributed agent instructions served through MCP Resources/Skills; inspect `src/protocol.ts` for serving/integrity |
| [Issue #1](https://github.com/marcfargas/google-codemode-mcp/issues/1) and linked issues | Requested outcomes, open decisions and acceptance; tracker is not proof of deployed behavior                        |

These developer skills in `.agents/skills` are separate from the distributed
Workspace skill. Product behavior comes from current source/configuration and
observed runtime evidence; current code alone cannot establish a historical reason
or a hosted pass. Keep provisional research/reviews in external task material.

## Retrieve and answer

Start with the supplied link/path/section. Otherwise use `rg -n 'TERMS' README.md
.github/eval/README.md skills src .github/workflows justfile wrangler.jsonc` and
read enough surrounding content to preserve limits. Follow useful links and
inspect relevant code/workflow before claiming freshness. Resolve issue references
with `gh issue view NUMBER --repo marcfargas/google-codemode-mcp`; search work via
[google-codemode-capture](../google-codemode-capture/SKILL.md).

Retrieval and report-only assessment issue no content/configuration writes,
formatting fixes, or corrected observation records. Cite the actual file/section
and revision (`git rev-parse HEAD`, noting dirty content), or canonical issue URL.
State inaccessible or missing evidence. Use `mafe-si:explain-system` when available
for a bounded mechanics/history explanation; it does not itself authorize a doc.

## Author, reconcile, and read back

1. Confirm edit scope and search existing coverage before adding a document. Use
   `mafe-si:technical-writing` when available; otherwise write for the selected
   reader, lead with behavior, use concrete runnable examples, and state limits.
2. For delivery affecting user/operator contracts, draft the smallest useful
   usage example/runbook **before dependent implementation**, marked proposed
   until supported. Resolve consequences rather than treating proposed text as
   an implemented contract. Use the delivery procedure when available; this docs
   skill supplies its before/after knowledge operation, not a second delivery.
3. Amend the selected home, retaining unrelated material, source attribution,
   version/date qualifications and unresolved decisions. Keep failed historical
   results as history; new evidence must not retroactively turn them into passes.
   Current required models are Sonnet/Sol; distinguish model feasibility from
   concrete Claude, ChatGPT, or OpenClaw host qualification.
4. After implementation/verification, compare impacted claims against real source,
   configuration, commands and evidence. Remove the proposed qualification only
   for established behavior; retain explicit unverified boundaries. A source-only
   deployment recipe cannot establish hosted Cloudflare behavior. A no-impact
   change needs no forced documentation edit.
5. For moves/consolidation, inspect incoming references first with `rg -n` for
   paths and section names. Retain conflicting qualifications until evidence
   settles them; repair affected Markdown links, anchors, examples, and indexes.
   Check target existence and actual headings; formatting is not a link checker.
6. Format touched Markdown with the pinned `node_modules/.bin/prettier --write
FILE...`; read the resulting files and `git diff --check`. Use
   [google-codemode-verify](../google-codemode-verify/SKILL.md) for meaningful
   affected checks, especially product-skill serving/integrity. Avoid live calls
   for a prose-only check. Read back actual destination text, links, meaning and
   qualifications; report checks and inaccessible relationships.

For freshness assessment, report supported, contradicted and unresolved claims;
read-only scope stays read-only. Correct only authorized, proven drift. Capture
distinct work/decisions with the selected sources through the capture skill; don't
return the same selected docs operation to another router. Tracker edits still
need capture's immediate pre-post review; knowledge retention grants no permission
to execute the recorded work, publish externally, or mark acceptance complete.
