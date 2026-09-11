---
"tailor-platform-actions": patch
---

`lockfile-audit-fix` now also drops `pnpm.overrides`/`pnpm-workspace.yaml overrides:` entries whose target package no longer appears anywhere in the dependency tree. Nothing else ever removes an override once its purpose is gone (e.g. a package that leaves the tree once its own dependent is upgraded away), so without this the list only grew over time, and Renovate kept filing no-op bump PRs against a pin that protected nothing. To pin a package ahead of it actually landing in the tree, add a `# keep-override: <reason>` comment directly above the entry in `pnpm-workspace.yaml` to opt it out of pruning (no equivalent exists for `package.json`'s `pnpm.overrides`, since JSON has no comments).
