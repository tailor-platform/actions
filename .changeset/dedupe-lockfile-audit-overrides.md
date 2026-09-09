---
"tailor-platform-actions": patch
---

`lockfile-audit-fix` now collapses redundant `pnpm.overrides` entries after `pnpm audit --fix override` runs. Repeated scheduled runs previously left multiple selectors for the same package (e.g. `brace-expansion@<1.1.16`, `brace-expansion@<1.1.17`, `brace-expansion@<1.1.18`) piling up in `pnpm-workspace.yaml`/`package.json` as GHSA advisory ranges and patched versions got revised over time. An entry is now dropped only when another surviving entry for the same package covers a superset version range and pins to the same or a newer version, so no fix coverage is lost.
