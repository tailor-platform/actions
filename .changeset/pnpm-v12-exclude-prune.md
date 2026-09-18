---
"tailor-platform-actions": patch
---

`lockfile-audit-fix` now enables `minimumReleaseAgeExcludePrune` via a `pnpm-workspace.yaml` setting instead of the `--config.minimum-release-age-exclude-prune=true` CLI flag before running `pnpm install`/`pnpm dedupe`. pnpm's Rust v12 CLI deliberately left this key off the allowlist of `--config.<key>` tokens it re-applies after the yaml/env config layers load (pnpm/pnpm#13930), and the equivalent `PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE_PRUNE` env var is dropped the same way, so the CLI flag silently stopped pruning stale `minimumReleaseAgeExclude` entries under pnpm 12 while still working under pnpm 11. The setting is only injected when the workspace file doesn't already declare it (an explicit `minimumReleaseAgeExcludePrune: false` is left alone) and is stripped back out once install/dedupe finish, so it never appears as an unrequested addition to the caller's own `pnpm-workspace.yaml`.
