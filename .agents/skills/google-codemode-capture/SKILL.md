---
name: google-codemode-capture
description: Capture, triage or retrieve Google Code Mode requests and deferred observations in this repository's GitHub issues. Holds the project facts that add to mafe-si:capture; that skill holds the procedure.
---

# Capture project work

These facts add to `mafe-si:capture`, which holds the procedure. Work records are
this repository's GitHub issues; maintained knowledge goes through
[google-codemode-docs](../google-codemode-docs/SKILL.md).

- **Issue #1 is the umbrella.**
  [#1](https://github.com/marcfargas/google-codemode-mcp/issues/1) holds the
  project scope, the owner's requirements, the current priority and the
  acceptance that is still open. Link a new focused issue from #1 and back to
  it. When work is split out of #1, leave the acceptance it still owns in its
  body: a focused issue closing does not close that acceptance, and a reader
  planning from #1 would otherwise take the remaining work as done.
- **Service order is priority, not dependency.** Gmail → Drive → Sheets → Docs →
  Calendar is the order the owner wants the services built. Do not record it as
  blocked-by links between the service issues: no slice needs another one
  finished, and a native edge makes the later issues read as blocked.
