---
"tailor-platform-actions": patch
---

`lockfile-audit-fix` now also drops `pnpm.overrides`/`pnpm-workspace.yaml overrides:` entries whose target package no longer appears anywhere in the dependency tree. Nothing else ever removes an override once its purpose is gone (e.g. a package that leaves the tree once its own dependent is upgraded away), so without this the list only grew over time, and Renovate kept filing no-op bump PRs against a pin that protected nothing. To pin a package ahead of it actually landing in the tree, add a `# keep-override: <reason>` comment directly above the entry in `pnpm-workspace.yaml` to opt it out of pruning (no equivalent exists for `package.json`'s `pnpm.overrides`, since JSON has no comments).

It also inserts a `# Renovate security update: <entry>` comment directly above every version-pinned `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entry that doesn't already have one. `pnpm audit --fix`/`pnpm install` write these `minimumReleaseAge`-bypass entries with no comment at all, but some callers run a separate, always-on policy check requiring this marker on every version-pinned entry as a sign that the bypass was added through this automated flow rather than by hand.
