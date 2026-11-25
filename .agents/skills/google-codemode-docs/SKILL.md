---
name: google-codemode-docs
description: Retrieve, author, move or assess Google Code Mode documentation, including the Workspace skill served to agents. Report-only requests stay read-only.
---

# Work with project knowledge

[README.md](../../../README.md) names the homes and what each owns, under
"Recipes and reference" and "Develop and deploy". There is no `docs/`
directory: each guide sits beside the code it describes. Requests and open
acceptance live in issues; use
[google-codemode-capture](../google-codemode-capture/SKILL.md) for those.

## Retrieve and answer

Start from the reference given; otherwise search the homes README lists and the
code they describe. Cite the file and heading. State what no home covers. A
query writes nothing.

Most of the [agent gate guide](../../../apps/executor/tests/eval/README.md) and
the [hosted controls](../../../apps/executor/tests/hosted/README.md) is dated
result sections. A dated section says what was observed on the candidate it
names, not what `main` does today. Give its date and candidate with the answer,
or an old result reads as a current one.

## Author or revise

Search existing coverage first and amend the home that owns the subject; README
stays a summary that links out. Keep the source's scope and qualifications. In
the same change, fix or remove every existing statement the edit contradicts.
Name a new page for its lasting subject, not for the change that produced it.
Use `mafe-si:technical-writing` for composition when available.

- **Dated result sections are history.** A new run gets its own dated section,
  and a README table row changes only to cite it. Do not edit an earlier
  section's grades, counts or failures to agree with a later run: README's
  summaries rely on the failed attempts staying on record, and a rewritten
  section claims a result its candidate never produced.
- **The served Workspace skill exists twice.** The Markdown under
  `apps/executor/skills/google-workspace/` is the browsable copy. The Worker
  serves string constants: `WORKSPACE_SKILL` in `apps/executor/src/protocol.ts`
  and the `*_GUIDE` constants in `apps/executor/src/knowledge.ts`. A unit test
  requires each pair to be identical, so edit both; editing only the Markdown
  changes nothing an agent receives.
- **Editing the served skill is a product change.** Agents act on that text,
  and its entry point and three of its references are hashed into the candidate
  source that agent and hosted results are recorded against. Deliver it as a
  code change and let
  [google-codemode-verify](../google-codemode-verify/SKILL.md) decide whether an
  agent tier is due.
- The developer skills in `.agents/skills/` (linked from `.claude/skills/`) are
  not that served skill; nothing ships them.

## Move or consolidate

Nothing checks links; the check's Prettier step only formats. Headings in the
eval and hosted guides are link targets from README.md, DEPLOYMENT.md, the
test guides and issue bodies, which link to the file on `main`. Before renaming a
heading or moving a file, search the repository for its path and anchor and fix
every hit in the same change. Links from issues break without any signal, so
leave dated headings and guide paths as they are unless the move is the point.
Merge only equivalent content and keep conflicting claims distinct.

## Assess freshness

Compare the claims with current code and configuration and report what is
supported, contradicted or unresolved. Check a dated section against what it
says it observed, not against today's code. A correction needs edit scope. Use
`mafe-si:explain-system` for an explanation that needs research.
