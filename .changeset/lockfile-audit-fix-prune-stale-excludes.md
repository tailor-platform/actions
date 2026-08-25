---
"tailor-platform-actions": patch
---

`lockfile-audit-fix` now passes `--config.minimum-release-age-exclude-prune=true` to its verification `pnpm install`, so pnpm itself drops any `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` the freshly-resolved lockfile no longer needs (e.g. a version an earlier fix bypassed the gate for, that a later fix's re-resolution moved away from). Requires pnpm >=11.22.0; a no-op on older pnpm, not an error.
