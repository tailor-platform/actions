---
"tailor-platform-actions": minor
---

`lockfile-audit-fix` now sweeps `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` and `overrides` lists after each run: it collapses overlapping entries `pnpm audit --fix` can leave for the same package (which otherwise makes the following `pnpm install` hard-fail with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`), drops `overrides` entries whose package has left the dependency tree, and drops `minimumReleaseAgeExclude` entries once the version they bypass the gate for is old enough on its own. This runs even when there are no new advisories to fix, so entries left stale by an earlier run (or by pnpm never reconciling an override against a later re-resolved version) get cleaned up on the next scheduled run instead of accumulating indefinitely.
